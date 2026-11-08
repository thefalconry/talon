import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { log, logWarn } from "../util/log.js";
import {
  activeAlerts,
  resetAlertsForTest,
} from "../core/frontend-runtime/alerts.js";
import {
  noteTurnFailed,
  noteTurnSucceeded,
  resetTurnHealthForTest,
  stuckLoopAlert,
  type TurnBinding,
} from "../core/engine/turn-health.js";
import { faultText } from "../core/engine/fault-text.js";
import { AgentRunError } from "../core/agent-runtime/events.js";
import { TalonError } from "../core/errors.js";
import { execute, initDispatcher } from "../core/engine/dispatcher.js";
import { stubBackend, stubResolveActiveModel } from "./helpers/stub-backend.js";
import {
  recordMessageProcessed,
  recordMessageReceived,
  resetWatchdogActivityForTests,
  startWatchdog,
  stopWatchdog,
} from "../util/watchdog.js";

const sent: string[] = [];
const keys = () => activeAlerts().map((a) => a.key);

function turn(chatId: string, backendId = "claude"): TurnBinding {
  return { chatId, backendId, model: "opus", source: "message", durationMs: 5 };
}

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  resetAlertsForTest(async (text) => {
    sent.push(text);
  });
  resetTurnHealthForTest();
  vi.mocked(logWarn).mockClear();
  vi.mocked(log).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("turn.failing.<chat>", () => {
  it("raises on the third consecutive failure, not before, and resolves on success", () => {
    const err = new Error("model returned garbage");
    noteTurnFailed(turn("c1"), err);
    noteTurnFailed(turn("c1"), err);
    expect(sent).toHaveLength(0);
    noteTurnFailed(turn("c1"), err);
    expect(keys()).toContain("turn.failing.c1");
    expect(sent[0]).toMatch(
      /Chat c1 has failed its last 3 turns on claude\/opus/,
    );
    expect(sent[0]).toMatch(/model returned garbage/);

    noteTurnSucceeded(turn("c1"));
    expect(keys()).not.toContain("turn.failing.c1");
    expect(sent.at(-1)).toMatch(/Chat c1 is answering again/);
  });

  it("a success in between resets the streak", () => {
    const err = new Error("boom");
    noteTurnFailed(turn("c1"), err);
    noteTurnFailed(turn("c1"), err);
    noteTurnSucceeded(turn("c1"));
    noteTurnFailed(turn("c1"), err);
    noteTurnFailed(turn("c1"), err);
    expect(sent).toHaveLength(0);
  });

  it("a stopped turn is not a failure", () => {
    const stopped = new TalonError("Turn stopped by user", {
      reason: "stopped",
    });
    for (let i = 0; i < 5; i++) noteTurnFailed(turn("c1"), stopped);
    expect(sent).toHaveLength(0);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("logs each failure with the classified cause and ids", () => {
    noteTurnFailed(turn("c9", "codex"), new Error("exit code 2"));
    const line = String(vi.mocked(logWarn).mock.calls[0]?.[1]);
    expect(line).toContain("turn.fail chat=c9 backend=codex model=opus");
    expect(line).toContain("cause=error streak=1 ms=5");
    expect(line).toContain('error="exit code 2"');
  });
});

describe("backend.failing.<backend>", () => {
  it("raises when 3 chats fail within 10 minutes and resolves on a success", () => {
    const err = new Error("503 upstream");
    noteTurnFailed(turn("a"), err);
    noteTurnFailed(turn("b"), err);
    expect(keys()).not.toContain("backend.failing.claude");
    noteTurnFailed(turn("c"), err);
    expect(keys()).toContain("backend.failing.claude");
    expect(sent.at(-1)).toMatch(/claude backend failed turns in 3 chats/);

    noteTurnSucceeded(turn("d"));
    expect(keys()).not.toContain("backend.failing.claude");
  });

  it("forgets failures older than the window", () => {
    const err = new Error("503 upstream");
    noteTurnFailed(turn("a"), err);
    noteTurnFailed(turn("b"), err);
    vi.advanceTimersByTime(11 * 60_000);
    noteTurnFailed(turn("c"), err);
    expect(keys()).not.toContain("backend.failing.claude");
  });
});

describe("backend.auth / backend.quota", () => {
  it("raises auth on the first login failure and resolves on the next success", () => {
    noteTurnFailed(
      turn("c1"),
      new AgentRunError({
        kind: "unknown",
        message: "Not logged in · Please run /login",
        retryable: false,
      }),
    );
    expect(keys()).toEqual(["backend.auth.claude"]);
    expect(sent[0]).toMatch(/claude backend is not signed in: Not logged in/);

    noteTurnSucceeded(turn("c2"));
    expect(keys()).toEqual([]);
    expect(sent.at(-1)).toMatch(/signed in again/);
  });

  it("classifies typed auth errors and expired Codex logins", () => {
    noteTurnFailed(
      turn("c1", "codex"),
      new TalonError("Codex login expired — run `codex login`", {
        reason: "auth",
      }),
    );
    noteTurnFailed(
      turn("c1", "agy"),
      new Error("Antigravity is not authenticated. Run `agy` once"),
    );
    expect(keys().sort()).toEqual(["backend.auth.agy", "backend.auth.codex"]);
  });

  it("raises quota for usage limits, and auth/quota do not feed the streaks", () => {
    const limit = new AgentRunError({
      kind: "rate_limit",
      message: "You've hit your weekly limit · resets Jul 10, 9am",
      retryable: false,
    });
    for (let i = 0; i < 4; i++) noteTurnFailed(turn(`c${i}`), limit);
    expect(keys()).toEqual(["backend.quota.claude"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/out of quota: You've hit your weekly limit/);

    noteTurnSucceeded(turn("c1"));
    expect(sent.at(-1)).toMatch(/has quota again/);
  });

  it("a transient 429 is a plain failure, not a quota alert", () => {
    const blip = new AgentRunError({
      kind: "rate_limit",
      message: "429 Too Many Requests",
      retryable: true,
    });
    noteTurnFailed(turn("c1"), blip);
    expect(keys()).toEqual([]);
  });
});

describe("faultText", () => {
  it("flattens, clips and redacts credentials", () => {
    const text = faultText(
      new Error(
        "401 from https://x/api?token=abc123secret\nAuthorization: Bearer eyJhbGciOi.xyz sk-ant-api03-abcdefghijkl",
      ),
    );
    expect(text).not.toMatch(/abc123secret|eyJhbGciOi|sk-ant-api03-abcdef/);
    expect(text).toContain("token=[redacted]");
    expect(text).not.toContain("\n");
    expect(faultText("x".repeat(500)).length).toBe(200);
  });
});

describe("dispatcher wiring", () => {
  function failingDeps(fail: { on: boolean }) {
    const query = vi.fn(async () => {
      if (fail.on) throw new Error("backend exploded");
      return {
        text: "ok",
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
    });
    const backend = stubBackend({ query });
    return {
      getBackend: () => backend,
      resolveActiveModel: stubResolveActiveModel("claude", "opus-x"),
      context: {
        acquire: vi.fn(),
        release: vi.fn(),
        getMessageCount: vi.fn(() => 0),
      },
      sendTyping: vi.fn(async () => {}),
    };
  }

  const params = {
    chatId: "777",
    numericChatId: 777,
    prompt: "hi",
    senderName: "U",
    isGroup: false,
    source: "message" as const,
  };

  it("raises turn.failing after three failed turns and resolves on success", async () => {
    const fail = { on: true };
    initDispatcher(failingDeps(fail) as never);
    for (let i = 0; i < 3; i++) {
      await expect(execute(params)).rejects.toThrow();
    }
    expect(keys()).toContain("turn.failing.777");
    expect(sent[0]).toMatch(/claude\/opus-x: backend exploded/);

    fail.on = false;
    await execute(params);
    expect(keys()).not.toContain("turn.failing.777");
  });
});

describe("dispatcher.stuck", () => {
  afterEach(() => stopWatchdog());

  it("alerts once the loop is wedged past the threshold and resolves when it moves", () => {
    initDispatcher({
      getBackend: () => stubBackend(),
      resolveActiveModel: stubResolveActiveModel(),
      context: {
        acquire: vi.fn(),
        release: vi.fn(),
        getMessageCount: vi.fn(() => 0),
      },
      sendTyping: vi.fn(async () => {}),
    } as never);
    resetWatchdogActivityForTests();
    startWatchdog();
    vi.advanceTimersByTime(1_000);
    recordMessageReceived();

    vi.advanceTimersByTime(9 * 60_000);
    expect(keys()).not.toContain("dispatcher.stuck");
    vi.advanceTimersByTime(3 * 60_000);
    expect(keys()).toContain("dispatcher.stuck");
    expect(sent[0]).toMatch(/message loop looks stuck/);
    expect(sent[0]).toMatch(/No turn is running or queued/);

    recordMessageProcessed();
    expect(keys()).not.toContain("dispatcher.stuck");
    expect(sent.at(-1)).toMatch(/processing again/);
  });

  it("the stuck listener is a no-op to resolve when nothing was raised", () => {
    stuckLoopAlert.onRecovered();
    expect(sent).toHaveLength(0);
  });
});
