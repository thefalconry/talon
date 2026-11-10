/**
 * The no-progress watchdog's ladder and the run trail's scraping — pure
 * units; the runner wiring is covered in `agents-runner.test.ts`.
 */

import { describe, it, expect, vi } from "vitest";
import { startWatchdog } from "../core/agents/watchdog.js";
import { RunTrail, filesFromLogChunk } from "../core/agents/trail.js";
import { buildSettlementPrompt } from "../core/agents/prompt.js";
import type { AgentRecord } from "../core/agents/types.js";

function ladder(stallMs: number, last: { at: number }) {
  const calls: string[] = [];
  const handle = startWatchdog(
    stallMs,
    {
      lastActivityAt: () => last.at,
      pingAgent: () => calls.push("ping"),
      warnParent: (_idle, killIn) => calls.push(`warn:${killIn}`),
      kill: () => calls.push("kill"),
    },
    60_000,
  );
  return { calls, handle };
}

describe("startWatchdog", () => {
  it("pings at N, warns the parent at 2N, kills at 3N", () => {
    const last = { at: 0 };
    const { calls, handle } = ladder(100, last);
    handle.check(99);
    expect(calls).toEqual([]);
    handle.check(100);
    expect(calls).toEqual(["ping"]);
    handle.check(150);
    expect(calls).toEqual(["ping"]);
    handle.check(220);
    expect(calls).toEqual(["ping", "warn:80"]);
    handle.check(300);
    expect(calls).toEqual(["ping", "warn:80", "kill"]);
    handle.check(1_000);
    expect(calls).toHaveLength(3);
    handle.stop();
  });

  it("starts the ladder over after any sign of life", () => {
    const last = { at: 0 };
    const { calls, handle } = ladder(100, last);
    handle.check(150);
    expect(calls).toEqual(["ping"]);
    last.at = 160;
    handle.check(250);
    expect(calls).toEqual(["ping"]);
    handle.check(260);
    expect(calls).toEqual(["ping", "ping"]);
    handle.stop();
  });

  it("is inert when disabled", () => {
    const kill = vi.fn();
    const handle = startWatchdog(0, {
      lastActivityAt: () => 0,
      pingAgent: kill,
      warnParent: kill,
      kill,
    });
    handle.check(Number.MAX_SAFE_INTEGER);
    expect(kill).not.toHaveBeenCalled();
    handle.stop();
  });
});

describe("RunTrail", () => {
  it("scrapes written and edited files from Claude and Codex log lines", () => {
    const chunk =
      '\n**Tool call:** `Write`\n```json\n{\n  "file_path": "/tmp/a.ts",\n  "content": "x"\n}\n```\n\n' +
      '**Tool call:** `Read`\n```json\n{\n  "file_path": "/tmp/ignored.ts"\n}\n```\n\n' +
      '**Tool call:** `mcp__native-tools__edit`\n```json\n{\n  "path": "~/notes.md"\n}\n```\n';
    const codex =
      "\n**File changes:** (completed)\n  - add src/b.ts\n  - update src/c.ts\n";
    expect(filesFromLogChunk(chunk)).toEqual(["/tmp/a.ts", "~/notes.md"]);
    expect(filesFromLogChunk(codex)).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("keeps the last few notes and messages, de-duplicates files, and tracks activity", () => {
    const trail = new RunTrail(0);
    for (let i = 1; i <= 5; i++) trail.onAssistantText(`note ${i}`);
    trail.onMessage("halfway");
    const write =
      '**Tool call:** `Edit`\n```json\n{\n  "file_path": "/x"\n}\n```';
    trail.onLog(write);
    trail.onLog(write);
    expect(trail.snapshot()).toEqual({
      messages: ["halfway"],
      notes: ["note 3", "note 4", "note 5"],
      files: ["/x"],
    });
    expect(trail.lastActivityAt).toBeGreaterThan(0);
  });
});

describe("settlement prompt trail", () => {
  const base: AgentRecord = {
    id: "agt_1",
    label: "probe",
    brief: "b",
    parent: { kind: "chat", chatId: "1", numericChatId: 1 },
    backendId: "claude",
    state: "killed",
    depth: 0,
    createdAt: 0,
    result: null,
    error: "agent agt_1 killed",
    children: [],
    inboxDepth: 0,
    trail: {
      messages: ["phase 1 done"],
      notes: ["now testing"],
      files: ["/w/a.ts"],
    },
  };

  it("shows what a cut-short run had done", () => {
    const prompt = buildSettlementPrompt(base);
    expect(prompt).toContain("phase 1 done");
    expect(prompt).toContain("now testing");
    expect(prompt).toContain("/w/a.ts");
  });

  it("leaves a finished run's report alone", () => {
    const prompt = buildSettlementPrompt({
      ...base,
      state: "done",
      result: { summary: "all good" },
    });
    expect(prompt).not.toContain("phase 1 done");
  });
});
