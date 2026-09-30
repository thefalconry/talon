/**
 * Per-device mesh credentials — the store, the operator surface, and how
 * the mesh uses them (pairing links, installers, remove_device).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceCredentialStore,
  credentialAdmin,
  credentialOverview,
  isDeviceCredentialToken,
  DEFAULT_COMPANION_SCOPES,
  FORMER_COMPANION_SCOPES,
  type CredentialAdminContext,
} from "../core/mesh/credentials/index.js";
import { MeshRegistry, MeshService } from "../core/mesh/index.js";
import { setMeshService } from "../core/mesh/devices/service.js";
import { dispatchGatewayRoute } from "../core/engine/gateway-routes.js";
import { gatewayFetch, TEST_GATEWAY_TOKEN } from "./helpers/gateway-fetch.js";

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "talon-mesh-creds-"));
  return join(dir, name);
}

async function tempStore(now?: () => number): Promise<{
  store: DeviceCredentialStore;
  file: string;
}> {
  const file = await tempFile("credentials.json");
  return { store: new DeviceCredentialStore(file, now), file };
}

/** Let fire-and-forget persistence settle. */
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("DeviceCredentialStore", () => {
  it("mints a tdc1 token, stores only its hash, and authenticates it", async () => {
    const { store, file } = await tempStore();
    const { token, credential } = await store.mint({
      deviceId: "phone",
      scopes: ["device", "client"],
      origin: "upgrade",
    });
    expect(isDeviceCredentialToken(token)).toBe(true);
    expect(token.split(".")[1]).toBe(credential.id);
    const onDisk = await readFile(file, "utf8");
    expect(onDisk).not.toContain(token.split(".")[2]);
    expect(onDisk).toContain(credential.id);
    expect((credential as Record<string, unknown>).tokenHash).toBeUndefined();

    const auth = store.authenticate(token);
    expect(auth).toMatchObject({
      id: credential.id,
      deviceId: "phone",
      scopes: ["device", "client"],
    });
    expect(auth?.lastUsedAt).toBeTypeOf("number");
  });

  it("rejects wrong secrets, unknown ids and malformed tokens", async () => {
    const { store } = await tempStore();
    const { token } = await store.mint({
      deviceId: "a",
      scopes: ["device"],
      origin: "upgrade",
    });
    const [p, id, secret] = token.split(".");
    const flipped = `${p}.${id}.${secret!.startsWith("A") ? "B" : "A"}${secret!.slice(1)}`;
    expect(store.authenticate(flipped)).toBeNull();
    expect(store.authenticate(`tdc1.0000000000000000.${secret}`)).toBeNull();
    expect(store.authenticate("shared-token")).toBeNull();
    expect(store.authenticate("")).toBeNull();
  });

  it("drops unknown scopes and refuses a credential with none", async () => {
    const { store } = await tempStore();
    const { credential } = await store.mint({
      deviceId: "a",
      scopes: ["client", "bogus" as never, "device", "client"],
      origin: "upgrade",
    });
    expect(credential.scopes).toEqual(["device", "client"]);
    await expect(
      store.mint({ deviceId: "b", scopes: [], origin: "upgrade" }),
    ).rejects.toThrow(/scope/);
  });

  it("revocation fails authentication and notifies listeners", async () => {
    const { store } = await tempStore();
    const { token, credential } = await store.mint({
      deviceId: "a",
      scopes: ["device"],
      origin: "upgrade",
    });
    const seen: string[][] = [];
    store.onRevoked((ids) => seen.push([...ids]));
    const revoked = await store.revokeDevice("a", "lost laptop");
    expect(revoked.map((c) => c.id)).toEqual([credential.id]);
    expect(seen).toEqual([[credential.id]]);
    expect(store.authenticate(token)).toBeNull();
    expect(store.list()[0]).toMatchObject({ revokeReason: "lost laptop" });
  });

  it("survives a restart: rows reload from disk", async () => {
    const { store, file } = await tempStore();
    const { token } = await store.mint({
      deviceId: "node-1",
      scopes: ["device"],
      origin: "install",
    });
    const reloaded = new DeviceCredentialStore(file);
    await reloaded.load();
    expect(reloaded.authenticate(token)?.deviceId).toBe("node-1");
  });

  it("binds an unbound credential once, and never over a device holding wider scopes", async () => {
    const { store } = await tempStore();
    await store.mint({
      deviceId: "taken",
      scopes: ["device", "client", "operator"],
      origin: "upgrade",
    });
    const pair = store.mintNow({
      deviceId: null,
      scopes: ["device", "client"],
      origin: "pair",
    });
    const id = pair.credential.id;
    expect(store.bind(id, "taken")).toMatchObject({ ok: false });
    expect(store.bind(id, "phone")).toMatchObject({ ok: true });
    expect(store.bind(id, "phone")).toMatchObject({ ok: true });
    expect(store.bind(id, "other")).toMatchObject({ ok: false });
    expect(store.authenticate(pair.token)?.deviceId).toBe("phone");
  });

  it("lets a pairing link re-pair a device that already holds a credential", async () => {
    const { store, file } = await tempStore();
    const old = await store.mint({
      deviceId: "mac",
      scopes: ["device", "client", "operator"],
      origin: "upgrade",
    });
    expect(store.authenticate(old.token)?.deviceId).toBe("mac");
    const revoked: string[] = [];
    store.onRevoked((ids) => revoked.push(...ids));

    const pair = store.mintNow({
      deviceId: null,
      scopes: ["device", "client", "operator"],
      origin: "pair",
    });
    expect(store.authenticate(pair.token)).not.toBeNull();
    expect(store.bind(pair.credential.id, "mac")).toMatchObject({ ok: true });

    // The old credential is dead at once, and its live sessions were told to drop.
    expect(store.authenticate(old.token)).toBeNull();
    expect(revoked).toEqual([old.credential.id]);
    expect(store.activeFor("mac").map((c) => c.id)).toEqual([
      pair.credential.id,
    ]);
    expect(store.authenticate(pair.token)?.deviceId).toBe("mac");

    // ...and stays dead across a reload.
    await settle();
    const reloaded = new DeviceCredentialStore(file);
    await reloaded.load();
    expect(reloaded.authenticate(old.token)).toBeNull();
    expect(reloaded.authenticate(pair.token)?.deviceId).toBe("mac");

    // A used link cannot re-pair anything else (single use).
    expect(store.bind(pair.credential.id, "phone")).toMatchObject({
      ok: false,
    });
  });

  it("lets an installer link re-provision a node but not take over a companion", async () => {
    const { store } = await tempStore();
    const node = await store.mint({
      deviceId: "node-1",
      scopes: ["device"],
      origin: "upgrade",
    });
    const phone = await store.mint({
      deviceId: "phone",
      scopes: ["device", "client"],
      origin: "upgrade",
    });
    const install = store.mintNow({
      deviceId: null,
      scopes: ["device"],
      origin: "install",
    });
    const refused = store.bind(install.credential.id, "phone");
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? "" : refused.error).toContain("client");
    expect(store.authenticate(phone.token)?.deviceId).toBe("phone");

    expect(store.bind(install.credential.id, "node-1")).toMatchObject({
      ok: true,
    });
    expect(store.authenticate(node.token)).toBeNull();
  });

  it("never lets a non-pairing unbound credential take over a device", async () => {
    const { store } = await tempStore();
    const held = await store.mint({
      deviceId: "mac",
      scopes: ["device"],
      origin: "upgrade",
    });
    // Only pairing/installer links are minted unbound today; guard the rule
    // anyway by forging one of another origin.
    const odd = store.mintNow({
      deviceId: null,
      scopes: ["device", "client", "operator"],
      origin: "upgrade",
    });
    const result = store.bind(odd.credential.id, "mac");
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.error).toContain("revoke it first");
    expect(store.authenticate(held.token)?.deviceId).toBe("mac");
  });

  it("expires an unbound credential that is never used", async () => {
    let now = 1_000_000;
    const { store } = await tempStore(() => now);
    const { token } = store.mintNow({
      deviceId: null,
      scopes: ["device"],
      origin: "install",
    });
    expect(store.authenticate(token)).not.toBeNull();
    now += 8 * 24 * 60 * 60 * 1000;
    expect(store.authenticate(token)).toBeNull();
  });

  it("keeps a superseded credential until its replacement is first used", async () => {
    const { store } = await tempStore();
    const old = await store.mint({
      deviceId: "a",
      scopes: ["device"],
      origin: "upgrade",
    });
    expect(store.authenticate(old.token)).not.toBeNull(); // adopted
    const next = await store.mint({
      deviceId: "a",
      scopes: ["device"],
      origin: "rotate",
    });
    // The reply carrying `next` may have been lost — the old one still works.
    expect(store.authenticate(old.token)).not.toBeNull();
    const revoked: string[] = [];
    store.onRevoked((ids) => revoked.push(...ids));
    expect(store.authenticate(next.token)).not.toBeNull();
    await settle();
    expect(revoked).toEqual([old.credential.id]);
    expect(store.authenticate(old.token)).toBeNull();
  });

  it("a retried upgrade revokes the never-used credential it replaces", async () => {
    const { store } = await tempStore();
    const lost = await store.mint({
      deviceId: "a",
      scopes: ["device"],
      origin: "upgrade",
    });
    const retry = await store.mint({
      deviceId: "a",
      scopes: ["device"],
      origin: "upgrade",
    });
    expect(store.authenticate(lost.token)).toBeNull();
    expect(store.authenticate(retry.token)).not.toBeNull();
    expect(store.activeFor("a").map((c) => c.id)).toEqual([
      retry.credential.id,
    ]);
  });

  it("rotation requests surface via rotationDue and expire after the grace window", async () => {
    let now = 5_000_000;
    const { store } = await tempStore(() => now);
    const { token, credential } = await store.mint({
      deviceId: "a",
      scopes: ["device"],
      origin: "upgrade",
    });
    expect(store.rotationDue(credential.id)).toBe(false);
    await store.requestRotation("a");
    expect(store.rotationDue(credential.id)).toBe(true);
    expect(store.authenticate(token)).not.toBeNull();
    now += 8 * 24 * 60 * 60 * 1000;
    expect(store.authenticate(token)).toBeNull();
  });

  it("scope changes notify listeners so live sessions re-authenticate", async () => {
    const { store } = await tempStore();
    const { token, credential } = await store.mint({
      deviceId: "a",
      scopes: ["device"],
      origin: "upgrade",
    });
    const seen: string[] = [];
    store.onRevoked((ids) => seen.push(...ids));
    await store.setScopes("a", ["device", "operator"]);
    expect(seen).toEqual([credential.id]);
    expect(store.authenticate(token)?.scopes).toEqual(["device", "operator"]);
  });

  it("adopts a widened default for credentials still on the old one", async () => {
    const { store, file } = await tempStore();
    const phone = await store.mint({
      deviceId: "phone",
      scopes: FORMER_COMPANION_SCOPES,
      origin: "pair",
    });
    const node = await store.mint({
      deviceId: "node",
      scopes: ["device"],
      origin: "install",
    });
    const narrowed = await store.mint({
      deviceId: "tablet",
      scopes: ["device", "client", "operator"],
      origin: "pair",
    });
    // An operator narrowed this one by hand: it keeps its scopes.
    await store.setScopes("tablet", ["device", "client"]);

    const moved = await store.adoptDefaultScopes(
      FORMER_COMPANION_SCOPES,
      DEFAULT_COMPANION_SCOPES,
    );
    expect(moved).toBe(1);
    expect(store.authenticate(phone.token)?.scopes).toEqual([
      "device",
      "client",
      "operator",
    ]);
    expect(store.authenticate(node.token)?.scopes).toEqual(["device"]);
    expect(store.authenticate(narrowed.token)?.scopes).toEqual([
      "device",
      "client",
    ]);
    // Persisted, and idempotent across a restart.
    const again = new DeviceCredentialStore(file);
    expect(
      await again.adoptDefaultScopes(
        FORMER_COMPANION_SCOPES,
        DEFAULT_COMPANION_SCOPES,
      ),
    ).toBe(0);
    expect(again.authenticate(narrowed.token)?.scopes).toEqual([
      "device",
      "client",
    ]);
  });

  it("a re-issued credential keeps hand-set scopes", async () => {
    const { store } = await tempStore();
    await store.mint({
      deviceId: "tablet",
      scopes: ["device", "client", "operator"],
      origin: "pair",
    });
    await store.setScopes("tablet", ["device", "client"]);
    const rotated = await store.mint({
      deviceId: "tablet",
      scopes: ["device", "client"],
      origin: "rotate",
    });
    expect(rotated.credential.scopesSetAt).toBeTypeOf("number");
    expect(
      await store.adoptDefaultScopes(
        FORMER_COMPANION_SCOPES,
        DEFAULT_COMPANION_SCOPES,
      ),
    ).toBe(0);
  });

  it("tracks devices still on the shared token until they hold a credential", async () => {
    const { store } = await tempStore();
    expect(store.noteLegacy("old-phone")).toBe(true);
    expect(store.noteLegacy("old-phone")).toBe(false);
    expect(store.legacyDevices().map((d) => d.deviceId)).toEqual(["old-phone"]);
    await store.mint({
      deviceId: "old-phone",
      scopes: ["device"],
      origin: "upgrade",
    });
    expect(store.legacyDevices()).toEqual([]);
  });
});

describe("credential admin (talon mesh)", () => {
  async function adminContext(): Promise<CredentialAdminContext> {
    const { store } = await tempStore();
    return {
      store,
      resolveDeviceId: (q) => (q === "Pixel" ? "phone" : undefined),
      legacySharedToken: () => false,
    };
  }

  it("revokes by registry name, by device id, and by credential id", async () => {
    const ctx = await adminContext();
    await ctx.store.mint({
      deviceId: "phone",
      scopes: ["device"],
      origin: "pair",
    });
    const byName = await credentialAdmin(ctx, {
      op: "revoke",
      device: "Pixel",
    });
    expect(byName).toMatchObject({ ok: true });
    const again = await credentialAdmin(ctx, { op: "revoke", device: "phone" });
    expect(again).toMatchObject({ ok: false });

    const { credential } = await ctx.store.mint({
      deviceId: "laptop",
      scopes: ["device"],
      origin: "pair",
    });
    const byId = await credentialAdmin(ctx, {
      op: "revoke",
      device: credential.id,
    });
    expect(byId).toMatchObject({ ok: true });
    expect(ctx.store.activeFor("laptop")).toEqual([]);
  });

  it("sets scopes from a comma list and rejects an empty one", async () => {
    const ctx = await adminContext();
    await ctx.store.mint({
      deviceId: "phone",
      scopes: ["device"],
      origin: "pair",
    });
    expect(
      await credentialAdmin(ctx, {
        op: "scopes",
        device: "phone",
        scopes: "device, client,operator",
      }),
    ).toMatchObject({ ok: true });
    expect(ctx.store.activeFor("phone")[0]?.scopes).toEqual([
      "device",
      "client",
      "operator",
    ]);
    expect(
      await credentialAdmin(ctx, {
        op: "scopes",
        device: "phone",
        scopes: "root",
      }),
    ).toMatchObject({ ok: false });
  });

  it("rotate marks the credential and unknown devices are an error", async () => {
    const ctx = await adminContext();
    const { credential } = await ctx.store.mint({
      deviceId: "phone",
      scopes: ["device"],
      origin: "pair",
    });
    expect(
      await credentialAdmin(ctx, { op: "rotate", device: "phone" }),
    ).toMatchObject({
      ok: true,
    });
    expect(ctx.store.rotationDue(credential.id)).toBe(true);
    expect(
      await credentialAdmin(ctx, { op: "rotate", device: "nope" }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      await credentialAdmin(ctx, { op: "bogus", device: "phone" }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("the overview lists credentials without their hashes", async () => {
    const ctx = await adminContext();
    await ctx.store.mint({
      deviceId: "phone",
      scopes: ["device"],
      origin: "pair",
    });
    const overview = await credentialOverview(ctx);
    expect(overview.credentials).toHaveLength(1);
    expect(JSON.stringify(overview)).not.toContain("tokenHash");
    expect(overview.legacySharedToken).toBe(false);
  });
});

describe("mesh service with credentials", () => {
  async function service(): Promise<MeshService> {
    const dir = await mkdtemp(join(tmpdir(), "talon-mesh-cred-svc-"));
    return new MeshService(
      new MeshRegistry({
        devices: join(dir, "devices.json"),
        locations: join(dir, "locations.json"),
        history: join(dir, "history.json"),
      }),
      {
        credentials: new DeviceCredentialStore(join(dir, "credentials.json")),
        nodeBinaryResolver: async () => ({
          path: "/bin/true",
          sha256: "a".repeat(64),
          size: 1,
          version: "9.9.9",
          source: "cache",
        }),
      },
    );
  }

  function bridge(svc: MeshService): void {
    svc.setBridgeInfo({
      scheme: "https",
      host: "10.0.0.2",
      port: 19880,
      token: "shared-secret",
      fingerprint: "f".repeat(64),
    });
  }

  it("pairing links carry an unbound per-device credential, never the shared token", async () => {
    const svc = await service();
    await svc.load();
    bridge(svc);
    const minted = svc.makeCompanionPairLink("Phone");
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(isDeviceCredentialToken(minted.token)).toBe(true);
    expect(minted.token).not.toBe("shared-secret");
    const cred = svc.credentials!.authenticate(minted.token);
    // Every scope by default, as the shared token had.
    expect(cred).toMatchObject({
      deviceId: null,
      scopes: [...DEFAULT_COMPANION_SCOPES],
    });
    expect(DEFAULT_COMPANION_SCOPES).toEqual(["device", "client", "operator"]);
  });

  it("make_companion_pair_link returns the link plus URL, token and fingerprint", async () => {
    const svc = await service();
    await svc.load();
    bridge(svc);
    const result = svc.makeCompanionPairLinkText("Phone");
    expect(result.ok).toBe(true);
    const text = result.text ?? "";
    expect(text).toMatch(/https:\/\/10\.0\.0\.2:19880\/pair\?grant=/);
    expect(text).toContain("Bridge URL: https://10.0.0.2:19880");
    expect(text).toContain(`Certificate SHA-256: ${"f".repeat(64)}`);
    expect(text).toContain("expires in 10 minutes");
    const token = /Token: (\S+)/.exec(text)![1]!;
    expect(isDeviceCredentialToken(token)).toBe(true);
    expect(text).not.toContain("shared-secret");
    // The typed-in token is the same live credential the link carries.
    expect(svc.credentials!.authenticate(token)).toMatchObject({
      deviceId: null,
    });
  });

  it("make_companion_pair_link fails cleanly without a bridge", async () => {
    const svc = await service();
    await svc.load();
    const result = svc.makeCompanionPairLinkText();
    expect(result.ok).toBe(false);
  });

  it("pairing links honour a narrowed native.companionScopes", async () => {
    const svc = await service();
    await svc.load();
    svc.setBridgeInfo({
      scheme: "https",
      host: "10.0.0.2",
      port: 19880,
      token: "shared-secret",
      fingerprint: "f".repeat(64),
      companionScopes: ["device", "client"],
    });
    const minted = svc.makeCompanionPairLink("Phone");
    if (!minted.ok) throw new Error(minted.text);
    expect(svc.credentials!.authenticate(minted.token)?.scopes).toEqual([
      "device",
      "client",
    ]);
  });

  it("node installers carry a device-only credential", async () => {
    const svc = await service();
    await svc.load();
    bridge(svc);
    const minted = await svc.makeNodeInstallLink("linux", "amd64");
    const grant = /provision=([A-Za-z0-9_-]+)/.exec(minted.text)![1]!;
    const script = (await svc.openNodeInstall(grant))!.script;
    expect(script).not.toContain("shared-secret");
    const token = /--token "([^"]+)"/.exec(script)![1]!;
    expect(svc.credentials!.authenticate(token)?.scopes).toEqual(["device"]);
  });

  it("remove_device revokes the device's credential", async () => {
    const svc = await service();
    await svc.load();
    await svc.register({
      id: "phone",
      name: "Pixel",
      platform: "android",
      appVersion: "1",
    });
    const { token } = await svc.credentials!.mint({
      deviceId: "phone",
      scopes: ["device"],
      origin: "pair",
    });
    const result = await svc.removeDevice("phone");
    expect(result.ok).toBe(true);
    expect(result.text).toMatch(/Revoked its 1 per-device credential/);
    expect(svc.credentials!.authenticate(token)).toBeNull();
  });

  it("remove_device fails a command still waiting on the revoked device", async () => {
    const svc = await service();
    await svc.load();
    await svc.register({
      id: "phone",
      name: "Pixel",
      platform: "android",
      appVersion: "1",
    });
    await svc.credentials!.mint({
      deviceId: "phone",
      scopes: ["device"],
      origin: "pair",
    });
    let sent!: () => void;
    const dispatched = new Promise<void>((r) => (sent = r));
    svc.registerTransport({ locate: () => {}, command: () => sent() });
    // A 5-minute exec the device will now never answer.
    const exec = svc.execOnDevice("phone", "sleep 600", undefined, 300);
    await dispatched;

    await svc.removeDevice("phone");

    const result = await exec;
    expect(result.ok).toBe(false);
    expect(result.text).toContain("removed from the mesh before it answered");
  }, 2_000);
});

describe("gateway /mesh/credentials", () => {
  let server: Server | undefined;
  afterEach(async () => {
    setMeshService(null);
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  async function start(): Promise<{ port: number; svc: MeshService }> {
    const dir = await mkdtemp(join(tmpdir(), "talon-mesh-cred-gw-"));
    const svc = new MeshService(
      new MeshRegistry({
        devices: join(dir, "devices.json"),
        locations: join(dir, "locations.json"),
        history: join(dir, "history.json"),
      }),
      { credentials: new DeviceCredentialStore(join(dir, "creds.json")) },
    );
    setMeshService(svc);
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
    const addr = server.address() as { port: number };
    boundPort = addr.port;
    return { port: addr.port, svc };
  }

  it("lists and revokes through the loopback gateway", async () => {
    const { port, svc } = await start();
    const { token } = await svc.credentials!.mint({
      deviceId: "phone",
      scopes: ["device"],
      origin: "pair",
    });
    const list = await gatewayFetch(
      `http://127.0.0.1:${port}/mesh/credentials`,
    );
    expect(
      ((await list.json()) as { credentials: unknown[] }).credentials,
    ).toHaveLength(1);
    const revoke = await gatewayFetch(
      `http://127.0.0.1:${port}/mesh/credentials`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "revoke", device: "phone" }),
      },
    );
    expect(await revoke.json()).toMatchObject({ ok: true });
    expect(svc.credentials!.authenticate(token)).toBeNull();
  });

  it("refuses browser-originated and non-JSON writes", async () => {
    const { port, svc } = await start();
    await svc.credentials!.mint({
      deviceId: "phone",
      scopes: ["device"],
      origin: "pair",
    });
    const fromPage = await gatewayFetch(
      `http://127.0.0.1:${port}/mesh/credentials`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({ op: "revoke", device: "phone" }),
      },
    );
    expect(fromPage.status).toBe(403);
    const simple = await gatewayFetch(
      `http://127.0.0.1:${port}/mesh/credentials`,
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ op: "revoke", device: "phone" }),
      },
    );
    expect(simple.status).toBe(415);
    expect(svc.credentials!.activeFor("phone")).toHaveLength(1);
  });
});

describe("DeviceCredentialStore — persist alert", () => {
  it("alerts when credentials cannot be written and clears on the next good write", async () => {
    const { writeFile, rm } = await import("node:fs/promises");
    const { activeAlerts, resetAlertsForTest } =
      await import("../core/frontend-runtime/alerts.js");
    const sent: string[] = [];
    resetAlertsForTest(async (text) => {
      sent.push(text);
    });
    // A regular file where the store's directory should be: mkdir fails.
    const blocker = await tempFile("blocked");
    await writeFile(blocker, "");
    const store = new DeviceCredentialStore(join(blocker, "credentials.json"));

    await expect(
      store.mint({ deviceId: "phone", scopes: ["device"], origin: "upgrade" }),
    ).rejects.toThrow();
    expect(activeAlerts().map((a) => a.key)).toEqual([
      "mesh.credentials.persist",
    ]);
    expect(sent[0]).toMatch(/Could not save mesh device credentials: /);

    await rm(blocker);
    await store.mint({
      deviceId: "tab",
      scopes: ["device"],
      origin: "upgrade",
    });
    expect(activeAlerts()).toEqual([]);
    expect(sent.at(-1)).toMatch(/Mesh device credentials are saving again/);
  });
});
