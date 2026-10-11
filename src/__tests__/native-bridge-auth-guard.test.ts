import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { request, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { log, logDebug, logWarn } from "../util/log.js";
import { AuthGuard } from "../frontend/native/bridge/auth-guard.js";
import {
  checkBridgeTokenStrength,
  estimateTokenBits,
  loadOrCreateBridgeToken,
  MIN_TOKEN_BITS,
} from "../frontend/native/bridge/auth.js";
import {
  BridgeServer,
  DEFAULT_BRIDGE_TIMEOUTS,
  type BridgeServerHandlers,
} from "../frontend/native/bridge/server.js";

/** Every log line the mocked logger saw, flattened to strings. */
function loggedText(): string {
  return [log, logWarn, logDebug]
    .flatMap((fn) => vi.mocked(fn).mock.calls)
    .map((call) => call.join(" "))
    .join("\n");
}

// ── Token strength ──────────────────────────────────────────────────────────

describe("bridge token strength", () => {
  afterEach(() => vi.mocked(logWarn).mockClear());

  it("rates short, human-chosen and degenerate tokens as weak", () => {
    for (const weak of [
      "hunter2",
      "changeme",
      "correcthorsebatterystaple",
      "P@ssw0rd!2024",
      "a".repeat(200),
      "abababababababababababababababababababab",
      "1234567890123456789012345678",
      "",
    ]) {
      expect(estimateTokenBits(weak), weak).toBeLessThan(MIN_TOKEN_BITS);
    }
  });

  it("rates random hex, base64 and base64url tokens as strong", () => {
    const samples = [
      randomBytes(16).toString("hex"), // exactly 128 bits
      randomBytes(32).toString("hex"),
      randomBytes(32).toString("base64"),
      randomBytes(32).toString("base64url"),
      randomBytes(24).toString("base64url"),
    ];
    for (const strong of samples) {
      expect(estimateTokenBits(strong), strong).toBeGreaterThanOrEqual(
        MIN_TOKEN_BITS,
      );
    }
  });

  it("the token Talon generates always clears the bar", async () => {
    for (let i = 0; i < 20; i++) {
      const dir = await mkdtemp(join(tmpdir(), "talon-auth-strength-"));
      expect(estimateTokenBits(loadOrCreateBridgeToken(dir))).toBeGreaterThan(
        MIN_TOKEN_BITS,
      );
    }
  });

  it("refuses a weak token on a network bind, without echoing it", () => {
    let message = "";
    try {
      checkBridgeTokenStrength({ token: "hunter2", loopback: false });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/Refusing to start the bridge/);
    expect(message).toMatch(/allowWeakToken/);
    expect(message).toMatch(/openssl rand -hex 32/);
    expect(message).not.toContain("hunter2");
  });

  it("allows a weak token on a network bind only with the override, loudly", () => {
    expect(() =>
      checkBridgeTokenStrength({
        token: "hunter2",
        loopback: false,
        allowWeakToken: true,
      }),
    ).not.toThrow();
    expect(vi.mocked(logWarn).mock.calls[0]?.[1]).toMatch(/^SECURITY:/);
    expect(loggedText()).not.toContain("hunter2");
  });

  it("only warns about a weak token on loopback", () => {
    expect(() =>
      checkBridgeTokenStrength({ token: "hunter2", loopback: true }),
    ).not.toThrow();
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("says nothing about a strong token or no token", () => {
    checkBridgeTokenStrength({
      token: randomBytes(32).toString("base64url"),
      loopback: false,
    });
    checkBridgeTokenStrength({ token: undefined, loopback: false });
    expect(logWarn).not.toHaveBeenCalled();
  });
});

// ── Guard policy (fake clock) ───────────────────────────────────────────────

describe("auth guard", () => {
  function guardAt(policy: ConstructorParameters<typeof AuthGuard>[0] = {}) {
    let now = 1_000_000;
    const alerts: string[] = [];
    const guard = new AuthGuard(policy, {
      now: () => now,
      onAlert: (m) => alerts.push(m),
    });
    return {
      guard,
      alerts,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  const delayOf = (v: ReturnType<AuthGuard["check"]>): number =>
    v.kind === "delay" ? v.ms : v.kind === "allow" ? 0 : -1;

  it("backs off exponentially after the free misses, capped", () => {
    const { guard } = guardAt();
    const delays = Array.from({ length: 10 }, () =>
      delayOf(guard.check("1.2.3.4", "bad")),
    );
    expect(delays).toEqual([
      0, 0, 250, 500, 1000, 2000, 4000, 8000, 8000, 8000,
    ]);
  });

  it("never delays a correct token, and a success resets the backoff", () => {
    const { guard } = guardAt();
    for (let i = 0; i < 6; i++) guard.check("1.2.3.4", "bad");
    expect(guard.check("1.2.3.4", "ok")).toEqual({ kind: "allow" });
    expect(delayOf(guard.check("1.2.3.4", "bad"))).toBe(0);
  });

  it("forgets an address's failures once the window lapses", () => {
    const { guard, advance } = guardAt();
    for (let i = 0; i < 6; i++) guard.check("1.2.3.4", "bad");
    advance(15 * 60_000);
    expect(delayOf(guard.check("1.2.3.4", "bad"))).toBe(0);
  });

  it("keeps backoff per address", () => {
    const { guard } = guardAt();
    for (let i = 0; i < 6; i++) guard.check("1.2.3.4", "bad");
    expect(delayOf(guard.check("5.6.7.8", "bad"))).toBe(0);
  });

  it("locks an address out after the limit, even with the right shared token", () => {
    const { guard } = guardAt({ lockoutMaxFailures: 3, backoffBaseMs: 0 });
    for (let i = 0; i < 3; i++) guard.check("1.2.3.4", "bad");
    const locked = guard.check("1.2.3.4", "ok");
    expect(locked).toMatchObject({ kind: "reject", reason: "lockout" });
    expect(locked.kind === "reject" && locked.retryAfterSec).toBeGreaterThan(0);
    expect(loggedText()).toMatch(/bridge\.auth event=lockout addr=1\.2\.3\.4/);
  });

  it("never refuses a valid per-device credential from a locked address", () => {
    const { guard } = guardAt({ lockoutMaxFailures: 3, backoffBaseMs: 0 });
    for (let i = 0; i < 3; i++) guard.check("1.2.3.4", "bad");
    expect(guard.check("1.2.3.4", "ok", null, true)).toEqual({
      kind: "allow",
    });
    // The device's success doesn't lift the lockout for whoever tripped it:
    // the shared token and further guesses from there are still refused.
    expect(guard.check("1.2.3.4", "ok")).toMatchObject({
      kind: "reject",
      reason: "lockout",
    });
    expect(guard.check("1.2.3.4", "bad")).toMatchObject({
      kind: "reject",
      reason: "lockout",
    });
  });

  it("caps the number of tracked addresses", () => {
    const { guard } = guardAt({ maxTracked: 3, globalMaxFailures: 1_000 });
    for (let i = 0; i < 50; i++) {
      guard.check(`10.0.0.${i}`, "bad");
      guard.check(`10.0.0.${i}`, "bad");
      guard.check(`10.0.0.${i}`, "bad");
    }
    expect(guard.trackedCount()).toBe(3);
    // An untracked address gets no backoff state (and so no delay).
    expect(delayOf(guard.check("10.0.0.49", "bad"))).toBe(0);
    expect(loggedText()).toMatch(/event=tracking_saturated/);
  });

  it("enters a global cooldown on distributed guessing without blocking valid auth", () => {
    const { guard, alerts, advance } = guardAt({
      globalMaxFailures: 5,
      globalCooldownMs: 60_000,
      cooldownAnonDelayMs: 700,
    });
    // One wrong token each from six addresses: no per-address limit trips,
    // but the sixth takes the total past the budget of five.
    for (let i = 0; i < 5; i++) guard.check(`10.1.0.${i}`, "bad");
    expect(guard.inCooldown()).toBe(false);
    expect(alerts).toHaveLength(0);
    guard.check("10.1.0.5", "bad");
    expect(guard.inCooldown()).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(loggedText()).toMatch(/bridge\.auth event=global_cooldown /);

    expect(guard.check("10.9.9.9", "bad")).toMatchObject({
      kind: "reject",
      reason: "cooldown",
    });
    expect(guard.check("10.9.9.9", "anonymous")).toEqual({
      kind: "delay",
      ms: 700,
    });
    expect(guard.check("10.8.8.8", "ok")).toEqual({ kind: "allow" });

    // More failures during the cooldown don't re-alert.
    for (let i = 0; i < 20; i++) guard.check(`10.2.0.${i}`, "bad");
    expect(alerts).toHaveLength(1);

    advance(61_000);
    expect(guard.inCooldown()).toBe(false);
    expect(guard.check("10.7.7.7", "anonymous")).toEqual({ kind: "allow" });
    expect(loggedText()).toMatch(/event=global_cooldown_end/);
  });

  it("backs off per credential id across addresses", () => {
    const { guard } = guardAt();
    const cred = "device-one";
    // A fresh address per guess: per-address backoff never engages, the
    // credential's does.
    const delays = Array.from({ length: 8 }, (_, i) =>
      delayOf(guard.check(`10.3.0.${i}`, "bad", cred)),
    );
    expect(delays).toEqual([0, 0, 250, 500, 1000, 2000, 4000, 8000]);
    expect(loggedText()).toMatch(
      /event=failure addr=10\.3\.0\.7 reason=bad_token failures=1 credential=device-one credentialFailures=8/,
    );
    // Another credential, and guesses naming no credential, are unaffected.
    expect(delayOf(guard.check("10.3.1.0", "bad", "device-two"))).toBe(0);
    expect(delayOf(guard.check("10.3.1.1", "bad"))).toBe(0);
  });

  it("never locks a credential out: the real one is never delayed or refused", () => {
    const { guard } = guardAt({ lockoutMaxFailures: 3 });
    const cred = "device-one";
    for (let i = 0; i < 50; i++) guard.check(`10.4.0.${i}`, "bad", cred);
    expect(guard.check("10.4.9.9", "ok")).toEqual({ kind: "allow" });
    // ...and its success doesn't hand the guesser a fresh budget.
    expect(delayOf(guard.check("10.4.1.0", "bad", cred))).toBe(8000);
  });

  it("forgets a credential's failures once the window lapses", () => {
    const { guard, advance } = guardAt();
    const cred = "device-one";
    for (let i = 0; i < 6; i++) guard.check(`10.5.0.${i}`, "bad", cred);
    advance(15 * 60_000);
    expect(delayOf(guard.check("10.5.1.0", "bad", cred))).toBe(0);
  });

  it("caps the number of tracked credential ids", () => {
    const { guard } = guardAt({ maxTracked: 3, globalMaxFailures: 1_000 });
    for (let i = 0; i < 20; i++) {
      guard.check("10.6.0.1", "bad", `${i}`.padStart(16, "0"));
    }
    expect(guard.trackedCredentialCount()).toBe(3);
    expect(loggedText()).toMatch(
      /event=tracking_saturated reason=credential_cap/,
    );
  });

  it("refuses to hold more than maxPendingDelays responses at once", async () => {
    const guard = new AuthGuard({ maxPendingDelays: 1 });
    const first = guard.hold(50);
    expect(await guard.hold(50)).toBe(false);
    expect(await first).toBe(true);
    expect(await guard.hold(1)).toBe(true);
  });
});

// ── Over the wire ───────────────────────────────────────────────────────────

const handlers = new Proxy(
  {},
  {
    get: (_target, key) => {
      if (key === "status")
        return () => ({
          app: "talon-bridge",
          protocol: 1,
          botName: "Talon",
          backend: "test",
          model: "m1",
          activeChats: 0,
          startedAt: "now",
        });
      if (key === "listChats" || key === "liveTurnEvents") return () => [];
      return () => undefined;
    },
  },
) as BridgeServerHandlers;

describe("bridge server auth hardening", () => {
  let server: BridgeServer | null = null;
  const token = randomBytes(32).toString("base64url");

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  async function start(
    extra: Partial<ConstructorParameters<typeof BridgeServer>[0]> = {},
  ): Promise<number> {
    server = new BridgeServer(
      { host: "127.0.0.1", port: 0, token, startedAt: "boot", ...extra },
      handlers,
    );
    return server.start();
  }

  const get = (port: number, path: string, bearer?: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    });

  async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
    const t0 = Date.now();
    const out = await fn();
    return [out, Date.now() - t0];
  }

  it("refuses to start on a network bind with a weak token", async () => {
    server = new BridgeServer(
      { host: "0.0.0.0", port: 0, token: "hunter2", startedAt: "boot" },
      handlers,
    );
    await expect(server.start()).rejects.toThrow(/allowWeakToken/);
  });

  it("starts on a network bind with a weak token when allowed", async () => {
    server = new BridgeServer(
      {
        host: "0.0.0.0",
        port: 0,
        token: "hunter2",
        startedAt: "boot",
        allowWeakToken: true,
      },
      handlers,
    );
    expect(await server.start()).toBeGreaterThan(0);
  });

  it("delays wrong-token 401s but never a correct token", async () => {
    const port = await start({
      authPolicy: { freeFailures: 0, backoffBaseMs: 300 },
    });
    const [bad, badMs] = await timed(() => get(port, "/chats", "wrong"));
    expect(bad.status).toBe(401);
    expect(badMs).toBeGreaterThanOrEqual(250);
    const [ok, okMs] = await timed(() => get(port, "/chats", token));
    expect(ok.status).toBe(200);
    expect(okMs).toBeLessThan(250);
    expect(loggedText()).not.toContain(token);
    expect(loggedText()).not.toMatch(/wrong/);
  });

  it("keeps valid auth working through a global cooldown", async () => {
    const port = await start({
      authPolicy: {
        backoffBaseMs: 0,
        globalMaxFailures: 3,
        cooldownAnonDelayMs: 300,
      },
    });
    for (let i = 0; i < 3; i++) {
      expect((await get(port, "/chats", "wrong")).status).toBe(401);
    }
    const refused = await get(port, "/chats", "wrong");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);

    const [ok, okMs] = await timed(() => get(port, "/chats", token));
    expect(ok.status).toBe(200);
    expect(okMs).toBeLessThan(250);

    const [anon, anonMs] = await timed(() => get(port, "/health"));
    expect(anon.status).toBe(200);
    expect(anonMs).toBeGreaterThanOrEqual(250);
  });

  it("takes ?token= only on GET /events and GET /media", async () => {
    const port = await start();
    const q = `token=${encodeURIComponent(token)}`;
    // Elsewhere a query token is ignored: the request reads as tokenless.
    expect((await get(port, `/chats?${q}`)).status).toBe(401);
    expect((await get(port, `/devices?${q}`)).status).toBe(401);
    expect((await get(port, `/logs?${q}`)).status).toBe(401);
    // ...while the header works everywhere.
    expect((await get(port, "/chats", token)).status).toBe(200);
    // /health answers, but only its public (pre-token) view.
    const health = (await (await get(port, `/health?${q}`)).json()) as Record<
      string,
      unknown
    >;
    const authed = (await (await get(port, "/health", token)).json()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(health).length).toBeLessThan(Object.keys(authed).length);

    // Media authorizes (404: no such id, not 401).
    expect((await get(port, `/media?id=x&${q}`)).status).toBe(404);
    expect((await get(port, "/media?id=x")).status).toBe(401);
    // The event stream authorizes.
    const controller = new AbortController();
    const events = await fetch(`http://127.0.0.1:${port}/events?${q}`, {
      signal: controller.signal,
    });
    expect(events.status).toBe(200);
    controller.abort();
  });

  it("counts a refused per-device credential against its id", async () => {
    const port = await start();
    const cred = "0123456789abcdef";
    const wrong = `tdc1.${cred}.${randomBytes(32).toString("base64url")}`;
    expect((await get(port, "/chats", wrong)).status).toBe(401);
    expect(loggedText()).toContain(`credential=${cred} credentialFailures=1`);
    expect(loggedText()).not.toContain(wrong);
  });

  it("closes the connection on an auth refusal", async () => {
    const port = await start();
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      request({ host: "127.0.0.1", port, path: "/chats" }, resolve)
        .on("error", reject)
        .end();
    });
    res.resume();
    expect(res.statusCode).toBe(401);
    expect(res.headers.connection).toBe("close");
  });

  it("configures server-level socket deadlines", async () => {
    await start();
    const http = (server as unknown as { server: Server }).server;
    expect(http.headersTimeout).toBe(DEFAULT_BRIDGE_TIMEOUTS.headersMs);
    expect(http.requestTimeout).toBe(DEFAULT_BRIDGE_TIMEOUTS.requestMs);
    expect(http.keepAliveTimeout).toBe(DEFAULT_BRIDGE_TIMEOUTS.keepAliveMs);
    // Tighter than Node's 60s default; generous enough for a 512 MB upload.
    expect(DEFAULT_BRIDGE_TIMEOUTS.headersMs).toBeLessThan(60_000);
    expect(DEFAULT_BRIDGE_TIMEOUTS.requestMs).toBeGreaterThanOrEqual(
      30 * 60_000,
    );
  });

  const fastTimeouts = {
    headersMs: 300,
    requestMs: 500,
    keepAliveMs: 200,
    checkIntervalMs: 100,
  };

  // Bun's node:http accepts but ignores headersTimeout; its native HTTP
  // layer instead drops a connection idle mid-headers after ~10s. Node-only.
  it.skipIf(typeof process.versions.bun === "string")(
    "drops a client that never finishes its headers",
    async () => {
      const port = await start({ timeouts: fastTimeouts });
      const [reply, ms] = await timed(
        () =>
          new Promise<string>((resolve, reject) => {
            let data = "";
            const sock = connect(port, "127.0.0.1", () => {
              sock.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n");
            });
            sock.on("data", (d) => (data += d.toString()));
            sock.on("close", () => resolve(data));
            sock.on("error", reject);
            setTimeout(() => sock.destroy(), 5_000).unref();
          }),
      );
      expect(reply).toMatch(/^HTTP\/1\.1 408/);
      expect(ms).toBeLessThan(3_000);
    },
  );

  it("keeps an SSE stream open well past the request timeout", async () => {
    const port = await start({ timeouts: fastTimeouts });
    const received = await new Promise<string>((resolve, reject) => {
      let data = "";
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: `/events?token=${encodeURIComponent(token)}`,
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          res.on("data", (d: Buffer) => {
            data += d.toString();
            if (data.includes('"kind":"typing"')) {
              req.destroy();
              resolve(data);
            }
          });
          res.on("close", () => resolve(data));
        },
      );
      req.on("error", reject);
      req.end();
      // Well past requestMs (500) and several deadline sweeps.
      setTimeout(
        () => server?.broadcast({ kind: "typing", chatId: "c1", on: true }),
        1_500,
      );
    });
    expect(received).toContain('"kind":"typing"');
  });

  it("ends an SSE stream at its max lifetime when configured", async () => {
    const port = await start({ sseMaxLifetimeMs: 200 });
    const [, ms] = await timed(
      () =>
        new Promise<void>((resolve, reject) => {
          request(
            {
              host: "127.0.0.1",
              port,
              path: `/events?token=${encodeURIComponent(token)}`,
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve());
            },
          )
            .on("error", reject)
            .end();
        }),
    );
    expect(ms).toBeLessThan(2_000);
  });

  it("survives a broadcast after a backed-up stream hits its max lifetime", async () => {
    const port = await start({ sseMaxLifetimeMs: 200 });
    // A client that stopped reading (phone asleep): its unsent backlog keeps
    // the stream open past the end() the lifetime timer issues.
    const sock = connect(port, "127.0.0.1");
    sock.on("error", () => {});
    await new Promise<void>((resolve) => sock.once("connect", resolve));
    sock.write(
      `GET /events?token=${encodeURIComponent(token)} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`,
    );
    sock.pause();
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await wait(100);
    const bulk = "x".repeat(64 * 1024);
    for (let i = 0; i < 100; i++) {
      server!.broadcast({ kind: "delta", chatId: "c1", text: bulk });
    }
    await wait(500); // past the (jittered) 200ms lifetime

    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.prependListener("uncaughtException", onUncaught);
    try {
      server!.broadcast({ kind: "typing", chatId: "c1", on: true });
      await wait(100);
    } finally {
      process.off("uncaughtException", onUncaught);
      sock.destroy();
    }
    expect(uncaught).toEqual([]);
  });
});
