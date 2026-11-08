/**
 * Extended branch coverage for src/core/background/triggers.ts.
 *
 * Complements src/__tests__/triggers.test.ts.  Those tests cover the happy
 * paths (bash, cancel, timeout, shutdown, TALON_FIRE).  This file covers the
 * remaining uncovered branches needed to stay above the 60% global threshold:
 *
 *   - python / node language paths in commandForLanguage
 *   - spawnTrigger idempotency guard
 *   - cancelTrigger returning false for an unknown trigger
 *   - resumeAfterRestart: no-deps guard, empty store, matching trigger
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Silence the logger
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../util/watchdog.js", () => ({ recordError: vi.fn() }));
vi.mock("../storage/daily-log.js", () => ({ appendDailyLog: vi.fn() }));

const {
  initTriggers,
  spawnTrigger,
  cancelTrigger,
  getRunningCount,
  resumeAfterRestart,
  shutdownTriggers,
  _internals,
} = await import("../core/background/triggers/index.js");

import type { Trigger } from "../storage/triggers.js";
const {
  addTrigger,
  RESTART_KILL_ERROR,
  SHUTDOWN_KILL_ERROR,
  generateTriggerId,
  getTrigger,
  updateTrigger,
  deleteTrigger,
  getTriggerByName,
  _resetTriggersForTesting,
  DEFAULT_TIMEOUT_SECONDS,
  FIRE_PAYLOAD_MAX_BYTES,
  readTriggerLogTail,
  validateLanguage,
  sanitizeChatId,
  languageExtension,
} = await import("../storage/triggers.js");

let tmpRoot: string;
let executeSpy: ReturnType<typeof vi.fn>;
const hasUsableBash =
  spawnSync("bash", ["-lc", "exit 0"], {
    stdio: "ignore",
    windowsHide: true,
  }).status === 0;
const describeBash = hasUsableBash ? describe : describe.skip;

function makeTrigger(opts: {
  body: string;
  language?: "bash" | "python" | "node";
  ext?: string;
}): Trigger {
  const id = generateTriggerId();
  const language = opts.language ?? "bash";
  const ext =
    opts.ext ??
    (language === "bash" ? "sh" : language === "python" ? "py" : "js");
  const scriptPath = resolve(tmpRoot, `${id}.${ext}`);
  const logPath = resolve(tmpRoot, `${id}.log`);
  writeFileSync(scriptPath, opts.body, { mode: 0o700 });
  const t: Trigger = {
    id,
    chatId: "chat-ext",
    numericChatId: 2,
    name: `t-${id.slice(-6)}`,
    language,
    scriptPath,
    logPath,
    status: "pending",
    createdAt: Date.now(),
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    fireCount: 0,
  };
  addTrigger(t);
  return t;
}

function waitForStatus(
  id: string,
  predicate: (s: string) => boolean,
  timeoutMs = 8000,
): Promise<void> {
  return new Promise((res, rej) => {
    const start = Date.now();
    const tick = () => {
      const t = getTrigger(id);
      if (t && predicate(t.status)) return res();
      if (Date.now() - start > timeoutMs)
        return rej(new Error(`timeout (id=${id} status=${t?.status})`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function waitForExecuteCalls(count: number, timeoutMs = 8000): Promise<void> {
  return new Promise((res, rej) => {
    const start = Date.now();
    const tick = () => {
      if (executeSpy.mock.calls.length >= count) return res();
      if (Date.now() - start > timeoutMs)
        return rej(
          new Error(
            `timeout waiting for ${count} execute call(s), got ${executeSpy.mock.calls.length}`,
          ),
        );
      setTimeout(tick, 25);
    };
    tick();
  });
}

beforeAll(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "talon-trig-ext-"));
  mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  _resetTriggersForTesting();
  executeSpy = vi.fn(async () => ({
    text: "ok",
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    bridgeMessageCount: 0,
  }));
  initTriggers({ execute: executeSpy as never });
});

// Kill any child still in the `children` map at the end of each test
// so a slow-exiting / timed-out python on a CI Windows runner can't
// leak into the next test's getRunningCount() reading. The trigger
// store reset in `beforeEach` only clears stored Trigger records — it
// has no awareness of in-process ChildProcess handles.
afterEach(async () => {
  await shutdownTriggers();
});

// ── Language paths ────────────────────────────────────────────────────────

describe("triggers — alternate languages", () => {
  // Per-test timeouts are 15s instead of the vitest default (5s)
  // because launching a fresh `python` / `node` interpreter on a CI
  // Windows runner regularly burns 3-5 seconds just on process
  // startup before the user script even runs. The 5s default was
  // tight enough to flake repeatedly.
  it("spawns a python trigger and fires on exit 0", async () => {
    const t = makeTrigger({
      body: 'print("py done")\n',
      language: "python",
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "fired", 12_000);
    expect(getTrigger(t.id)!.exitCode).toBe(0);
    const call = executeSpy.mock.calls[0][0];
    expect(call.prompt).toMatch(/Status: fired/);
  }, 15_000);

  it("spawns a node trigger and fires on exit 0", async () => {
    const t = makeTrigger({
      body: 'process.stdout.write("js done\\n"); process.exit(0);\n',
      language: "node",
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "fired", 12_000);
    expect(getTrigger(t.id)!.exitCode).toBe(0);
    const call = executeSpy.mock.calls[0][0];
    expect(call.prompt).toMatch(/Status: fired/);
  }, 15_000);
});

// ── Idempotency ───────────────────────────────────────────────────────────

describeBash("triggers — idempotency", () => {
  it("calling spawnTrigger twice on the same id is a no-op", async () => {
    const t = makeTrigger({ body: 'echo "once"\nexit 0\n' });
    spawnTrigger(t); // first call — spawns
    spawnTrigger(t); // second call — should return early (idempotent guard)
    // Only one child should be tracked
    expect(getRunningCount()).toBeLessThanOrEqual(1);
    await waitForStatus(t.id, (s) => s === "fired");
    // dispatch called exactly once
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});

// ── cancelTrigger false return ────────────────────────────────────────────

describe("triggers — cancelTrigger", () => {
  it("returns false when no child is running for that id", () => {
    expect(cancelTrigger("nonexistent-id-xyz")).toBe(false);
  });
});

// ── resumeAfterRestart ────────────────────────────────────────────────────

describe("triggers — resumeAfterRestart", () => {
  it("is a no-op when called before initTriggers (no deps)", async () => {
    // Temporarily break the deps by resetting
    _resetTriggersForTesting();
    // Don't call initTriggers — deps is now null
    await expect(resumeAfterRestart()).resolves.toBeUndefined();
    expect(executeSpy).not.toHaveBeenCalled();
    // Re-init for subsequent tests
    initTriggers({ execute: executeSpy as never });
  });

  it("is a no-op when the trigger store is empty", async () => {
    await resumeAfterRestart();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("fires a wake-up for a recently-terminated trigger that never fired", async () => {
    const id = generateTriggerId();
    const t: Trigger = {
      id,
      chatId: "chat-resume",
      numericChatId: 3,
      name: "resume-test",
      language: "bash",
      scriptPath: "/tmp/nonexistent.sh",
      logPath: "/tmp/nonexistent.log",
      status: "terminated",
      createdAt: Date.now() - 10_000,
      endedAt: Date.now() - 5_000, // 5 seconds ago — within the 5-min window
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      fireCount: 0,
      lastError: "Killed by Talon shutdown",
      // lastFireAt intentionally omitted (undefined) → matches resume condition
    };
    addTrigger(t);

    await resumeAfterRestart();

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const call = executeSpy.mock.calls[0][0];
    expect(call.chatId).toBe("chat-resume");
    expect(call.prompt).toMatch(/terminated/);
  });

  it("does NOT fire for a trigger that already fired", async () => {
    const id = generateTriggerId();
    const t: Trigger = {
      id,
      chatId: "chat-resume2",
      numericChatId: 4,
      name: "resume-already-fired",
      language: "bash",
      scriptPath: "/tmp/nonexistent2.sh",
      logPath: "/tmp/nonexistent2.log",
      status: "terminated",
      createdAt: Date.now() - 10_000,
      endedAt: Date.now() - 5_000,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      fireCount: 1,
      lastFireAt: Date.now() - 6_000, // has already fired → condition excludes it
    };
    addTrigger(t);

    await resumeAfterRestart();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("fires a death notice for a multi-fire watcher killed by restart", async () => {
    // The regression this pins: a watcher that signalled mid-run
    // (lastFireAt set) and was then killed by a restart was silently
    // dropped — the chat never learned its watcher died. The
    // RESTART_KILL_ERROR marker (stamped by recoverInterrupted)
    // re-qualifies it for the late wake.
    const id = generateTriggerId();
    const t: Trigger = {
      id,
      chatId: "chat-resume3",
      numericChatId: 6,
      name: "resume-multifire",
      language: "bash",
      scriptPath: "/tmp/nonexistent3.sh",
      logPath: "/tmp/nonexistent3.log",
      status: "terminated",
      createdAt: Date.now() - 100_000,
      endedAt: Date.now() - 5_000,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      fireCount: 3,
      lastFireAt: Date.now() - 60_000, // fired mid-run…
      lastError: RESTART_KILL_ERROR, // …then killed by the restart
    };
    addTrigger(t);

    await resumeAfterRestart();

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const call = executeSpy.mock.calls[0][0];
    expect(call.chatId).toBe("chat-resume3");
    expect(call.prompt).toContain(RESTART_KILL_ERROR);
  });

  it("fires a death notice for a multi-fire watcher killed by a clean shutdown", async () => {
    // Clean-shutdown twin of the case above: shutdownTriggers stamps
    // SHUTDOWN_KILL_ERROR and finalizeExit skips the wake because the
    // backend pool is already being torn down. lastFireAt is set from a
    // mid-run signal, so only the marker re-qualifies it for the late wake.
    const id = generateTriggerId();
    const t: Trigger = {
      id,
      chatId: "chat-resume-shutdown",
      numericChatId: 7,
      name: "resume-shutdown-multifire",
      language: "bash",
      scriptPath: "/tmp/nonexistent4.sh",
      logPath: "/tmp/nonexistent4.log",
      status: "terminated",
      createdAt: Date.now() - 100_000,
      endedAt: Date.now() - 5_000,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      fireCount: 2,
      lastFireAt: Date.now() - 60_000,
      lastError: SHUTDOWN_KILL_ERROR,
    };
    addTrigger(t);

    await resumeAfterRestart();

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const call = executeSpy.mock.calls[0][0];
    expect(call.chatId).toBe("chat-resume-shutdown");
    expect(call.prompt).toContain(SHUTDOWN_KILL_ERROR);
  });

  it("does NOT fire for an old terminated trigger (>5 min ago)", async () => {
    const id = generateTriggerId();
    const t: Trigger = {
      id,
      chatId: "chat-old",
      numericChatId: 5,
      name: "resume-old",
      language: "bash",
      scriptPath: "/tmp/old.sh",
      logPath: "/tmp/old.log",
      status: "terminated",
      createdAt: Date.now() - 600_000,
      endedAt: Date.now() - 310_000, // >5 min ago → outside the window
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      fireCount: 0,
    };
    addTrigger(t);

    await resumeAfterRestart();
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

// ── trigger-store branch coverage ────────────────────────────────────────────

describe("trigger-store — branch coverage", () => {
  it("updateTrigger returns undefined for an unknown id", () => {
    expect(
      updateTrigger("does-not-exist", { status: "fired" }),
    ).toBeUndefined();
  });

  it("deleteTrigger returns false for an unknown id", () => {
    expect(deleteTrigger("does-not-exist")).toBe(false);
  });
});

// ── Large payload / buffer truncation ────────────────────────────────────────

describeBash("triggers — large stdout payload truncation", () => {
  it("truncates a payload that exceeds FIRE_PAYLOAD_MAX_BYTES", async () => {
    // Emit a line that is larger than FIRE_PAYLOAD_MAX_BYTES bytes so the
    // bufferAsPayload / trimmed path in fireWake is exercised.
    const bigLine = "x".repeat(FIRE_PAYLOAD_MAX_BYTES + 128);
    const t = makeTrigger({
      body: `echo "${bigLine}"\nexit 0\n`,
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "fired");
    const call = executeSpy.mock.calls[0][0];
    // The prompt should have been truncated to at most FIRE_PAYLOAD_MAX_BYTES
    // characters in the payload section (header + trimmed body)
    expect(call.prompt.length).toBeLessThan(FIRE_PAYLOAD_MAX_BYTES + 512);
  });
});

// ── finalizeExit with pre-terminal status ────────────────────────────────────

describeBash("triggers — finalizeExit status branch", () => {
  it("handles a trigger that had status='cancelled' when it exits", async () => {
    // Spawn, wait until running, cancel — then the child exits.
    // finalizeExit sees status='cancelled' (not 'running') → else branch.
    const t = makeTrigger({ body: "sleep 60\n" });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "running");
    const cancelled = cancelTrigger(t.id);
    expect(cancelled).toBe(true);
    await waitForStatus(t.id, (s) => s === "cancelled");
    // The trigger ended — status should stay cancelled (not be overwritten)
    expect(getTrigger(t.id)!.status).toBe("cancelled");
  });

  it("handles non-zero exit code in the errored path", async () => {
    const t = makeTrigger({
      body: 'echo "fail output"\nexit 3\n',
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "errored");
    expect(getTrigger(t.id)!.exitCode).toBe(3);
    const call = executeSpy.mock.calls[0][0];
    expect(call.prompt).toMatch(/Status: errored/);
    // exit-code header should be in the payload
    expect(call.prompt).toMatch(/exit 3/);
  });
});

// ── readTriggerLogTail error path ─────────────────────────────────────────

describe("trigger-store — readTriggerLogTail", () => {
  it("returns error string when log cannot be read (catch path)", () => {
    // A directory path: existsSync returns true, readFileSync throws EISDIR/EPERM
    const dirPath = mkdtempSync(join(tmpdir(), "trigger-log-err-"));
    try {
      const { tail, truncated } = readTriggerLogTail(dirPath, 20);
      // Covers the catch block at line 329 of triggers.ts
      expect(tail).toMatch(/Failed to read log/);
      expect(truncated).toBe(false);
    } finally {
      rmSync(dirPath, { recursive: true });
    }
  });

  it("returns truncated:true when file has more lines than requested", () => {
    const logFile = resolve(tmpRoot, "truncate-test.log");
    writeFileSync(logFile, "line1\nline2\nline3\nline4\nline5\n");
    const { tail, truncated } = readTriggerLogTail(logFile, 2);
    expect(truncated).toBe(true);
    expect(tail).toContain("line5");
  });
});

// ── fireWakeUp dispatch error ─────────────────────────────────────────────

describeBash("triggers — dispatch error", () => {
  it("logs when execute() rejects but the trigger still reaches terminal state", async () => {
    // Make the dispatch call reject — exercises the catch at line 394 of triggers.ts
    executeSpy.mockRejectedValueOnce(new Error("network failure"));
    const t = makeTrigger({ body: "exit 0\n" });
    spawnTrigger(t);
    // Status is set before the dispatch in finalizeExit; waitForStatus resolves fast
    await waitForStatus(t.id, (s) => s === "fired" || s === "errored");
    await waitForExecuteCalls(1);
    // The trigger is in a terminal state regardless of the dispatch error
    expect(["fired", "errored"]).toContain(getTrigger(t.id)!.status);
    // execute was called once (and rejected)
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Empty output: (no output) path ────────────────────────────────────────

describeBash("triggers — empty stdout", () => {
  it("fires with (no output) label when script produces no stdout", async () => {
    // bufferAsPayload returns "" → trimmed is "" → body uses (no output) branch
    const t = makeTrigger({ body: "exit 0\n" }); // no echo
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "fired");
    const call = executeSpy.mock.calls[0][0];
    expect(call.prompt).toMatch(/\(no output\)/);
  });
});

// ── Mid-run TALON_FIRE: signal ────────────────────────────────────────────

describeBash("triggers — mid-run TALON_FIRE", () => {
  it("fires a non-terminal wake when TALON_FIRE: prefix is emitted", async () => {
    // handleStdoutLine true branch + fireWake terminal=false (header = "signalled")
    const t = makeTrigger({
      body: 'printf "TALON_FIRE: mid-run event\\n"\nexit 0\n',
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "fired");
    await waitForExecuteCalls(2);
    // At least 2 execute calls: mid-run "signalled" + terminal "fired"
    expect(executeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const prompts = executeSpy.mock.calls.map((c) => c[0].prompt as string);
    expect(prompts.some((p) => p.includes("signalled"))).toBe(true);
  });

  it("mid-run prompt says 'Status: signalled', NOT 'Status: fired'", async () => {
    // Regression for Copilot review on PR #96: previously the prompt's
    // "Status:" line said "fired" even for mid-run (non-terminal) signals,
    // which could mislead downstream handling into treating an in-flight
    // watcher as a completed run. The terminal "fired" exit still says
    // "Status: fired" — only the mid-run case is decoupled.
    const t = makeTrigger({
      body: 'printf "TALON_FIRE: still alive\\n"\nsleep 30\n',
    });
    spawnTrigger(t);
    // Wait for the mid-run fire to dispatch (it happens before the script exits)
    await waitForStatus(t.id, (s) => s === "running");
    await waitForExecuteCalls(1);
    expect(executeSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const midPrompt = executeSpy.mock.calls[0][0].prompt as string;
    expect(midPrompt).toMatch(/Status: signalled/);
    expect(midPrompt).not.toMatch(/Status: fired/);
    // Header should also use "signalled" (this was already true, doc the invariant)
    expect(midPrompt).toMatch(/signalled\]/);
    // Cancel so we don't wait for the 30s sleep
    cancelTrigger(t.id);
    await waitForStatus(t.id, (s) => s === "cancelled");
  });

  it("byte-correct truncates a payload at FIRE_PAYLOAD_MAX_BYTES boundary", async () => {
    // Regression for Copilot review on PR #96: previously the cap used
    // String.prototype.slice (UTF-16 code units), so a payload of N multi-byte
    // characters could exceed the byte cap and split a character mid-codepoint.
    // Now: encode in UTF-8 and slice on a codepoint boundary.
    //
    // "💧" is U+1F4A7, encoded as 4 UTF-8 bytes (\xF0\x9F\x92\xA7) but counts
    // as 2 UTF-16 code units in a JS string. A line of 2000 of these is
    // 8000 bytes (above the 4096 cap) but 4000 string length (below the cap
    // under the old code-unit slicer).
    const dropletLine = "💧".repeat(2000);
    const t = makeTrigger({
      body: `printf '%s\\n' "${dropletLine}"\nexit 0\n`,
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "fired");
    const call = executeSpy.mock.calls[0][0];
    const prompt = call.prompt as string;
    // Locate just the trimmed payload section (after the header line).
    // We assert that the BYTE length of the prompt body stays bounded.
    // 512 byte slack for the header + system prefix is generous.
    const promptBytes = Buffer.byteLength(prompt, "utf-8");
    expect(promptBytes).toBeLessThan(FIRE_PAYLOAD_MAX_BYTES + 1024);
    // And critically: there must be no Unicode replacement character (�)
    // anywhere in the payload, which would indicate we split a multi-byte
    // sequence mid-codepoint when decoding back.
    expect(prompt).not.toContain("�");
  });
});

// ── trigger-store validation helpers ─────────────────────────────────────

describe("trigger-store — validation branches", () => {
  it("validateLanguage returns false for an unsupported string", () => {
    // includes() false branch
    expect(validateLanguage("ruby")).toBe(false);
  });

  it("validateLanguage returns false for a non-string value", () => {
    // typeof !== 'string' short-circuit branch
    expect(validateLanguage(42)).toBe(false);
    expect(validateLanguage(null)).toBe(false);
  });

  it("sanitizeChatId replaces non-alphanumeric characters", () => {
    // replace() call — confirms the regex path
    expect(sanitizeChatId("chat@room!")).toBe("chat_room_");
    expect(sanitizeChatId("valid-chat_123")).toBe("valid-chat_123");
  });

  it("languageExtension maps all three languages", () => {
    // explicit switch arm coverage for the languageExtension function
    expect(languageExtension("bash")).toBe("sh");
    expect(languageExtension("python")).toBe("py");
    expect(languageExtension("node")).toBe("js");
  });

  it("getTriggerByName returns undefined when no match exists", () => {
    // find() returns undefined path
    expect(getTriggerByName("no-such-chat", "no-such-name")).toBeUndefined();
  });
});

// ── fireWake with undefined payload (payload ?? "" false arm) ─────────────

describe("triggers — fireWake with undefined payload", () => {
  it("uses (no output) when trigger lastError is undefined (payload ?? '' covers false arm)", async () => {
    // lastError is absent → resumeAfterRestart passes undefined to fireWake → payload ?? "" = ""
    // → trimmed = "" → body becomes "(no output)"
    const id = generateTriggerId();
    const t: Trigger = {
      id,
      chatId: "chat-no-lastError",
      numericChatId: 9,
      name: "no-err-trig",
      language: "bash",
      scriptPath: "/tmp/no-err.sh",
      logPath: "/tmp/no-err.log",
      status: "terminated",
      createdAt: Date.now() - 10_000,
      endedAt: Date.now() - 5_000,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      fireCount: 0,
      // lastFireAt intentionally absent → satisfies resumeAfterRestart condition
      // lastError intentionally absent → payload is undefined in fireWake
    };
    addTrigger(t);
    await resumeAfterRestart();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const call = executeSpy.mock.calls[0][0];
    // With undefined payload, trimmed = "" → body includes "(no output)"
    expect(call.prompt).toMatch(/\(no output\)/);
  });
});

// ── fireCount ?? 0 false arm ──────────────────────────────────────────────

describe("triggers — fireCount undefined (fireCount ?? 0 false arm)", () => {
  it("treats undefined fireCount as 0 when incrementing", async () => {
    // Set fireCount to undefined at runtime (TypeScript type says number, but JS allows undefined)
    const id = generateTriggerId();
    const t: Trigger = {
      id,
      chatId: "chat-fc-undef",
      numericChatId: 10,
      name: "fc-undef-trig",
      language: "bash",
      scriptPath: "/tmp/fc-undef.sh",
      logPath: "/tmp/fc-undef.log",
      status: "terminated",
      createdAt: Date.now() - 10_000,
      endedAt: Date.now() - 5_000,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      fireCount: undefined as unknown as number, // runtime undefined → covers ?? 0 right arm
      // lastFireAt absent → satisfies resumeAfterRestart condition
    };
    addTrigger(t);
    await resumeAfterRestart();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    // fireCount ?? 0 → 0, then +1 = 1
    expect(getTrigger(id)!.fireCount).toBe(1);
  });
});

// ── finalizeExit without prior spawn (Branches 16 + 17) ──────────────────

describe("triggers — finalizeExit without prior spawn", () => {
  it("handles absent logStream and lineBuffer (stream if-false + lineBuffers ?? [] false arm)", async () => {
    // Add trigger to store but do NOT call spawnTrigger — so logStreams and lineBuffers have no entry.
    // Directly invoking _internals.finalizeExit exercises the else/false arms:
    //   Branch 16: if (stream) → false (stream is undefined)
    //   Branch 17: lineBuffers.get(id) ?? [] → false arm (returns [] fallback)
    const id = generateTriggerId();
    const t: Trigger = {
      id,
      chatId: "chat-nospawn",
      numericChatId: 11,
      name: "no-spawn-ext",
      language: "bash",
      scriptPath: "/tmp/nospawn-ext.sh",
      logPath: "/tmp/nospawn-ext.log",
      status: "running", // running + code=0 → "fired"
      createdAt: Date.now(),
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      fireCount: 0,
    };
    addTrigger(t);
    // Directly call finalizeExit — no logStream, no lineBuffer, no child, no timeout
    await _internals.finalizeExit(id, 0, null);
    expect(getTrigger(id)!.status).toBe("fired");
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Timeout timer fires after child already exited (if(!c) true arm) ──────

describe("triggers — timeout timer fires after child has already exited", () => {
  it("if(!c) return true arm — child gone before timer fires", () => {
    const base = makeTrigger({ body: "exit 0\n" });
    const strayTimer = setTimeout(() => undefined, 60_000);
    strayTimer.unref();

    updateTrigger(base.id, { status: "running", timeoutSeconds: 0 });
    const t = getTrigger(base.id)!;
    _internals.timeouts.set(t.id, strayTimer);

    _internals.handleTimeout(t);

    clearTimeout(strayTimer);
    expect(_internals.timeouts.has(t.id)).toBe(false);
    expect(getTrigger(t.id)!.status).toBe("running");
    expect(getTrigger(t.id)!.lastError).toBeUndefined();
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

// ── Child process emits 'error' event (line 152 handler) ─────────────────

describeBash("triggers — child process error event", () => {
  it("logs but does not crash when child emits an error event", async () => {
    // Spawn a long-running script so the child stays alive long enough to emit error.
    const t = makeTrigger({ body: "sleep 10\n" });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "running");
    // Grab the child process from _internals.children and emit an error.
    const child = _internals.children.get(t.id);
    expect(child).toBeDefined();
    // Emit error — exercises the child.on("error", ...) handler at line 152.
    child!.emit("error", new Error("simulated child io error"));
    // Trigger should still be running (error event is logged, not fatal)
    expect(getTrigger(t.id)!.status).toBe("running");
    // Cancel to clean up
    cancelTrigger(t.id);
    await waitForStatus(t.id, (s) => s === "cancelled");
  }, 8000);
});

// ── pushBufferLine: buf not found (Branch 9 true arm) ────────────────────

describe("triggers — pushBufferLine with no buffer entry", () => {
  it("handleStdoutLine silently returns when no lineBuffer exists for the id", () => {
    // Calling handleStdoutLine with a non-existent triggerId exercises the
    // `if (!buf) return` early-return branch in pushBufferLine (line 212).
    expect(() =>
      _internals.handleStdoutLine("nonexistent-trigger-id", "some line"),
    ).not.toThrow();
  });
});

// ── shutdownTriggers: no children (Branch 12 true arm) ───────────────────

describe("triggers — shutdownTriggers with no children", () => {
  it("shutdownTriggers returns immediately when no children are running", async () => {
    // children.size === 0 → if (children.size === 0) return; (true arm, line 233)
    await expect(shutdownTriggers()).resolves.toBeUndefined();
  });
});

// ── finalizeExit with null exit code (code ?? undefined false arm) ────────

describe("triggers — finalizeExit with null exit code", () => {
  it("handles null exit code (SIGTERM kill) — exercises code ?? undefined false arm", async () => {
    // When a running trigger is killed by signal, `code` is null.
    // finalizeExit(id, null, "SIGTERM") → code !== 0 → status="errored"
    // → bufferAsPayload(buffered, null ?? undefined) → the ?? false arm (null → undefined).
    const id = generateTriggerId();
    const t: Trigger = {
      id,
      chatId: "chat-nullexit",
      numericChatId: 12,
      name: "null-exit-trig",
      language: "bash",
      scriptPath: "/tmp/null-exit.sh",
      logPath: "/tmp/null-exit.log",
      status: "running",
      createdAt: Date.now(),
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      fireCount: 0,
    };
    addTrigger(t);
    // null code = killed by signal → errored
    await _internals.finalizeExit(id, null, "SIGTERM");
    expect(getTrigger(id)!.status).toBe("errored");
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});

// ── operator alert for broken triggers ────────────────────────────────────

describe("triggers — trigger.<id> alert", () => {
  const sent: string[] = [];

  async function running(name: string): Promise<Trigger> {
    const t: Trigger = {
      id: generateTriggerId(),
      chatId: "chat-alert",
      numericChatId: 13,
      name,
      language: "bash",
      scriptPath: "/tmp/alert.sh",
      logPath: "/tmp/alert.log",
      status: "running",
      createdAt: Date.now(),
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      fireCount: 0,
    };
    addTrigger(t);
    return t;
  }

  beforeEach(async () => {
    sent.length = 0;
    const { resetAlertsForTest } =
      await import("../core/frontend-runtime/alerts.js");
    resetAlertsForTest(async (text) => {
      sent.push(text);
    });
  });

  it("warns when the command could not run (exit 127) and clears on a clean fire", async () => {
    const t = await running("watch-logs");
    _internals.handleStdoutLine(t.id, "bash: jq: command not found");
    await _internals.finalizeExit(t.id, 127, null);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(
      /Trigger "watch-logs" \[.+\] could not run its command \(exit 127: command not found\)/,
    );

    updateTrigger(t.id, { status: "running" });
    await _internals.finalizeExit(t.id, 0, null);
    expect(sent.at(-1)).toMatch(
      /Trigger "watch-logs" is firing normally again/,
    );
  });

  it("warns on a crash signal nobody sent", async () => {
    const t = await running("crashy");
    await _internals.finalizeExit(t.id, null, "SIGSEGV");
    expect(sent[0]).toMatch(/Trigger "crashy" \[.+\] crashed \(SIGSEGV\)/);
  });

  it("stays quiet for an ordinary non-zero exit (the chat gets the wake)", async () => {
    const t = await running("verdict");
    await _internals.finalizeExit(t.id, 1, null);
    expect(sent).toHaveLength(0);
  });

  it("warns when the trigger fails to spawn", async () => {
    const { failTrigger } = await import("../core/background/triggers/exit.js");
    const t = await running("no-spawn");
    failTrigger(t, "spawn python3 ENOENT");
    expect(sent[0]).toMatch(
      /Trigger "no-spawn" \[.+\] failed to start: spawn python3 ENOENT/,
    );
  });
});
