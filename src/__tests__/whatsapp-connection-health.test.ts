/**
 * WhatsApp connection alerts: `whatsapp.connection` for a socket that
 * keeps dropping (resolved only once a socket stays open), and
 * `whatsapp.linked` for an account that is not linked (resolved when it
 * connects).
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
vi.mock("qrcode-terminal", () => ({ default: { generate: vi.fn() } }));
vi.mock("../frontend/whatsapp/messages/inbound.js", () => ({
  handleInbound: vi.fn(async () => {}),
}));
vi.mock("../frontend/whatsapp/connection/auth-state.js", () => ({
  useAtomicAuthState: vi.fn(async () => ({
    state: { creds: { registered: false, me: { id: "1@s.whatsapp.net" } } },
    saveCreds: vi.fn(),
  })),
}));

type Listener = (update: Record<string, unknown>) => void;

class FakeSocket {
  static created: FakeSocket[] = [];
  user = { id: "1@s.whatsapp.net", name: "Talon" };
  private listeners = new Map<string, Listener[]>();
  constructor() {
    FakeSocket.created.push(this);
  }
  ev = {
    on: (event: string, cb: Listener): void => {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
    },
  };
  emitConnection(update: Record<string, unknown>): void {
    for (const cb of this.listeners.get("connection.update") ?? []) cb(update);
  }
}

vi.mock("baileys", () => ({ default: () => new FakeSocket() }));

const { createConnectionHealth } =
  await import("../frontend/whatsapp/connection/health.js");
const { runConnectionLoop } =
  await import("../frontend/whatsapp/connection/connection.js");
const { createWhatsAppRuntime } =
  await import("../frontend/whatsapp/runtime.js");
const { raiseAlert, resolveAlert } =
  await import("../core/frontend-runtime/alerts.js");
const { log, logWarn } = await import("../util/log.js");

const MIN = 60_000;

beforeEach(() => {
  vi.mocked(raiseAlert).mockClear();
  vi.mocked(resolveAlert).mockClear();
  vi.mocked(log).mockClear();
  vi.mocked(logWarn).mockClear();
});

describe("whatsapp connection health", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("raises after 10 min of drops and resolves once a socket stays open", () => {
    const h = createConnectionHealth();
    h.noteClose("code=428 Connection Closed");
    h.reconnecting(2_000);
    expect(logWarn).toHaveBeenCalledWith(
      "whatsapp",
      "connection.reconnect attempt=1 down_ms=0 backoff_ms=2000 err=code=428 Connection Closed",
    );
    // Flapping: every open dies within the stability window.
    for (let i = 0; i < 9; i++) {
      vi.advanceTimersByTime(MIN - 1);
      h.opened();
      vi.advanceTimersByTime(1);
      h.noteClose("code=500 Stream Errored");
      h.reconnecting(4_000);
    }
    expect(raiseAlert).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MIN);
    expect(raiseAlert).toHaveBeenCalledWith(
      "whatsapp.connection",
      expect.stringContaining(
        "kept dropping for 10 min: code=500 Stream Errored",
      ),
      { severity: undefined },
    );

    h.opened();
    vi.advanceTimersByTime(MIN - 1);
    expect(resolveAlert).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(resolveAlert).toHaveBeenCalledWith(
      "whatsapp.connection",
      "The WhatsApp connection is stable again.",
    );
  });

  it("does not raise for a single reconnect, nor count a close nobody noted", () => {
    const h = createConnectionHealth();
    h.reconnecting(2_000); // 515 after pairing: no noteClose
    expect(logWarn).not.toHaveBeenCalled();
    h.noteClose("code=408");
    h.reconnecting(2_000);
    h.opened();
    vi.advanceTimersByTime(20 * MIN);
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it("dispose (park / shutdown) drops a pending raise", () => {
    const h = createConnectionHealth();
    h.noteClose("x");
    h.reconnecting(2_000);
    h.dispose();
    vi.advanceTimersByTime(20 * MIN);
    expect(raiseAlert).not.toHaveBeenCalled();
  });
});

describe("whatsapp.linked", () => {
  it("raises when a QR is offered and resolves when the account connects", async () => {
    FakeSocket.created = [];
    const runtime = createWhatsAppRuntime({} as never, {} as never);
    const loop = runConnectionLoop(runtime, () => {});
    for (let i = 0; i < 200 && FakeSocket.created.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const sock = FakeSocket.created[0];

    sock.emitConnection({ qr: "qr-1" });
    sock.emitConnection({ qr: "qr-2" });
    expect(raiseAlert).toHaveBeenCalledTimes(1);
    expect(raiseAlert).toHaveBeenCalledWith(
      "whatsapp.linked",
      "WhatsApp is not linked. Send /whatsapp pair when you're ready and I'll reply with a QR to scan.",
      { severity: "warn" },
    );

    sock.emitConnection({ connection: "open" });
    expect(resolveAlert).toHaveBeenCalledWith(
      "whatsapp.linked",
      "WhatsApp linked and connected.",
    );

    runtime.stopping = true;
    runtime.stopRequest.abort();
    sock.emitConnection({ connection: "close" });
    await loop;
  });
});
