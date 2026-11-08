/**
 * WhatsApp's half of the frontend lifecycle contract.
 *
 * The connection loop reconnects for the whole process lifetime, so it
 * is the run promise, not the start: `start()` is over once the first
 * socket exists, and `stop()` awaits the loop — which must end on the
 * stop request rather than sitting out its reconnect backoff.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../core/frontend-runtime/admin-notify.js", () => ({
  notifyAdmin: vi.fn(async () => {}),
}));

vi.mock("../frontend/whatsapp/messages/inbound.js", () => ({
  handleInbound: vi.fn(async () => {}),
}));

vi.mock("../frontend/whatsapp/connection/auth-state.js", () => ({
  useAtomicAuthState: vi.fn(async () => ({
    state: { creds: { registered: true, me: { id: "1@s.whatsapp.net" } } },
    saveCreds: vi.fn(),
  })),
  flushAuthWrites: vi.fn(async () => {}),
}));

type ConnectionUpdate = {
  connection?: string;
  qr?: string;
  lastDisconnect?: { error?: { output?: { statusCode?: number } } };
};

/** The slice of a Baileys socket the loop touches. */
class FakeSocket {
  static created: FakeSocket[] = [];
  user = { id: "1@s.whatsapp.net", name: "Talon" };
  private listeners = new Map<string, ((payload: never) => void)[]>();

  constructor() {
    FakeSocket.created.push(this);
  }

  ev = {
    on: (event: string, cb: (payload: never) => void): void => {
      const list = this.listeners.get(event) ?? [];
      list.push(cb);
      this.listeners.set(event, list);
    },
  };

  end(): void {
    this.emitConnection({ connection: "close" });
  }

  emitConnection(update: ConnectionUpdate): void {
    for (const cb of this.listeners.get("connection.update") ?? []) {
      (cb as (payload: ConnectionUpdate) => void)(update);
    }
  }
}

vi.mock("baileys", () => ({
  default: () => new FakeSocket(),
}));

const { runConnectionLoop } =
  await import("../frontend/whatsapp/connection/connection.js");
const { createWhatsAppRuntime } =
  await import("../frontend/whatsapp/runtime.js");

function makeRuntime(): ReturnType<typeof createWhatsAppRuntime> {
  return createWhatsAppRuntime({} as never, {} as never);
}

/** Wait until `check()` holds, or give up — no arbitrary sleeps. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition never held");
}

describe("whatsapp connection loop", () => {
  beforeEach(() => {
    FakeSocket.created = [];
  });

  it("signals readiness as soon as the socket exists, not when it opens", async () => {
    const runtime = makeRuntime();
    let ready = false;
    const loop = runConnectionLoop(runtime, () => {
      ready = true;
    });

    await until(() => ready);
    // Still connecting: nothing has reported "open" yet.
    expect(FakeSocket.created).toHaveLength(1);
    expect(runtime.sock).not.toBeNull();

    runtime.stopping = true;
    runtime.stopRequest.abort();
    FakeSocket.created[0].end();
    await loop;
  });

  it("keeps running after a disconnect, and ends on the stop request", async () => {
    const runtime = makeRuntime();
    const loop = runConnectionLoop(runtime, () => {});
    await until(() => FakeSocket.created.length === 1);

    // A plain close on registered creds is a reconnect: the loop waits
    // out its backoff and comes back with a new socket.
    runtime.reconnectDelay = 20;
    FakeSocket.created[0].emitConnection({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });
    await until(() => FakeSocket.created.length === 2);

    let ended = false;
    void loop.then(() => {
      ended = true;
    });

    // Park the loop in a backoff long enough that only the stop request
    // can get it out.
    runtime.reconnectDelay = 30_000;
    FakeSocket.created[1].emitConnection({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(ended).toBe(false);

    // stop(): the abort wakes the backoff, so the loop stop() awaits
    // ends now instead of half a minute from now.
    const startedAt = Date.now();
    runtime.stopping = true;
    runtime.stopRequest.abort();
    await loop;
    expect(ended).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("ends without opening a socket when stop() lands while auth loads", async () => {
    const { useAtomicAuthState } =
      await import("../frontend/whatsapp/connection/auth-state.js");
    let releaseAuth!: () => void;
    vi.mocked(useAtomicAuthState).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseAuth = () =>
            resolve({
              state: {
                creds: { registered: true, me: { id: "1@s.whatsapp.net" } },
              },
              saveCreds: vi.fn(),
            } as never);
        }),
    );
    const runtime = makeRuntime();
    const loop = runConnectionLoop(runtime, () => {});
    await until(() => releaseAuth !== undefined);

    // stop(): runtime.sock is still null, so there is nothing to end().
    runtime.stopping = true;
    runtime.stopRequest.abort();
    releaseAuth();

    let ended = false;
    void loop.then(() => {
      ended = true;
    });
    await until(() => ended);
    expect(FakeSocket.created).toHaveLength(0);
  });
});
