/**
 * Telegram's half of the frontend lifecycle contract.
 *
 * grammY's `bot.start()` promise IS the long-poll: it resolves when
 * polling stops, which is shutdown. Readiness is its `onStart` callback,
 * so that is what the frontend's `start()` must resolve on — and the
 * long-poll is kept for `stop()` to await.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

type StartOptions = {
  allowed_updates?: readonly string[];
  onStart?: (info: { username: string }) => void;
};

/** The one grammY behaviour under test, plus the surface the factory touches. */
class FakeBot {
  static last: FakeBot | null = null;
  api = {
    config: { use: vi.fn() },
    sendChatAction: vi.fn(async () => ({})),
  };
  catch = vi.fn();
  startOptions: StartOptions | null = null;
  pollEnded = false;
  private endPoll: (() => void) | null = null;

  constructor() {
    FakeBot.last = this;
  }

  start(options: StartOptions): Promise<void> {
    this.startOptions = options;
    return new Promise<void>((resolve) => {
      this.endPoll = () => {
        this.pollEnded = true;
        resolve();
      };
    });
  }

  /** grammY resolves the long-poll once polling has stopped. */
  async stop(): Promise<void> {
    // Not synchronous in grammY either — the loop unwinds after a tick.
    await new Promise((r) => setTimeout(r, 0));
    this.endPoll?.();
  }

  /** Fire what grammY fires once getMe() succeeded and polling is up. */
  reportListening(): void {
    this.startOptions?.onStart?.({ username: "talon_bot" });
  }
}

/** Just enough of grammY's GrammyError for the token check in bot.catch. */
class FakeGrammyError extends Error {
  constructor(
    readonly error_code: number,
    readonly description: string,
  ) {
    super(`Call to 'x' failed! (${error_code}: ${description})`);
  }
}

vi.mock("grammy", () => ({
  Bot: FakeBot,
  GrammyError: FakeGrammyError,
  InputFile: class {},
  API_CONSTANTS: { DEFAULT_UPDATE_TYPES: ["message", "callback_query"] },
}));

vi.mock("@grammyjs/auto-retry", () => ({ autoRetry: () => vi.fn() }));
vi.mock("@grammyjs/transformer-throttler", () => ({
  apiThrottler: () => vi.fn(),
}));

const confirmUpdates = vi.fn(async () => {});
vi.mock("../frontend/telegram/polling/update-offset.js", () => ({
  confirmUpdates: () => confirmUpdates(),
}));

const disconnectUserClient = vi.fn(async () => {});
vi.mock("../frontend/telegram/userbot.js", () => ({
  initUserClient: vi.fn(async () => false),
  disconnectUserClient: () => disconnectUserClient(),
}));

const { createTelegramFrontend } =
  await import("../frontend/telegram/index.js");

const gatewayStop = vi.fn(async () => {});

function makeFrontend(): ReturnType<typeof createTelegramFrontend> {
  const gateway = {
    setContext: vi.fn(),
    clearContext: vi.fn(),
    getMessageCount: vi.fn(() => 0),
    getPort: vi.fn(() => 19876),
    stop: gatewayStop,
  };
  return createTelegramFrontend(
    { botToken: "123:abc" } as never,
    gateway as never,
  );
}

describe("telegram frontend lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeBot.last = null;
  });

  it("start() resolves on grammY's onStart, not when polling ends", async () => {
    const frontend = makeFrontend();

    let started = false;
    const starting = frontend.start().then(() => {
      started = true;
    });

    // Polling is up but grammY has not reported readiness yet.
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toBe(false);

    FakeBot.last!.reportListening();
    await starting;
    expect(started).toBe(true);
    // The long-poll is still running — the boot is over, the bot is not.
    expect(FakeBot.last!.pollEnded).toBe(false);
  });

  it("passes chat_join_request through to the poll", async () => {
    const frontend = makeFrontend();
    const starting = frontend.start();
    FakeBot.last!.reportListening();
    await starting;

    expect(FakeBot.last!.startOptions?.allowed_updates).toContain(
      "chat_join_request",
    );
  });

  it("stop() awaits the long-poll before confirming the offset", async () => {
    const frontend = makeFrontend();
    const starting = frontend.start();
    const bot = FakeBot.last!;
    bot.reportListening();
    await starting;

    await frontend.stop();

    expect(bot.pollEnded).toBe(true);
    expect(confirmUpdates).toHaveBeenCalled();
    expect(disconnectUserClient).toHaveBeenCalled();
    expect(gatewayStop).toHaveBeenCalled();
  });

  describe("bot.catch", () => {
    /** Start the frontend and hand back the error handler it installed. */
    async function installedCatch(): Promise<(err: unknown) => void> {
      const frontend = makeFrontend();
      const starting = frontend.start();
      const bot = FakeBot.last!;
      bot.reportListening();
      await starting;
      return bot.catch.mock.calls[0][0] as (err: unknown) => void;
    }

    /** grammY hands bot.catch a BotError wrapping what the handler threw. */
    function botError(inner: Error): Error {
      return Object.assign(
        new Error(`${inner.name} in middleware: ${inner.message}`),
        {
          error: inner,
        },
      );
    }

    it("survives a handler's 400 'not found' — only the token is fatal", async () => {
      const exit = vi
        .spyOn(process, "exit")
        .mockImplementation((() => {}) as never);
      try {
        const onError = await installedCatch();
        onError(
          botError(
            new FakeGrammyError(400, "Bad Request: message to edit not found"),
          ),
        );
        onError(
          botError(new FakeGrammyError(400, "Bad Request: chat not found")),
        );
        onError(botError(new Error("session 404 not found")));
        expect(exit).not.toHaveBeenCalled();
      } finally {
        exit.mockRestore();
      }
    });

    it("still shuts down when Telegram rejects the token (401 / 404)", async () => {
      const exit = vi
        .spyOn(process, "exit")
        .mockImplementation((() => {}) as never);
      try {
        const onError = await installedCatch();
        onError(botError(new FakeGrammyError(401, "Unauthorized")));
        onError(botError(new FakeGrammyError(404, "Not Found")));
        expect(exit).toHaveBeenCalledTimes(2);
        expect(exit).toHaveBeenCalledWith(1);
      } finally {
        exit.mockRestore();
      }
    });
  });
});
