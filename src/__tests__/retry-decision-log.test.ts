import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { log, logDebug, logWarn } from "../util/log.js";
import { applyRetryDecision } from "../backend/runtime/turn/handle-retry.js";
import { subscribeSseStream } from "../backend/remote-server/sse-stream.js";
import { clearModels, registerModels } from "../core/models/catalog.js";

const params = {
  chatId: "c1",
  text: "hi",
  senderName: "Ada",
  isGroup: false,
};
const recurse = vi.fn(async () => ({
  text: "",
  durationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
}));

function lines(fn: typeof log): string[] {
  return vi
    .mocked(fn)
    .mock.calls.map((c) => String(c[1]))
    .filter((l) => l.startsWith("retry.decision") || l.startsWith("sse."));
}

beforeEach(() => {
  clearModels();
  vi.mocked(log).mockClear();
  vi.mocked(logWarn).mockClear();
  vi.mocked(logDebug).mockClear();
});

describe("retry.decision log", () => {
  it("logs a propagate with the classified cause, backend and redacted error", async () => {
    await applyRetryDecision({
      err: new Error("401 unauthorized: token=abc123 rejected"),
      chatId: "c1",
      activeModel: "m1",
      retried: false,
      params,
      recurseWithRetried: recurse,
      backendLabel: "OpenAI Agents",
    });
    const [line] = lines(log);
    expect(line).toContain(
      "retry.decision chat=c1 backend=openai-agents model=m1 attempt=1 reason=auth",
    );
    expect(line).toContain("retryable=false status=401 decision=propagate");
    expect(line).toContain("token=[redacted]");
    expect(line).not.toContain("abc123");
  });

  it("logs a fallback as a warning naming the fallback model", async () => {
    registerModels([
      {
        id: "m1",
        aliases: [],
        provider: "t",
        displayName: "M1",
        fallback: "m2",
      },
      { id: "m2", aliases: [], provider: "t", displayName: "M2" },
    ]);
    await applyRetryDecision({
      err: new Error("503 overloaded"),
      chatId: "c1",
      activeModel: "m1",
      retried: false,
      params,
      recurseWithRetried: recurse,
    });
    const [line] = lines(logWarn);
    expect(line).toContain(
      "backend=claude model=m1 attempt=1 reason=overloaded",
    );
    expect(line).toContain("decision=fallback_model(m2)");
  });
});

describe("sse.subscribe.retry log", () => {
  it("logs each retry with attempt, delay and error", async () => {
    const event = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({
        stream: (async function* () {})(),
      });
    await subscribeSseStream({ global: { event } }, "chat-9");
    expect(lines(logDebug)).toEqual([
      'sse.subscribe.retry chat=chat-9 attempt=1 delay_ms=150 error="ECONNREFUSED"',
    ]);
  });
});
