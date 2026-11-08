/**
 * Teams alerts: `teams.poll` for Graph polling that keeps failing, and
 * `delivery.teams` for replies the webhook keeps rejecting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../core/frontend-runtime/alerts.js", () => ({
  raiseAlert: vi.fn(),
  resolveAlert: vi.fn(),
}));
vi.mock("../frontend/teams/commands.js", () => ({
  handleSlashCommand: vi.fn(async () => false),
}));
vi.mock("../frontend/teams/turn.js", () => ({ runTurn: vi.fn() }));
const webhookOk = { current: false };
vi.mock("../frontend/teams/proxy-fetch.js", () => ({
  proxyFetch: vi.fn(async () =>
    webhookOk.current
      ? { ok: true, status: 200, text: async () => "" }
      : { ok: false, status: 403, text: async () => "Forbidden" },
  ),
}));

const { startPolling, stopPolling } = await import("../frontend/teams/poll.js");
const { createTeamsRuntime } = await import("../frontend/teams/runtime.js");
const { createTeamsActionHandler } =
  await import("../frontend/teams/actions.js");
const { raiseAlert, resolveAlert } =
  await import("../core/frontend-runtime/alerts.js");
const { log, logError } = await import("../util/log.js");

const MIN = 60_000;

beforeEach(() => {
  vi.mocked(raiseAlert).mockClear();
  vi.mocked(resolveAlert).mockClear();
  vi.mocked(log).mockClear();
  vi.mocked(logError).mockClear();
});

describe("teams.poll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("raises after 10 min of failed polls and resolves on the next good one", async () => {
    const runtime = createTeamsRuntime(
      { teamsGraphPollMs: MIN } as never,
      {} as never,
    );
    let failing = true;
    runtime.graphClient = {
      getChatMessages: vi.fn(async () => {
        if (failing) throw new Error("Token refresh failed");
        return [];
      }),
    } as never;

    await startPolling(runtime, "19:chat");
    expect(logError).toHaveBeenCalledWith(
      "teams",
      "Poll error: poll.fail chat=19:chat attempt=1 down_ms=0 next_poll_ms=60000 err=Token refresh failed",
    );
    await vi.advanceTimersByTimeAsync(9 * MIN);
    expect(raiseAlert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(raiseAlert).toHaveBeenCalledWith(
      "teams.poll",
      "Teams polling has failed for 10 min: Token refresh failed. Messages are not being received.",
      { severity: undefined },
    );

    failing = false;
    await vi.advanceTimersByTimeAsync(MIN);
    expect(resolveAlert).toHaveBeenCalledWith(
      "teams.poll",
      "Teams polling is working again.",
    );
    expect(log).toHaveBeenCalledWith(
      "teams",
      expect.stringMatching(
        /^poll\.recovered chat=19:chat failed_attempts=11 /,
      ),
    );
    stopPolling(runtime);
  });

  it("does not raise when polling recovers inside the window", async () => {
    const runtime = createTeamsRuntime(
      { teamsGraphPollMs: MIN } as never,
      {} as never,
    );
    let calls = 0;
    runtime.graphClient = {
      getChatMessages: vi.fn(async () => {
        if (calls++ < 3) throw new Error("503");
        return [];
      }),
    } as never;
    await startPolling(runtime, "c");
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(raiseAlert).not.toHaveBeenCalled();
    stopPolling(runtime);
  });
});

describe("teams message errors", () => {
  it("names the failing message and chat", async () => {
    const { handleSlashCommand } =
      await import("../frontend/teams/commands.js");
    vi.mocked(handleSlashCommand).mockRejectedValueOnce(new Error("boom"));
    const runtime = createTeamsRuntime({} as never, {} as never);
    runtime.graphClient = {
      getChatMessages: vi.fn(async () => [
        { id: "m1", text: "hi", senderName: "Ann", chatId: "c", edited: false },
      ]),
    } as never;
    await startPolling(runtime, "c");
    stopPolling(runtime);
    expect(logError).toHaveBeenCalledWith(
      "teams",
      "Poll error: message=m1 chat=c boom",
    );
  });
});

describe("delivery.teams", () => {
  it("raises after 3 rejected replies to a chat and resolves on the next delivery", async () => {
    const gateway = { incrementMessages: vi.fn() };
    const handler = createTeamsActionHandler(
      "https://example.invalid/hook",
      gateway as never,
    );
    webhookOk.current = false;
    for (let i = 0; i < 3; i++) {
      const r = await handler({ action: "send_message", text: "hi" }, 5);
      expect(r?.ok).toBe(false);
    }
    expect(raiseAlert).toHaveBeenCalledWith(
      "delivery.teams",
      expect.stringContaining("Teams replies to chat 5 have failed 3 times"),
    );

    webhookOk.current = true;
    expect((await handler({ action: "send_message", text: "hi" }, 5))?.ok).toBe(
      true,
    );
    expect(resolveAlert).toHaveBeenCalledWith(
      "delivery.teams",
      "Teams replies are being delivered again.",
    );
  });
});
