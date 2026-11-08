/**
 * The log context: a turn's id rides AsyncLocalStorage, and log.ts
 * appends `turn=<id>` to every line written from inside the turn —
 * across awaits, callbacks and out-of-band callers that re-enter it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
// Capture every line the real log.ts writes: the turn tag is appended
// inside log.ts, so the logger underneath is what the assertions read.
type Line = { level: string; msg: string };
const lines: Line[] = [];
const sink = (level: string) => (_obj: unknown, msg: string) => {
  lines.push({ level, msg });
};
vi.mock("pino", () => ({
  default: Object.assign(
    () => ({
      info: sink("info"),
      error: sink("error"),
      warn: sink("warn"),
      debug: sink("debug"),
    }),
    { multistream: vi.fn(() => ({ write: vi.fn() })) },
  ),
}));
vi.mock("pino-pretty", () => ({
  default: () => ({ write: vi.fn(), on: vi.fn() }),
}));

const { log } = await import("../util/log.js");
const {
  closeTurnScope,
  createTurnScope,
  currentTurnId,
  runInChatTurnScope,
  runInTurnScope,
} = await import("../util/logging/turn-scope.js");

beforeEach(() => {
  lines.length = 0;
});

describe("log context", () => {
  it("tags every line of an async chain with the turn id", async () => {
    const scope = createTurnScope("c1");
    await runInTurnScope(scope, async () => {
      log("dispatcher", "before await");
      await new Promise((r) => setTimeout(r, 1));
      await Promise.resolve().then(() => log("agent", "in a continuation"));
      await new Promise<void>((r) =>
        setImmediate(() => {
          log("gateway", "in a callback");
          r();
        }),
      );
    });
    closeTurnScope(scope);
    log("dispatcher", "after the turn");

    expect(scope.turnId).toMatch(/^t-[0-9a-z]{7}$/);
    expect(lines.map((l) => l.msg)).toEqual([
      `before await turn=${scope.turnId}`,
      `in a continuation turn=${scope.turnId}`,
      `in a callback turn=${scope.turnId}`,
      "after the turn",
    ]);
  });

  it("does not repeat a tag the caller already wrote", () => {
    const scope = createTurnScope("c2");
    runInTurnScope(scope, () => log("dispatcher", `x turn=${scope.turnId}`));
    closeTurnScope(scope);
    expect(lines[0].msg).toBe(`x turn=${scope.turnId}`);
  });

  it("stops tagging once the turn settles, even from a leftover resource", async () => {
    const scope = createTurnScope("c3");
    let late!: () => void;
    const lateFired = new Promise<void>((r) => {
      late = r;
    });
    runInTurnScope(scope, () => {
      setTimeout(() => {
        log("agent", "late");
        late();
      }, 5);
    });
    closeTurnScope(scope);
    await lateFired;
    expect(lines.at(-1)?.msg).toBe("late");
  });

  it("lets an out-of-band caller (the gateway) join a chat's running turn", async () => {
    const scope = createTurnScope("c4");
    let release!: () => void;
    const running = runInTurnScope(
      scope,
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    // A fresh async root, as an HTTP request would be.
    const seen = await new Promise<(string | undefined)[]>((r) =>
      setImmediate(() =>
        r([
          runInChatTurnScope(["nope", "c4"], () => currentTurnId()),
          runInChatTurnScope(["other"], () => currentTurnId()),
        ]),
      ),
    );
    release();
    await running;
    closeTurnScope(scope);
    expect(seen).toEqual([scope.turnId, undefined]);
    expect(runInChatTurnScope(["c4"], () => currentTurnId())).toBeUndefined();
  });
});
