import { describe, it, expect, vi, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("../util/paths.js", () => ({
  dirs: {},
  files: {
    userSession: join(tmpdir(), `talon-userbot-monitor-${process.pid}`, "s"),
  },
}));
vi.mock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
vi.mock("../core/frontend-runtime/alerts.js", () => ({
  raiseAlert: vi.fn(),
  resolveAlert: vi.fn(),
}));

/** Every GramJS client the module builds, in order. */
const built: FakeClient[] = [];
/** What the next-built client's connect() does. */
let nextConnect: () => Promise<void> = async () => {};

class FakeClient {
  connected = true;
  session = { save: () => "session" };
  connect = vi.fn(() => nextConnect());
  disconnect = vi.fn(async () => {});
  isUserAuthorized = vi.fn(async () => true);
  getMe = vi.fn(async () => ({}));
  constructor() {
    built.push(this);
  }
}

vi.mock("telegram", () => ({ TelegramClient: FakeClient, Api: {} }));
vi.mock("telegram/sessions/index.js", () => ({ StringSession: class {} }));

const { initUserClient, disconnectUserClient, isUserClientReady } =
  await import("../frontend/telegram/userbot.js");

const { raiseAlert, resolveAlert } =
  await import("../core/frontend-runtime/alerts.js");
const { logWarn } = await import("../util/log.js");

const TICK_MS = 5 * 60 * 1000;

describe("userbot connection monitor", () => {
  afterEach(async () => {
    await disconnectUserClient();
    vi.useRealTimers();
    built.length = 0;
    nextConnect = async () => {};
  });

  it("keeps retrying after a failed full re-init instead of going dark", async () => {
    vi.useFakeTimers();
    expect(await initUserClient({ apiId: 1, apiHash: "h" })).toBe(true);

    // The socket dies and the network stays down for one tick: reconnect
    // and the full re-init both fail.
    built[0].connected = false;
    nextConnect = async () => {
      throw new Error("network down");
    };
    built[0].connect.mockImplementation(() => nextConnect());
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(built).toHaveLength(2);
    expect(isUserClientReady()).toBe(false);
    // The failed re-init client is closed, not left retrying on its own.
    expect(built[1].disconnect).toHaveBeenCalled();

    // Network is back: the next tick must build a client again.
    nextConnect = async () => {};
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(built).toHaveLength(3);
    expect(built[2].connect).toHaveBeenCalled();
    expect(isUserClientReady()).toBe(true);
  });

  it("does not re-init after the monitor is stopped", async () => {
    vi.useFakeTimers();
    expect(await initUserClient({ apiId: 1, apiHash: "h" })).toBe(true);
    await disconnectUserClient();
    await vi.advanceTimersByTimeAsync(TICK_MS * 2);
    expect(built).toHaveLength(1);
  });

  it("alerts once reconnects have failed for 15 min, and resolves on reconnect", async () => {
    vi.useFakeTimers();
    vi.mocked(raiseAlert).mockClear();
    vi.mocked(resolveAlert).mockClear();
    expect(await initUserClient({ apiId: 1, apiHash: "h" })).toBe(true);

    built[0].connected = false;
    nextConnect = async () => {
      throw new Error("network down");
    };
    built[0].connect.mockImplementation(() => nextConnect());

    // First failing tick opens the outage; two more keep it open.
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(logWarn).toHaveBeenCalledWith(
      "userbot",
      expect.stringMatching(
        /^userbot\.reconnect\.fail step=re-init attempt=1 down_ms=0 next_check_ms=300000 err=network down$/,
      ),
    );
    await vi.advanceTimersByTimeAsync(TICK_MS * 2);
    expect(raiseAlert).not.toHaveBeenCalled();

    // 15 min after the first failure.
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(raiseAlert).toHaveBeenCalledWith(
      "telegram.userbot",
      expect.stringContaining("failed to reconnect for 15 min: network down"),
      { severity: "warn" },
    );

    nextConnect = async () => {};
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(isUserClientReady()).toBe(true);
    expect(resolveAlert).toHaveBeenCalledWith(
      "telegram.userbot",
      "The Telegram user client is reconnected.",
    );
  });
});
