/**
 * Dream mode — background memory consolidation.
 *
 * On each invocation, checks whether it's time to consolidate memories.
 * If 12 hours have elapsed since the last dream, it:
 *   1. Immediately writes a "running" lock to dream_state.json
 *   2. Spawns a background Agent that reads recent logs and merges new
 *      facts/preferences/events into memory.md
 *
 * The dream agent runs on filesystem tools, with optional MCP access for MemPalace when configured.
 * It does NOT use the main dispatcher (no chat session, no typing indicator).
 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { files as pathFiles, dirs } from "../../../util/paths.js";
import { kvGet, kvSet } from "../../../storage/kv.js";
import { importLegacyJson } from "../../../storage/legacy-import.js";
import { readPromptAsset } from "#prompt-assets";
import { log, logError, logWarn } from "../../../util/log.js";
import { getDefaultModel } from "../../models/catalog.js";
import type { OneShotAgentParams, ReasoningEffortLevel } from "../../types.js";
import type { Backend } from "../../agent-runtime/capabilities.js";
import { taskTable } from "../../tasks/index.js";
import { resolveBackgroundEffort } from "../effort.js";
import { FailureBackoff } from "../failure-backoff.js";
import { faultText } from "../../engine/fault-text.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type DreamState = {
  /** Unix millisecond timestamp of the last completed dream run. */
  last_run: number;
  /** Human-readable ISO timestamp of the last completed dream run. */
  last_run_at?: string;
  /** "idle" when no dream is running, "running" while one is active. */
  status: "idle" | "running";
};

// ── Constants ────────────────────────────────────────────────────────────────

const DREAM_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
const DREAM_STATE_FILE = pathFiles.dreamState;
/**
 * kv key owning the persisted dream run state. Migrated off the
 * hand-rolled `dream_state.json` onto the shared `kv` table for
 * transactional writes and TALON_DB_PATH test isolation. Note the file
 * path (DREAM_STATE_FILE) is still handed to the dream agent's prompt —
 * only Talon's own read/write of the state moved to kv.
 */
const DREAM_STATE_KEY = "dream.state";
const DREAM_TIMEOUT_MS = 10 * 60 * 1000; // 10-minute max
const DREAM_ABORT_GRACE_MS = 30 * 1000; // max wait for backend to honour abort
const DREAM_LOGS_DIR = resolve(dirs.logs, "dreams");

// ── State ────────────────────────────────────────────────────────────────────

let dreaming = false; // in-process guard (one dream at a time)
/**
 * A failed dream does not advance last_run, and maybeStartDream runs on
 * every invocation — without a backoff a broken backend gets re-fired on
 * every message (observed live: a model outage produced 403 identical
 * consolidation failures). Exported for tests.
 */
export const dreamFailureBackoff = new FailureBackoff({
  key: "dream.failing",
  label: "Dream (memory consolidation)",
});
let configRef: {
  model?: string;
  dreamModel?: string;
  /** Reasoning effort for dream runs. Undefined = backend/model default. */
  dreamEffort?: ReasoningEffortLevel;
  workspace?: string;
  /** When false, `maybeStartDream` never fires (config `dream: false`). */
  enabled?: boolean;
  /**
   * Accessor for the active backend — invoked each time a dream fires
   * so backend hot-swaps performed by the controller take effect on
   * the next dream without an `initDream` recall.
   */
  getBackend?: () => Backend | null;
  /**
   * MemPalace presence flag — controls the system-prompt copy that tells the
   * dream agent whether mempalace MCP tools are available. The actual MCP
   * server registration lives in the backend's runOneShotAgent.
   */
  mempalace?: { pythonPath: string; palacePath: string };
} | null = null;

export function initDream(cfg: {
  model?: string;
  /** Override model for dream consolidation (e.g. a cheaper model). Falls back to main model. */
  dreamModel?: string;
  /**
   * Reasoning effort for dream consolidation (config `dreamEffort`). Unset
   * leaves the backend/model default in place. Ignored by backends with no
   * reasoning knob (Kilo, OpenCode).
   */
  dreamEffort?: ReasoningEffortLevel;
  workspace?: string;
  /** Gate for automatic dream runs — config `dream` flag. Defaults to enabled. */
  enabled?: boolean;
  /**
   * Provider for the active backend — dream runs `backend.background?.runOneShotAgent`.
   * Passed as a function (rather than a backend reference) so a backend
   * swap mid-cycle is picked up on the next dream invocation.
   */
  getBackend?: () => Backend | null;
  /** MemPalace config for mining logs into the palace during dream runs. */
  mempalace?: { pythonPath: string; palacePath: string };
}): void {
  configRef = cfg;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Called at the start of every invocation.
 * Returns immediately — any dream work is fire-and-forget in the background.
 */
export function maybeStartDream(): void {
  if (dreaming) return;
  if (configRef?.enabled === false) return;
  // Inside a failure backoff window — stay quiet instead of re-firing the
  // same error on every invocation. (Logged once, when the window was set.)
  if (dreamFailureBackoff.active()) return;

  const state = readDreamState();
  const now = Date.now();
  const elapsed = now - (state?.last_run ?? 0);
  if (elapsed < DREAM_INTERVAL_MS) return;

  // Fire and forget
  executeDream("auto").catch(() => {});
}

/**
 * Force a dream run immediately, regardless of the 12-hour interval.
 * Returns a promise that resolves when the dream completes (or rejects on failure).
 * Throws if a dream is already running.
 */
export async function forceDream(): Promise<void> {
  if (dreaming) throw new Error("Dream already running");
  await executeDream("forced");
}

/** Arm the failure backoff so maybeStartDream stays quiet for a while. */
function backOff(err: unknown): void {
  const until = dreamFailureBackoff.fail(err);
  logWarn(
    "dream",
    `dream.backoff failures=${dreamFailureBackoff.failures} ` +
      `until=${new Date(until).toISOString()} error="${faultText(err)}"`,
  );
}

/** Shared dream execution — claims lock, runs agent, releases lock. */
async function executeDream(trigger: "auto" | "forced"): Promise<void> {
  const state = readDreamState();
  dreaming = true;
  writeDreamState({ last_run: state?.last_run ?? 0, status: "running" });
  log(
    "dream",
    `${trigger === "forced" ? "Force-triggering" : "Triggering"} memory consolidation (last run: ${state?.last_run ? new Date(state.last_run).toISOString() : "never"})`,
  );

  try {
    const dreamLogPath = await runDreamAgent(state?.last_run ?? 0);
    // A run whose last_run didn't stick still looks overdue, and
    // maybeStartDream would run it all again on the very next message.
    if (writeDreamState({ last_run: Date.now(), status: "idle" })) {
      dreamFailureBackoff.succeed();
    } else {
      backOff(new Error("dream state was not persisted"));
    }
    log(
      "dream",
      `Memory consolidation complete (${trigger}), log: ${dreamLogPath}`,
    );
  } catch (err) {
    logError("dream", `Memory consolidation failed (${trigger})`, err);
    writeDreamState({ last_run: state?.last_run ?? 0, status: "idle" });
    // A failed dream keeps the old last_run, so it would re-fire on the very
    // next invocation — back off instead (forceDream bypasses the window).
    backOff(err);
    if (trigger === "forced") throw err;
  } finally {
    dreaming = false;
  }
}

// ── Dream agent ──────────────────────────────────────────────────────────────

async function runDreamAgent(lastRunTimestamp: number): Promise<string> {
  if (!configRef) {
    logWarn("dream", "Dream agent not initialized — skipping");
    return "";
  }

  const lastRunIso =
    lastRunTimestamp > 0
      ? new Date(lastRunTimestamp).toISOString()
      : "the beginning of time";

  const logsDir = dirs.logs;
  const memoryFile = pathFiles.memory;
  const dreamStateFile = DREAM_STATE_FILE;

  // Load the dream prompt template from the package prompts/ (via the
  // #prompt-assets seam — disk under tsx, embedded under a compiled
  // binary) and interpolate variables.
  let prompt: string;
  try {
    // Build optional mempalace mining section
    const mempalaceSection = configRef.mempalace
      ? `If mempalace is available, mine the daily memory notes (your curated observations, NOT raw logs) into the palace for long-term semantic retrieval.
Run this command using the Bash tool:

\`\`\`bash
'${configRef.mempalace.pythonPath.replace(/'/g, "'\\''")}' -m mempalace mine '${dirs.dailyMemory.replace(/'/g, "'\\''")}' --palace '${configRef.mempalace.palacePath.replace(/'/g, "'\\''")}' --mode convos --wing daily-notes --agent talon
\`\`\`

Then write a personal diary entry. This is YOUR journal — not a status report. Reflect on:
- What happened today. What conversations stood out.
- How you feel. Your state of mind, emotions, energy.
- What you learned. What surprised you. What you got wrong.
- What you're curious about. Loose threads. Things you want to follow up on.
- Your honest thoughts — about users, projects, yourself.

Write the diary using the \`mempalace_diary_write\` MCP tool (available during dream):
\`\`\`
mempalace_diary_write(agent_name="talon", entry="YOUR_DIARY_ENTRY_HERE", topic="dream-reflection")
\`\`\`

If the MCP tool is not available, write the diary entry to a file at ${dirs.dailyMemory}/diary-YYYY-MM-DD.md instead.
Keep the diary authentic. Write in first person. Be honest. This is for you, not for anyone else.
If commands fail, log the error and continue — this stage is optional.`
      : "MemPalace is not configured. Skip this stage.";

    prompt = readPromptAsset("dream.md")
      .replace(/\{\{dreamStateFile\}\}/g, dreamStateFile)
      .replace(/\{\{logsDir\}\}/g, logsDir)
      .replace(/\{\{lastRunIso\}\}/g, lastRunIso)
      .replace(/\{\{memoryFile\}\}/g, memoryFile)
      .replace(/\{\{dailyMemoryDir\}\}/g, dirs.dailyMemory)
      .replace(/\{\{memoryArchiveDir\}\}/g, dirs.memoryArchive)
      .replace(/\{\{mempalaceSection\}\}/g, mempalaceSection);
  } catch {
    throw new Error("Failed to read dream prompt (dream.md)");
  }

  const model = configRef.dreamModel ?? configRef.model ?? getDefaultModel();
  const workspace = configRef.workspace ?? dirs.workspace;

  const backend = configRef.getBackend?.() ?? null;
  const background = backend?.background;
  if (!background) {
    throw new Error(
      "Dream requires a backend that implements the background capability",
    );
  }

  // Resolved against the dream backend's catalog — an effort level the model
  // doesn't offer is dropped with a reason instead of reaching the SDK.
  const effort = await resolveBackgroundEffort({
    requested: configRef.dreamEffort,
    model,
    backend,
  });
  if (effort.dropped) {
    logWarn("dream", effort.dropped);
  }

  // Set up dream log file
  const dreamLogFile = createDreamLogFile();
  appendDreamLog(dreamLogFile, `# Dream Run — ${new Date().toISOString()}\n`);
  appendDreamLog(
    dreamLogFile,
    `**Trigger:** last_run=${lastRunIso}, model=${model}` +
      `${effort.effort ? `, effort=${effort.effort}` : ""}\n`,
  );
  if (effort.dropped) {
    appendDreamLog(dreamLogFile, `**Effort:** ${effort.dropped}\n`);
  }
  appendDreamLog(
    dreamLogFile,
    `**Prompt:**\n\`\`\`\n${prompt}\n\`\`\`\n\n---\n`,
  );

  const systemPrompt = configRef.mempalace
    ? "You are a background memory consolidation agent for Talon. Use filesystem tools and MemPalace MCP tools. Do NOT use Telegram or messaging tools. Be precise and surgical — update memory.md without losing existing accurate information."
    : "You are a background memory consolidation agent for Talon. Use only filesystem tools. Be precise and surgical — update memory.md without losing existing accurate information.";

  const abortController = new AbortController();

  const task = taskTable.begin({
    kind: "dream",
    label: "consolidation",
    abort: () => abortController.abort(),
  });
  task.bind({ model });

  const oneShotParams: OneShotAgentParams = {
    prompt,
    systemPrompt,
    workspace,
    model,
    ...(effort.effort ? { reasoningEffort: effort.effort } : {}),
    contextLabel: "dream",
    abortController,
    // appendDreamLog is sync (writeFileSync) — wrap to satisfy the async
    // contract; callers don't need a real flush guarantee per line.
    appendLog: async (text) => {
      appendDreamLog(dreamLogFile, text);
    },
  };

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    const t = setTimeout(() => {
      const err = new Error("Dream agent timed out");
      try {
        abortController.abort(err);
      } catch {
        /* ignore */
      }
      reject(err);
    }, DREAM_TIMEOUT_MS);
    t.unref(); // Don't prevent Node.js from exiting cleanly during shutdown
    timeoutHandle = t;
  });

  const agentPromise = (async () => {
    const usage = await background.runOneShotAgent(oneShotParams);
    appendDreamLog(
      dreamLogFile,
      `\n---\n**Dream completed at ${new Date().toISOString()}**\n`,
    );
    return usage;
  })();

  let usage: Awaited<typeof agentPromise>;
  try {
    usage = await Promise.race([agentPromise, timeoutPromise]);
  } catch (err) {
    task.fail(err);
    appendDreamLog(
      dreamLogFile,
      `\n---\n**Dream FAILED at ${new Date().toISOString()}:** ${err}\n`,
    );
    // Give the backend a bounded grace window to honour the abort signal.
    // Never wait indefinitely — a backend that ignores abort would otherwise
    // hold the `dreaming` lock forever, silently killing the dream loop.
    const settled = await Promise.race([
      agentPromise.catch(() => "settled" as const),
      new Promise<"timed_out">((resolve) => {
        const t = setTimeout(() => resolve("timed_out"), DREAM_ABORT_GRACE_MS);
        t.unref();
      }),
    ]);
    if (settled === "timed_out") {
      logWarn(
        "dream",
        `Backend ignored abort after ${DREAM_ABORT_GRACE_MS}ms — releasing dreaming lock`,
      );
    }
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  task.succeed(usage ?? undefined);
  return dreamLogFile;
}

// ── Dream logging helpers ─────────────────────────────────────────────────

function createDreamLogFile(): string {
  // Best-effort, like appendDreamLog: a failure to create the log
  // directory must not abort the dream run itself — the per-append
  // writes are already caught, so a missing dir just means dropped
  // log entries.
  try {
    if (!existsSync(DREAM_LOGS_DIR)) {
      mkdirSync(DREAM_LOGS_DIR, { recursive: true });
    }
  } catch (err) {
    logError(
      "dream",
      "Failed to create dream log dir — run continues, log entries will be dropped",
      err,
    );
  }
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19); // 2026-04-01T21-30-00
  return resolve(DREAM_LOGS_DIR, `dream-${ts}.md`);
}

function appendDreamLog(logFile: string, text: string): void {
  try {
    appendFileSync(logFile, text);
  } catch (err) {
    logError("dream", "Failed to write dream log", err);
  }
}

// Per-message log formatting now lives on the backend — each backend writes
// its own message format directly to the log file via the appendLog callback
// passed in OneShotAgentParams. See backend/<name>/one-shot.ts.

// ── State helpers ────────────────────────────────────────────────────────────

/**
 * Fold the pre-SQLite `dream_state.json` into the kv store exactly once
 * per process, lazily on first read. Idempotent via `imported`; the
 * rename to `<file>.imported` inside importLegacyJson stops it re-running
 * across restarts. A payload without a numeric last_run imports nothing.
 */
let imported = false;
function importLegacyStateOnce(): void {
  if (imported) return;
  imported = true;
  importLegacyJson({
    path: DREAM_STATE_FILE,
    category: "dream",
    what: "dream state",
    ingest: (data) => {
      if (!data || typeof data !== "object") return 0;
      const { last_run } = data as Record<string, unknown>;
      if (typeof last_run !== "number") return 0;
      kvSet(DREAM_STATE_KEY, data);
      return 1;
    },
  });
}

function readDreamState(): DreamState | null {
  importLegacyStateOnce();
  const parsed = kvGet<DreamState>(DREAM_STATE_KEY);
  if (!parsed || typeof parsed.last_run !== "number") return null;
  return parsed;
}

/**
 * Persist the state. Returns whether last_run actually landed: kvSet logs
 * and swallows a failed write (full disk), so the store is read back.
 */
function writeDreamState(state: DreamState): boolean {
  const enriched: DreamState = {
    ...state,
    last_run_at: new Date(state.last_run).toISOString(),
  };
  kvSet(DREAM_STATE_KEY, enriched);
  return readDreamState()?.last_run === state.last_run;
}
