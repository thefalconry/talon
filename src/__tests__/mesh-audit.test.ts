/**
 * Mesh command audit — the ring file (core/mesh/audit.ts), its wiring into
 * every MeshService.sendCommand, the loopback gateway route, and the
 * `talon mesh audit` flag parser.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logWarn } from "../util/log.js";
import {
  hashCommandArgs,
  MeshAuditLog,
  type MeshAuditEntry,
} from "../core/mesh/audit.js";
import { MeshRegistry, MeshService } from "../core/mesh/index.js";
import { setMeshService } from "../core/mesh/devices/service.js";
import { dispatchGatewayRoute } from "../core/engine/gateway-routes.js";
import {
  closeTurnScope,
  createTurnScope,
  runInTurnScope,
} from "../util/logging/turn-scope.js";
import { parseAuditArgs } from "../cli/commands/mesh-audit.js";
import { gatewayFetch, TEST_GATEWAY_TOKEN } from "./helpers/gateway-fetch.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "talon-mesh-audit-"));
}

function entry(overrides: Partial<MeshAuditEntry> = {}): MeshAuditEntry {
  return {
    time: new Date(0).toISOString(),
    issuer: null,
    deviceId: "phone",
    deviceName: "Pixel 9",
    command: "status",
    argsHash: hashCommandArgs({}),
    ok: true,
    durationMs: 5,
    ...overrides,
  };
}

describe("hashCommandArgs", () => {
  it("is independent of key order at every depth", () => {
    expect(hashCommandArgs({ a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } })).toBe(
      hashCommandArgs({ b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 }),
    );
  });

  it("changes with any value and is a sha256 hex digest", () => {
    const a = hashCommandArgs({ cmd: "ls" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCommandArgs({ cmd: "ls -la" })).not.toBe(a);
    expect(hashCommandArgs(undefined)).toBe(hashCommandArgs({}));
  });

  it("keeps a __proto__ key as data", () => {
    const params = JSON.parse('{"__proto__": {"x": 1}}') as Record<
      string,
      unknown
    >;
    expect(hashCommandArgs(params)).not.toBe(hashCommandArgs({}));
  });
});

describe("MeshAuditLog", () => {
  it("appends JSON lines to a 0600 file and reads them back, oldest first", async () => {
    const file = join(await tempDir(), "data", "mesh-audit.jsonl");
    const log = new MeshAuditLog(file);
    log.record(entry({ command: "a" }));
    log.record(entry({ command: "b" }));
    log.record(entry({ command: "c" }));
    await log.flush();
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    expect((await log.read()).map((e) => e.command)).toEqual(["a", "b", "c"]);
    expect((await log.read({ limit: 2 })).map((e) => e.command)).toEqual([
      "b",
      "c",
    ]);
  });

  it("rotates at the cap, keeping one previous generation", async () => {
    const file = join(await tempDir(), "mesh-audit.jsonl");
    const lineBytes = `${JSON.stringify(entry({ command: "x00" }))}\n`.length;
    const log = new MeshAuditLog(file, lineBytes * 3);
    for (let i = 0; i < 10; i++) {
      log.record(entry({ command: `x${String(i).padStart(2, "0")}` }));
    }
    await log.flush();
    expect((await stat(file)).size).toBeLessThanOrEqual(lineBytes * 3);
    expect((await stat(`${file}.1`)).size).toBeLessThanOrEqual(lineBytes * 3);
    // 10 lines, 3 per generation: x00–x05 rotated away, x06–x08 in .1, x09 live.
    expect((await log.read({ limit: 100 })).map((e) => e.command)).toEqual([
      "x06",
      "x07",
      "x08",
      "x09",
    ]);
  });

  it("filters by device id or name and skips torn lines", async () => {
    const file = join(await tempDir(), "mesh-audit.jsonl");
    await writeFile(
      file,
      `${JSON.stringify(entry({ deviceId: "phone" }))}\n{"torn":\n` +
        `${JSON.stringify(entry({ deviceId: "box", deviceName: "Build Box" }))}\n`,
    );
    const log = new MeshAuditLog(file);
    expect(await log.read({ device: "box" })).toHaveLength(1);
    expect(await log.read({ device: "build" })).toHaveLength(1);
    expect(await log.read({ device: "PIXEL" })).toHaveLength(1);
    expect(await log.read()).toHaveLength(2);
  });

  it("never throws when the file can't be written, and logs once", async () => {
    const dir = await tempDir();
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "");
    const log = new MeshAuditLog(join(blocker, "mesh-audit.jsonl"));
    vi.mocked(logWarn).mockClear();
    expect(() => {
      log.record(entry());
      log.record(entry());
    }).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();
    const warnings = vi
      .mocked(logWarn)
      .mock.calls.filter((c) => String(c[1]).includes("mesh.audit"));
    expect(warnings).toHaveLength(1);
    expect(await log.read()).toEqual([]);
  });
});

// ── Wiring into sendCommand ─────────────────────────────────────────────────

async function serviceWithAudit(
  audit: MeshAuditLog | { record: () => never; read: () => never },
  answer: "ok" | "fail" | "silent" = "ok",
): Promise<MeshService> {
  const dir = await tempDir();
  const service = new MeshService(
    new MeshRegistry({
      devices: join(dir, "devices.json"),
      locations: join(dir, "locations.json"),
      history: join(dir, "history.json"),
    }),
    { audit: audit as MeshAuditLog },
  );
  await service.register({
    id: "phone",
    name: "Pixel 9",
    platform: "android",
    appVersion: "1.0.0",
  });
  service.registerTransport({
    locate: () => {},
    command: (cmd) => {
      if (answer === "silent") return;
      queueMicrotask(() =>
        service.completeCommand({
          commandId: cmd.id,
          deviceId: cmd.deviceId,
          ok: answer === "ok",
          ...(answer === "ok"
            ? { data: { stdout: "hi" } }
            : { message: "exit 1: permission denied\nsecond line" }),
        }),
      );
    },
  });
  return service;
}

describe("sendCommand audit", () => {
  it("records every dispatch with an args hash and never the args", async () => {
    const file = join(await tempDir(), "mesh-audit.jsonl");
    const audit = new MeshAuditLog(file);
    const service = await serviceWithAudit(audit);
    const params = { cmd: "cat /etc/secret-token-xyz", cwd: "/root" };
    const result = await service.sendCommand(
      service.chooseDevice("phone")!,
      "exec",
      params,
    );
    expect(result.ok).toBe(true);
    const [recorded] = await audit.read();
    expect(recorded).toMatchObject({
      issuer: null,
      deviceId: "phone",
      deviceName: "Pixel 9",
      command: "exec",
      argsHash: hashCommandArgs(params),
      ok: true,
    });
    expect(recorded!.error).toBeUndefined();
    expect(recorded!.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(recorded!.time)).not.toBeNaN();
    expect(await readFile(file, "utf8")).not.toContain("secret-token-xyz");
  });

  it("names the issuing turn, chat and sender", async () => {
    const audit = new MeshAuditLog(join(await tempDir(), "a.jsonl"));
    const service = await serviceWithAudit(audit);
    const scope = createTurnScope("chat-7", {
      sender: "12345",
      source: "cron",
    });
    await runInTurnScope(scope, () =>
      service.sendCommand(service.chooseDevice("phone")!, "status", {}),
    );
    closeTurnScope(scope);
    const [recorded] = await audit.read();
    expect(recorded!.issuer).toEqual({
      chatId: "chat-7",
      turnId: scope.turnId,
      sender: "12345",
      source: "cron",
    });
  });

  it("records failures and timeouts with a one-line reason", async () => {
    const audit = new MeshAuditLog(join(await tempDir(), "a.jsonl"));
    const failing = await serviceWithAudit(audit, "fail");
    await failing.sendCommand(failing.chooseDevice("phone")!, "exec", {});
    const silent = await serviceWithAudit(audit, "silent");
    await silent.sendCommand(silent.chooseDevice("phone")!, "exec", {}, 50);
    const [failed, timedOut] = await audit.read();
    expect(failed).toMatchObject({
      ok: false,
      error: "exit 1: permission denied",
    });
    expect(timedOut).toMatchObject({ ok: false });
    expect(timedOut!.error).toContain("did not answer");
  });

  it("never lets a broken audit break the command", async () => {
    const broken = {
      record: () => {
        throw new Error("disk on fire");
      },
      read: () => {
        throw new Error("unused");
      },
    } as unknown as { record: () => never; read: () => never };
    const service = await serviceWithAudit(broken);
    const result = await service.sendCommand(
      service.chooseDevice("phone")!,
      "status",
      {},
    );
    expect(result.ok).toBe(true);
  });
});

// ── Gateway + CLI ───────────────────────────────────────────────────────────

describe("gateway /mesh/audit", () => {
  let server: Server | undefined;
  afterEach(async () => {
    setMeshService(null);
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  async function start(audit: MeshAuditLog): Promise<number> {
    const dir = await tempDir();
    setMeshService(
      new MeshService(
        new MeshRegistry({
          devices: join(dir, "devices.json"),
          locations: join(dir, "locations.json"),
          history: join(dir, "history.json"),
        }),
        { audit },
      ),
    );
    let boundPort = 0;
    const host = {
      healthSnapshot: () => ({}),
      requestShutdown: () => false,
      reloadPlugins: async () => [],
      hubOrigin: () => "",
      handleAction: async () => ({}),
      port: () => boundPort,
      token: () => TEST_GATEWAY_TOKEN,
    };
    server = createServer(
      (req, res) => void dispatchGatewayRoute(req, res, host),
    );
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    boundPort = (server.address() as { port: number }).port;
    return boundPort;
  }

  it("serves the newest entries, filtered, to the operator only", async () => {
    const audit = new MeshAuditLog(join(await tempDir(), "a.jsonl"));
    audit.record(entry({ command: "one" }));
    audit.record(entry({ command: "two", deviceId: "box", deviceName: "Box" }));
    audit.record(entry({ command: "three" }));
    const port = await start(audit);
    const base = `http://127.0.0.1:${port}/mesh/audit`;

    const all = (await (await gatewayFetch(base)).json()) as {
      entries: MeshAuditEntry[];
    };
    expect(all.entries.map((e) => e.command)).toEqual(["one", "two", "three"]);
    const limited = (await (
      await gatewayFetch(`${base}?limit=1&device=phone`)
    ).json()) as { entries: MeshAuditEntry[] };
    expect(limited.entries.map((e) => e.command)).toEqual(["three"]);

    expect((await fetch(base)).status).toBe(401);
    const fromPage = await gatewayFetch(base, {
      headers: { Origin: "https://evil.example" },
    });
    expect(fromPage.status).toBe(403);
  });
});

describe("talon mesh audit flags", () => {
  it("parses --limit and --device in both spellings", () => {
    expect(parseAuditArgs([])).toEqual({});
    expect(parseAuditArgs(["--limit", "5", "--device=Pixel 9"])).toEqual({
      limit: 5,
      device: "Pixel 9",
    });
    expect(parseAuditArgs(["--limit=20", "--device", "box"])).toEqual({
      limit: 20,
      device: "box",
    });
  });

  it("rejects bad input with a reason", () => {
    expect(parseAuditArgs(["--limit", "0"])).toMatch(/positive integer/);
    expect(parseAuditArgs(["--limit"])).toMatch(/needs a value/);
    expect(parseAuditArgs(["--verbose"])).toMatch(/Unknown option: --verbose/);
  });
});
