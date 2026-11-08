/**
 * A tool action reaches the gateway over HTTP — a fresh async root with no
 * log scope. The gateway re-enters the issuing chat's running turn (so the
 * action's own lines carry `turn=<id>`) and closes every action with one
 * `tool.action` summary line.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const logMock = vi.hoisted(() => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../util/log.js", () => logMock);

const sharedMock = vi.hoisted(() => vi.fn());

vi.mock("../core/plugin/index.js", () => ({
  handlePluginAction: vi.fn(async () => null),
}));

vi.mock("../core/engine/gateway-actions/index.js", () => ({
  handleSharedAction: sharedMock,
  isChatFreeAction: vi.fn(() => false),
  handleChatFreeAction: vi.fn(async () => null),
}));

vi.mock("../util/watchdog.js", () => ({
  getHealthStatus: vi.fn(() => ({
    healthy: true,
    totalMessagesProcessed: 0,
    recentErrorCount: 0,
    msSinceLastMessage: 0,
  })),
}));

vi.mock("../storage/sessions.js", () => ({
  getActiveSessionCount: vi.fn(() => 0),
}));

vi.mock("../core/engine/dispatcher.js", () => ({
  getActiveCount: vi.fn(() => 0),
}));

import { Gateway } from "../core/engine/gateway.js";
import {
  closeTurnScope,
  createTurnScope,
  currentTurnId,
  runInTurnScope,
} from "../util/logging/turn-scope.js";
import { gatewayFetch } from "./helpers/gateway-fetch.js";

let gateway: Gateway;
let port: number;

async function post(body: Record<string, unknown>): Promise<void> {
  await gatewayFetch(`http://127.0.0.1:${port}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function toolActionLines(fn: ReturnType<typeof vi.fn>): string[] {
  return fn.mock.calls
    .map((call) => String(call[1]))
    .filter((msg) => msg.startsWith("tool.action "));
}

beforeAll(async () => {
  gateway = new Gateway();
  gateway.registerFrontendHandler("native", async () => null);
  port = await gateway.start(0);
});

afterAll(async () => {
  await gateway.stop();
});

describe("gateway → turn log", () => {
  it("runs an action inside the issuing chat's turn and summarises it", async () => {
    gateway.setContext(456, "d_abc", "native");
    let seenTurn: string | undefined;
    sharedMock.mockImplementationOnce(async () => {
      seenTurn = currentTurnId();
      return { ok: true, text: "hello" };
    });
    const scope = createTurnScope("d_abc");
    let release!: () => void;
    const turn = runInTurnScope(
      scope,
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );

    await post({ action: "read_history", _chatId: "456" });
    release();
    await turn;
    closeTurnScope(scope);
    gateway.clearContext(456);

    expect(seenTurn).toBe(scope.turnId);
    expect(toolActionLines(logMock.logDebug)).toEqual([
      expect.stringMatching(
        /^tool\.action name=read_history chat=456 ms=\d+ ok=true bytes=\d+$/,
      ),
    ]);
  });

  it("reports an ok:false answer with its error text at info", async () => {
    sharedMock.mockImplementationOnce(async () => ({
      ok: false,
      error: "no such\nmessage",
    }));
    await post({ action: "read_history", _chatId: "789", chat_id: 789 });
    expect(toolActionLines(logMock.log)).toEqual([
      expect.stringMatching(
        /^tool\.action name=read_history chat=789 ms=\d+ ok=false bytes=\d+ err=no such message$/,
      ),
    ]);
  });
});
