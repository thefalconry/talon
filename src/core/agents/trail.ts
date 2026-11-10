/**
 * Trail — what a running sub-agent has been doing, kept so a run that is
 * cut short (killed, timed out, stalled, failed) still hands its parent
 * something to work with.
 *
 * Three bounded lists, all best-effort:
 *
 *   - **messages** — its last interim `message_parent` notes.
 *   - **notes** — its last assistant texts (progress narration).
 *   - **files** — paths it wrote or edited, scraped from the run log the
 *     backend writes: Claude-style `**Tool call:** \`Write\`` blocks carrying
 *     a `file_path` / `path` / `notebook_path`, and Codex `**File changes:**`
 *     lists. A backend that logs neither simply contributes no files.
 *
 * The trail also carries the run's `lastActivityAt` clock, which the
 * no-progress watchdog reads: any log line or assistant text counts.
 *
 * Trails live in memory only, keyed by agent id, for the life of the run.
 */

import type { AgentTrail } from "./types.js";

const MAX_MESSAGES = 3;
const MAX_NOTES = 3;
const MAX_FILES = 50;
/** One note or message is clipped to this many characters in the trail. */
const MAX_TEXT_CHARS = 1_500;

/** Tool names (bare or MCP-prefixed) that write files. */
const WRITE_TOOL = /(?:^|__)(?:Write|Edit|MultiEdit|NotebookEdit|write|edit)$/;
const TOOL_CALL_BLOCK =
  /\*\*(?:MCP )?Tool call:\*\* `([^`]+)`\s*```json\n([\s\S]*?)\n```/g;
const PATH_KEY = /"(?:file_path|notebook_path|path)":\s*"((?:[^"\\]|\\.)+)"/;
const FILE_CHANGES_BLOCK = /\*\*File changes:\*\*[^\n]*\n((?:\s+- .*\n?)+)/g;

function clip(text: string): string {
  const t = text.trim();
  return t.length > MAX_TEXT_CHARS ? `${t.slice(0, MAX_TEXT_CHARS)}…` : t;
}

function pushBounded(list: string[], item: string, max: number): void {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

/** File paths a chunk of run-log text says were written or edited. */
export function filesFromLogChunk(chunk: string): string[] {
  const out: string[] = [];
  for (const m of chunk.matchAll(TOOL_CALL_BLOCK)) {
    const tool = m[1] ?? "";
    // MCP calls are logged as `server.tool`; normalise to the `__` form.
    if (!WRITE_TOOL.test(tool.replace(/\./g, "__"))) continue;
    const path = PATH_KEY.exec(m[2] ?? "")?.[1];
    if (path) out.push(JSON.parse(`"${path}"`) as string);
  }
  for (const m of chunk.matchAll(FILE_CHANGES_BLOCK)) {
    for (const line of (m[1] ?? "").split("\n")) {
      const path = /^\s+- \S+ (.+)$/.exec(line)?.[1]?.trim();
      if (path && path !== "?") out.push(path);
    }
  }
  return out;
}

/** The live trail of one run. */
export class RunTrail {
  private readonly messages: string[] = [];
  private readonly notes: string[] = [];
  private readonly files: string[] = [];
  lastActivityAt: number;

  constructor(now: number = Date.now()) {
    this.lastActivityAt = now;
  }

  /** Any sign of life — resets the watchdog. */
  touch(now: number = Date.now()): void {
    this.lastActivityAt = now;
  }

  /** A chunk the backend appended to the run log. */
  onLog(chunk: string): void {
    this.touch();
    for (const file of filesFromLogChunk(chunk)) {
      if (this.files.includes(file)) continue;
      pushBounded(this.files, file, MAX_FILES);
    }
  }

  onAssistantText(text: string): void {
    this.touch();
    const t = clip(text);
    if (t) pushBounded(this.notes, t, MAX_NOTES);
  }

  onMessage(text: string): void {
    this.touch();
    const t = clip(text);
    if (t) pushBounded(this.messages, t, MAX_MESSAGES);
  }

  snapshot(): AgentTrail {
    return {
      messages: [...this.messages],
      notes: [...this.notes],
      files: [...this.files],
    };
  }
}

const trails = new Map<string, RunTrail>();

/** Start (or restart, on resume) the trail for a run. */
export function openTrail(agentId: string): RunTrail {
  const trail = new RunTrail();
  trails.set(agentId, trail);
  return trail;
}

export function getTrail(agentId: string): RunTrail | undefined {
  return trails.get(agentId);
}

export function closeTrail(agentId: string): void {
  trails.delete(agentId);
}

/** Record an interim `message_parent` note against a running agent. */
export function recordInterimMessage(agentId: string, text: string): void {
  trails.get(agentId)?.onMessage(text);
}

/** Whether a trail snapshot has anything worth showing. */
export function trailIsEmpty(trail: AgentTrail | undefined): boolean {
  return (
    !trail ||
    (trail.messages.length === 0 &&
      trail.notes.length === 0 &&
      trail.files.length === 0)
  );
}
