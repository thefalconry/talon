import { describe, expect, it, vi } from "vitest";
import { X509Certificate, createHash, createPrivateKey } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { request } from "node:https";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  certificateFingerprint,
  certificateSpkiPin,
  formatFingerprint,
  generateSelfSignedCertificate,
  isLoopbackHost,
  loadOrCreateBridgeTlsIdentity,
} from "../frontend/native/bridge/tls.js";
import {
  BridgeServer,
  type BridgeServerHandlers,
} from "../frontend/native/bridge/server.js";

/**
 * A POSIX curl to exercise installer pinning with. Not on Windows (its
 * Schannel curl differs) and not under bun (no tls parity yet).
 */
const HAS_CURL =
  process.platform !== "win32" &&
  typeof process.versions.bun !== "string" &&
  spawnSync("curl", ["--version"]).status === 0;

describe("bridge TLS identity", () => {
  it("mints a well-formed self-signed certificate", () => {
    const { keyPem, certPem } = generateSelfSignedCertificate();
    const cert = new X509Certificate(certPem);

    expect(cert.subject).toContain("CN=Talon Bridge");
    expect(cert.issuer).toBe(cert.subject); // self-signed
    expect(cert.verify(cert.publicKey)).toBe(true); // signature closes over itself
    expect(cert.checkPrivateKey(createPrivateKey(keyPem))).toBe(true);
    expect(cert.subjectAltName).toContain("DNS:localhost");
    expect(cert.subjectAltName).toContain("IP Address:127.0.0.1");

    const now = Date.now();
    expect(new Date(cert.validFrom).getTime()).toBeLessThanOrEqual(now);
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(now);
  });

  it("honours the validity window option", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    const { certPem } = generateSelfSignedCertificate({
      validityDays: 30,
      now,
    });
    const cert = new X509Certificate(certPem);
    expect(new Date(cert.validTo).getTime()).toBe(
      now.getTime() + 30 * 24 * 60 * 60 * 1000,
    );
  });

  it("fingerprints are the SHA-256 of the certificate DER", () => {
    const { certPem } = generateSelfSignedCertificate();
    const cert = new X509Certificate(certPem);
    const expected = createHash("sha256").update(cert.raw).digest("hex");

    expect(certificateFingerprint(certPem)).toBe(expected);
    expect(formatFingerprint("ab12cd")).toBe("AB:12:CD");
  });

  it("persists the identity and reuses it across loads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "talon-tls-"));

    const first = await loadOrCreateBridgeTlsIdentity(dir);
    const second = await loadOrCreateBridgeTlsIdentity(dir);

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.certPem).toBe(first.certPem);
    // A stable identity is the whole point: clients pin this fingerprint.
    expect(await readFile(join(dir, "bridge-cert.pem"), "utf-8")).toBe(
      first.certPem,
    );
  });

  it("remints when the persisted certificate is corrupt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "talon-tls-"));
    const first = await loadOrCreateBridgeTlsIdentity(dir);

    await writeFile(join(dir, "bridge-cert.pem"), "not a certificate");
    const reminted = await loadOrCreateBridgeTlsIdentity(dir);

    expect(reminted.fingerprint).not.toBe(first.fingerprint);
    expect(() => new X509Certificate(reminted.certPem)).not.toThrow();
  });

  it("remints when the key no longer matches the certificate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "talon-tls-"));
    const first = await loadOrCreateBridgeTlsIdentity(dir);

    const stranger = generateSelfSignedCertificate();
    await writeFile(join(dir, "bridge-key.pem"), stranger.keyPem);
    const reminted = await loadOrCreateBridgeTlsIdentity(dir);

    expect(reminted.fingerprint).not.toBe(first.fingerprint);
  });

  it("classifies loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.20")).toBe(false);
  });
});

describe("bridge server over TLS", () => {
  const handlers: BridgeServerHandlers = {
    status: () => ({
      app: "talon-bridge",
      protocol: 1,
      botName: "Talon",
      backend: "test",
      model: "m1",
      activeChats: 0,
      startedAt: "now",
    }),
    listChats: () => [],
    createChat: () => {
      throw new Error("unused");
    },
    renameChat: () => null,
    deleteChat: () => false,
    history: () => [],
    search: () => [],
    listMemory: () => ({ ok: true, rows: [] }),
    memoryWhy: () => null,
    send: () => {},
    upload: async () => ({
      path: "",
      name: "",
      size: 0,
      mimeType: "application/octet-stream",
      url: "",
      image: false,
    }),
    listModels: () => ({ active: "", models: [] }),
    setModel: () => {},
    listBackends: () => ({ active: "", backends: [] }),
    setBackend: async () => ({ ok: true }),
    setEffort: () => {},
    effortLevels: async () => ({ active: "", levels: [] }),
    listPlugins: () => [],
    setPluginEnabled: async () => ({ ok: true }),
    listSkills: () => [],
    setSkillEnabled: () => ({ ok: true }),
    resetChat: () => false,
    interruptTurn: async () => false,
    setPulse: () => {},
    queueMessage: () => {},
    getConfig: () => ({}) as never,
    setConfig: () => ({}) as never,
    control: async () => ({ ok: true, message: "" }),
    logs: () => [],
    liveTurnEvents: () => [],
    listCommands: () => [],
    mediaPath: () => null,
    registerDevice: async () => ({}) as never,
    storeLocation: async () => ({}) as never,
    listDevices: () => ({ devices: [], locations: [] }),
    completeCommand: () => false,
    acceptFileUpload: async () => ({ ok: false, error: "unused" }),
    openFileDownload: async () => null,
    openNodeInstall: () => null,
    openCompanionPair: () => null,
    openNodeBinary: () => null,
  };

  /** GET over HTTPS trusting exactly the bridge's own certificate. */
  function tlsGet(
    port: number,
    path: string,
    ca: string,
    headers?: Record<string, string>,
  ): Promise<{
    status: number;
    body: Record<string, unknown>;
    peerDerSha256: string;
    peerSpkiSha256: string;
  }> {
    return new Promise((resolvePromise, reject) => {
      // Capture the peer certificate at handshake time: auth refusals are
      // sent with `Connection: close`, so by the time the response callback
      // runs the socket may already be torn down.
      let peerDerSha256 = "";
      let peerSpkiSha256 = "";
      const req = request(
        { host: "127.0.0.1", port, path, ca, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolvePromise({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
              peerDerSha256,
              peerSpkiSha256,
            }),
          );
        },
      );
      req.on("socket", (socket) => {
        const tlsSocket = socket as import("node:tls").TLSSocket;
        const capture = (): void => {
          const peer = tlsSocket.getPeerCertificate();
          if (peer?.raw) {
            peerDerSha256 = createHash("sha256").update(peer.raw).digest("hex");
            // The DER SPKI — what curl --pinnedpubkey hashes. (`pubkey` is
            // the bare EC point, not the SPKI.)
            peerSpkiSha256 = createHash("sha256")
              .update(
                new X509Certificate(peer.raw).publicKey.export({
                  type: "spki",
                  format: "der",
                }),
              )
              .digest("base64");
          }
        };
        // A reused keep-alive socket has already shaken hands.
        capture();
        if (!peerDerSha256) tlsSocket.once("secureConnect", capture);
      });
      req.on("error", reject);
      req.end();
    });
  }

  // bun's node:tls sockets don't implement getPeerCertificate yet, which
  // this test's client uses to verify the served cert. Node-only until
  // https://github.com/oven-sh/bun tracks full tls.TLSSocket parity.
  it.skipIf(typeof process.versions.bun === "string")(
    "serves HTTPS, reports its fingerprint, and still enforces the token",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "talon-tls-server-"));
      const identity = await loadOrCreateBridgeTlsIdentity(dir);
      const server = new BridgeServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          startedAt: "now",
          tls: async () => identity,
        },
        handlers,
      );
      const port = await server.start();
      try {
        expect(server.getScheme()).toBe("https");
        expect(server.getFingerprint()).toBe(identity.fingerprint);

        // The handshake itself proves the certificate is trustable as pinned:
        // the client trusts exactly this cert (ca:) and hostname-verifies
        // against its subjectAltName IP entry.
        const health = await tlsGet(port, "/health", identity.certPem);
        expect(health.status).toBe(200);
        expect(health.body).toMatchObject({
          app: "talon-bridge",
          scheme: "https",
          fingerprint: identity.fingerprint,
        });
        // What a pinning client computes (SHA-256 over the peer's DER) is
        // exactly the fingerprint the daemon advertises.
        expect(health.peerDerSha256).toBe(identity.fingerprint);
        // Likewise the SPKI pin node installers hand curl.
        expect(server.getSpkiPin()).toBe(health.peerSpkiSha256);
        expect(server.getSpkiPin()).toBe(certificateSpkiPin(identity.certPem));

        const denied = await tlsGet(port, "/chats", identity.certPem);
        expect(denied.status).toBe(401);

        const allowed = await tlsGet(port, "/chats", identity.certPem, {
          Authorization: "Bearer secret",
        });
        expect(allowed.status).toBe(200);

        const wrongToken = await tlsGet(port, "/chats", identity.certPem, {
          Authorization: "Bearer wrong",
        });
        expect(wrongToken.status).toBe(401);
      } finally {
        await server.stop();
      }
    },
  );

  /** curl against the bridge; resolves whether the fetch succeeded. */
  function curlOk(args: string[]): Promise<boolean> {
    return new Promise((resolvePromise) => {
      execFile("curl", ["-fsS", "--noproxy", "*", ...args], (err) =>
        resolvePromise(!err),
      );
    });
  }

  // What node installers run: `curl -k --pinnedpubkey`. Real curl, because
  // the whole point is curl's semantics — the pin is enforced even with -k,
  // and without -k a matching pin alone does not get past the self-signed
  // chain.
  it.skipIf(!HAS_CURL)(
    "curl -k --pinnedpubkey accepts the bridge's pin and refuses any other",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "talon-tls-curl-"));
      const identity = await loadOrCreateBridgeTlsIdentity(dir);
      const server = new BridgeServer(
        {
          host: "127.0.0.1",
          port: 0,
          startedAt: "now",
          tls: async () => identity,
        },
        handlers,
      );
      const port = await server.start();
      const url = `https://127.0.0.1:${port}/health`;
      const pin = (p: string): string[] => ["--pinnedpubkey", `sha256//${p}`];
      const other = certificateSpkiPin(generateSelfSignedCertificate().certPem);
      try {
        expect(await curlOk(["-k", ...pin(server.getSpkiPin()!), url])).toBe(
          true,
        );
        expect(await curlOk(["-k", ...pin(other), url])).toBe(false);
        expect(await curlOk([...pin(server.getSpkiPin()!), url])).toBe(false);
      } finally {
        await server.stop();
      }
    },
  );

  it("stays plain HTTP (scheme + null fingerprint) without a TLS identity", async () => {
    const server = new BridgeServer(
      { host: "127.0.0.1", port: 0, startedAt: "now" },
      handlers,
    );
    const port = await server.start();
    try {
      expect(server.getScheme()).toBe("http");
      expect(server.getFingerprint()).toBeNull();
      expect(server.getSpkiPin()).toBeNull();
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.scheme).toBe("http");
      expect(body.fingerprint).toBeNull();
    } finally {
      await server.stop();
    }
  });
});
