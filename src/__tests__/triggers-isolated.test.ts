/**
 * Isolated-mode trigger wakes (background/triggers/isolated.ts):
 *
 *   - storage round-trip of the wake_* columns
 *   - fireWake routing: isolated → runIsolated, chat → execute
 *   - single-flight lane: bursts coalesce into one follow-up run, exact
 *     duplicates collapse, overflow drops the oldest
 *   - failure notices (skipped / thrown), with a per-trigger cooldown
 *   - deleted trigger / shutdown drop the queue
 *   - trigger_create's wake-option parsing
 *   - end-to-end: a real bash watcher's TALON_FIRE + exit go isolated
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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../util/watchdog.js", () => ({ recordError: vi.fn() }));
vi.mock("../storage/daily-log.js", () => ({ appendDailyLog: vi.fn() }));

const { initTriggers, spawnTrigger, shutdownTriggers } =
  await import("../core/background/triggers/index.js");
const { fireWake } = await import("../core/background/triggers/output.js");
const { lifecycle } = await import("../core/background/triggers/state.js");
const { buildIsolatedWakePrompt, MAX_PENDING, _resetIsolatedLanes } =
  await import("../core/background/triggers/isolated.js");
const { parseWakeOptions } =
  await import("../core/engine/gateway-actions/triggers.js");

import type { Trigger } from "../storage/triggers.js";
import type { IsolatedJobSpec } from "../core/background/cron/scheduler.js";
const {
  addTrigger,
  deleteTrigger,
  generateTriggerId,
  getTrigger,
  _resetTriggersForTesting,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_WAKE_TIMEOUT_MS,
} = await import("../storage/triggers.js");

type RunResult = { status: "ran" } | { status: "skipped"; reason: string };

let tmpRoot: string;
let executeSpy: ReturnType<typeof vi.fn>;
let runIsolated: ReturnType<
  typeof vi.fn<(spec: IsolatedJobSpec) => Promise<RunResult>>
>;
let notify: ReturnType<typeof vi.fn>;

const hasUsableBash =
  spawnSync("bash", ["-lc", "exit 0"], { stdio: "ignore" }).status === 0;
const describeBash = hasUsableBash ? describe : describe.skip;

function makeTrigger(over: Partial<Trigger> = {}, body = "exit 0\n"): Trigger {
  const id = generateTriggerId();
  const scriptPath = resolve(tmpRoot, `${id}.sh`);
  writeFileSync(scriptPath, body, { mode: 0o700 });
  const t: Trigger = {
    id,
    chatId: "chat-iso",
    numericChatId: 7,
    name: `iso-${id.slice(-6)}`,
    language: "bash",
    scriptPath,
    logPath: resolve(tmpRoot, `${id}.log`),
    status: "running",
    createdAt: Date.now(),
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    fireCount: 0,
    wakeMode: "isolated",
    ...over,
  };
  addTrigger(t);
  return t;
}

/** A runIsolated mock whose calls stay pending until released. */
function gatedRunner(): { release: () => void } {
  const gates: Array<() => void> = [];
  runIsolated.mockImplementation(
    () =>
      new Promise<RunResult>((res) => gates.push(() => res({ status: "ran" }))),
  );
  return {
    release: () => {
      const g = gates.shift();
      g?.();
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

beforeAll(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "talon-trig-iso-"));
});
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  _resetTriggersForTesting();
  _resetIsolatedLanes();
  executeSpy = vi.fn(async () => ({ text: "ok" }));
  runIsolated = vi.fn(async () => ({ status: "ran" }) as RunResult);
  notify = vi.fn(async () => {});
  initTriggers({
    execute: executeSpy as never,
    runIsolated,
    notify: notify as never,
  });
});

afterEach(async () => {
  await shutdownTriggers();
});

describe("trigger store — wake_* columns", () => {
  it("round-trips isolated wake settings", () => {
    const t = makeTrigger({
      model: "cheap-model",
      provider: "other-backend",
      instructions: "Follow skill szufla-wake.",
      wakeTimeoutMs: 120_000,
    });
    const back = getTrigger(t.id)!;
    expect(back.wakeMode).toBe("isolated");
    expect(back.model).toBe("cheap-model");
    expect(back.provider).toBe("other-backend");
    expect(back.instructions).toBe("Follow skill szufla-wake.");
    expect(back.wakeTimeoutMs).toBe(120_000);
  });

  it("a chat-mode trigger reads back with no wake settings", () => {
    const t = makeTrigger({ wakeMode: undefined });
    const back = getTrigger(t.id)!;
    expect(back.wakeMode).toBeUndefined();
    expect(back.instructions).toBeUndefined();
    expect(back.provider).toBeUndefined();
    expect(back.wakeTimeoutMs).toBeUndefined();
  });
});

describe("fireWake routing", () => {
  it("isolated: runs a one-shot job, never resumes the chat session", async () => {
    const t = makeTrigger({
      description: "watches szufla",
      model: "m-cheap",
      instructions: "Follow skill szufla-wake.",
    });
    await fireWake(t.id, "fired", '{"event":"new"}', false);

    expect(executeSpy).not.toHaveBeenCalled();
    expect(runIsolated).toHaveBeenCalledTimes(1);
    const spec = runIsolated.mock.calls[0][0];
    expect(spec).toMatchObject({
      chatId: "chat-iso",
      name: t.name,
      kind: "trigger",
      model: "m-cheap",
      instructions: "Follow skill szufla-wake.",
      timeoutMs: DEFAULT_WAKE_TIMEOUT_MS,
    });
    expect(spec.provider).toBeUndefined();
    expect(spec.payload).toContain('{"event":"new"}');
    expect(spec.payload).toContain("signalled");
    expect(spec.payload).toContain("watches szufla");
    expect(spec.payload).toContain('chat_id="chat-iso"');
    expect(getTrigger(t.id)!.fireCount).toBe(1);
  });

  it("isolated: passes provider and per-trigger timeout through", async () => {
    const t = makeTrigger({
      model: "m",
      provider: "p",
      wakeTimeoutMs: 45_000,
    });
    await fireWake(t.id, "errored", "exit 1", true);
    expect(runIsolated.mock.calls[0][0]).toMatchObject({
      provider: "p",
      model: "m",
      timeoutMs: 45_000,
    });
    expect(runIsolated.mock.calls[0][0].payload).toContain("errored");
  });

  it("chat mode is unchanged: resumes the chat via execute", async () => {
    const t = makeTrigger({ wakeMode: undefined });
    await fireWake(t.id, "fired", "hello", false);
    expect(runIsolated).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0][0].prompt).toContain("TRIGGER FIRED");
  });
});

describe("isolated lane — concurrency", () => {
  it("coalesces a burst into one follow-up run and collapses duplicates", async () => {
    const gate = gatedRunner();
    const t = makeTrigger();
    const first = fireWake(t.id, "fired", "evt-alpha", false);
    await flush();
    expect(runIsolated).toHaveBeenCalledTimes(1);

    await fireWake(t.id, "fired", "evt-beta", false);
    await fireWake(t.id, "fired", "evt-gamma", false);
    await fireWake(t.id, "fired", "evt-beta", false); // exact duplicate
    expect(runIsolated).toHaveBeenCalledTimes(1); // still single-flight

    gate.release();
    await flush();
    expect(runIsolated).toHaveBeenCalledTimes(2);
    const follow = runIsolated.mock.calls[1][0].payload;
    expect(follow).toContain("2 events");
    expect(follow).toContain("event 1/2");
    expect(follow).toContain("evt-beta");
    expect(follow).toContain("evt-gamma");
    expect(follow).not.toContain("evt-alpha");
    expect(follow).toContain("1 duplicate event(s) collapsed");

    gate.release();
    await first;
    expect(runIsolated).toHaveBeenCalledTimes(2);
    // every fire is still counted on the trigger
    expect(getTrigger(t.id)!.fireCount).toBe(4);
  });

  it("drops the oldest events past MAX_PENDING", async () => {
    const gate = gatedRunner();
    const t = makeTrigger();
    const first = fireWake(t.id, "fired", "first", false);
    await flush();
    for (let i = 0; i < MAX_PENDING + 3; i++) {
      await fireWake(t.id, "fired", `q${i}`, false);
    }
    gate.release();
    await flush();
    const follow = runIsolated.mock.calls[1][0].payload;
    expect(follow).toContain(`${MAX_PENDING} events`);
    expect(follow).toContain("3 older event(s) dropped");
    expect(follow).not.toMatch(/\nq0\n|\nq0$/);
    expect(follow).toContain(`q${MAX_PENDING + 2}`);
    gate.release();
    await first;
  });

  it("drops queued events when the trigger is deleted mid-run", async () => {
    const gate = gatedRunner();
    const t = makeTrigger();
    const first = fireWake(t.id, "fired", "a", false);
    await flush();
    await fireWake(t.id, "fired", "b", false);
    deleteTrigger(t.id);
    gate.release();
    await first;
    expect(runIsolated).toHaveBeenCalledTimes(1);
  });

  it("starts no run while shutting down", async () => {
    const t = makeTrigger();
    lifecycle.shuttingDown = true;
    await fireWake(t.id, "fired", "late", false);
    expect(runIsolated).not.toHaveBeenCalled();
  });
});

describe("isolated lane — failures", () => {
  it("posts one plain notice when a run is skipped, then cools down", async () => {
    runIsolated.mockResolvedValue({
      status: "skipped",
      reason: 'provider "x" is unavailable.',
    });
    const t = makeTrigger();
    await fireWake(t.id, "fired", "a", false);
    await fireWake(t.id, "fired", "b", false);
    expect(runIsolated).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
    const [chatId, text, stringId] = notify.mock.calls[0];
    expect(chatId).toBe(7);
    expect(stringId).toBe("chat-iso");
    expect(text).toContain(t.name);
    expect(text).toContain('provider "x" is unavailable.');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("notices a thrown run and keeps the lane usable", async () => {
    runIsolated.mockRejectedValueOnce(new Error("no model resolved"));
    const t = makeTrigger();
    await fireWake(t.id, "fired", "a", false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toContain("no model resolved");
    await fireWake(t.id, "fired", "b", false);
    expect(runIsolated).toHaveBeenCalledTimes(2);
  });

  it("re-arms the notice after a successful run", async () => {
    runIsolated
      .mockResolvedValueOnce({ status: "skipped", reason: "r1" })
      .mockResolvedValueOnce({ status: "ran" })
      .mockResolvedValueOnce({ status: "skipped", reason: "r2" });
    const t = makeTrigger();
    await fireWake(t.id, "fired", "a", false);
    await fireWake(t.id, "fired", "b", false);
    await fireWake(t.id, "fired", "c", false);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe("buildIsolatedWakePrompt", () => {
  it("describes a single event without numbering", () => {
    const p = buildIsolatedWakePrompt(
      { id: "trig_1", name: "w", chatId: "c1", description: undefined },
      [{ status: "signalled", payload: "", at: 0 }],
    );
    expect(p).toContain('Trigger "w" (trig_1) delivered 1 event.');
    expect(p).toContain("--- signalled at 1970-01-01T00:00:00Z ---");
    expect(p).toContain("(no output)");
    expect(p).not.toContain("Trigger note:");
  });
});

describe("trigger_create — parseWakeOptions", () => {
  it("defaults to chat mode", () => {
    expect(parseWakeOptions({})).toEqual({
      ok: true,
      value: { isolated: false },
    });
  });

  it("rejects isolated-only params in chat mode", () => {
    const r = parseWakeOptions({ instructions: "x", provider: "p" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("instructions, provider");
      expect(r.error).toContain('mode="isolated"');
    }
  });

  it("rejects an unknown mode", () => {
    expect(parseWakeOptions({ mode: "detached" }).ok).toBe(false);
  });

  it("bounds wake_timeout_seconds", () => {
    expect(
      parseWakeOptions({ mode: "isolated", wake_timeout_seconds: 10 }).ok,
    ).toBe(false);
    expect(
      parseWakeOptions({ mode: "isolated", wake_timeout_seconds: 99_999 }).ok,
    ).toBe(false);
    expect(
      parseWakeOptions({ mode: "isolated", wake_timeout_seconds: 1.5 }).ok,
    ).toBe(false);
  });

  it("accepts a full isolated spec", () => {
    expect(
      parseWakeOptions({
        mode: "isolated",
        instructions: "  Follow skill szufla-wake.  ",
        provider: "openai",
        wake_timeout_seconds: 120,
      }),
    ).toEqual({
      ok: true,
      value: {
        isolated: true,
        instructions: "Follow skill szufla-wake.",
        provider: "openai",
        wakeTimeoutMs: 120_000,
      },
    });
  });

  it("rejects an oversized brief", () => {
    expect(
      parseWakeOptions({ mode: "isolated", instructions: "x".repeat(4001) }).ok,
    ).toBe(false);
  });
});

describeBash("isolated trigger — end to end", () => {
  it("routes a real watcher's TALON_FIRE and exit wakes to isolated runs", async () => {
    const t = makeTrigger(
      { status: "pending" },
      'printf "TALON_FIRE: {\\"n\\":1}\\n"\nexit 0\n',
    );
    spawnTrigger(t);
    const start = Date.now();
    while (runIsolated.mock.calls.length < 2 && Date.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(executeSpy).not.toHaveBeenCalled();
    const payloads = runIsolated.mock.calls.map((c) => c[0].payload);
    expect(payloads.join("\n")).toContain('{"n":1}');
    expect(payloads.some((p) => p.includes("fired at"))).toBe(true);
  });
});
