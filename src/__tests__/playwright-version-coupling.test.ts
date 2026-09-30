import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ENDPOINT_PLAYWRIGHT_MINOR,
  bundledPlaywrightVersion,
  couplingError,
  minorOf,
  parseMismatch,
  probeEndpoint,
} from "../plugins/playwright/version-coupling.js";

const BOX = [
  "╔════════════════════════════════════════════════════╗",
  "║ Playwright version mismatch:                       ║",
  "║   - server version: v1.58                          ║",
  "║   - client version: v1.64                          ║",
  "║                                                    ║",
  "║ <3 Playwright Team                                 ║",
  "╚════════════════════════════════════════════════════╝",
].join("\n");

describe("playwright endpoint version coupling", () => {
  it("the pinned @playwright/mcp bundles playwright-core on the endpoint's minor", () => {
    // This is the guard that turns a dependency bump red: @playwright/mcp
    // pins an exact playwright-core, the remote endpoint (python playwright
    // hosting Camoufox) sits on ENDPOINT_PLAYWRIGHT_MINOR, and the server
    // refuses any other minor with 428. Bump both together, deliberately.
    const bundled = bundledPlaywrightVersion();
    expect(bundled, "playwright-core must be installed").toBeDefined();
    expect(minorOf(bundled as string)).toBe(ENDPOINT_PLAYWRIGHT_MINOR);

    const mcpPkg = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "node_modules/@playwright/mcp/package.json"),
        "utf-8",
      ),
    ) as { dependencies?: Record<string, string> };
    expect(minorOf(mcpPkg.dependencies?.["playwright-core"] ?? "")).toBe(
      ENDPOINT_PLAYWRIGHT_MINOR,
    );
  });

  it("minorOf handles alpha/timestamped versions", () => {
    expect(minorOf("1.58.0-alpha-2026-01-16")).toBe("1.58");
    expect(minorOf("1.64.0-alpha-2026-09-14")).toBe("1.64");
    expect(minorOf("1.63.0")).toBe("1.63");
  });

  it("couplingError names both versions and the fix", () => {
    expect(couplingError("1.58.0-alpha-2026-01-16", "1.58")).toBeUndefined();
    expect(couplingError(undefined, "1.58")).toBeUndefined();
    const err = couplingError("1.64.0-alpha-2026-09-14", "1.58");
    expect(err).toContain("1.64.0-alpha-2026-09-14");
    expect(err).toContain("Playwright 1.58");
    expect(err).toContain("428");
  });

  it("parseMismatch reads the server's ASCII box", () => {
    expect(parseMismatch(BOX)).toEqual({ server: "1.58", client: "1.64" });
    expect(parseMismatch("Running")).toBeUndefined();
  });
});

describe("probeEndpoint", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((done) => server?.close(() => done()));
      server = undefined;
    }
  });

  async function listen(s: Server): Promise<string> {
    await new Promise<void>((done) => s.listen(0, "127.0.0.1", done));
    const address = s.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return `ws://127.0.0.1:${address.port}/camoufox`;
  }

  it("reports a mismatch from a 428 with the version box", async () => {
    server = createServer((req, res) => {
      expect(req.headers["user-agent"]).toMatch(/^Playwright\/1\.64\.0/);
      res.writeHead(428, { "Content-Type": "text/plain" });
      res.end(BOX);
    });
    const endpoint = await listen(server);
    await expect(probeEndpoint(endpoint, "1.64.0-alpha")).resolves.toEqual({
      state: "mismatch",
      client: "1.64.0-alpha",
      server: "1.58",
    });
  });

  it("reports a match when the server completes the upgrade", async () => {
    server = createServer();
    server.on("upgrade", (_req, socket) => {
      // The probe tears its side down at once; mirror that so the fake
      // server can close (upgraded sockets are outside http's tracking).
      socket.on("end", () => socket.destroy());
      socket.on("error", () => socket.destroy());
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
    });
    const endpoint = await listen(server);
    await expect(probeEndpoint(endpoint, "1.58.0")).resolves.toEqual({
      state: "match",
      client: "1.58.0",
    });
  });

  it("settles on the 101 at once while the server holds the socket open", async () => {
    // The Bun regression: its http client only surfaced the 101 when the
    // connection finally closed, so a live endpoint (which keeps the
    // WebSocket open) read as unreachable after the full timeout.
    server = createServer();
    const held: import("node:stream").Duplex[] = [];
    server.on("upgrade", (_req, socket) => {
      held.push(socket);
      socket.on("error", () => socket.destroy());
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
    });
    const endpoint = await listen(server);
    const started = Date.now();
    await expect(probeEndpoint(endpoint, "1.58.0", 10_000)).resolves.toEqual({
      state: "match",
      client: "1.58.0",
    });
    expect(Date.now() - started).toBeLessThan(2000);
    for (const s of held) s.destroy();
  });

  it("reads a chunked 428 body", async () => {
    server = createServer();
    server.on("upgrade", (_req, socket) => {
      socket.on("error", () => socket.destroy());
      const half = Math.floor(BOX.length / 2);
      const a = Buffer.from(BOX.slice(0, half));
      const b = Buffer.from(BOX.slice(half));
      socket.end(
        "HTTP/1.1 428 Precondition Required\r\n" +
          "Transfer-Encoding: chunked\r\n\r\n" +
          `${a.length.toString(16)}\r\n${a}\r\n` +
          `${b.length.toString(16)}\r\n${b}\r\n0\r\n\r\n`,
      );
    });
    const endpoint = await listen(server);
    await expect(probeEndpoint(endpoint, "1.64.0")).resolves.toEqual({
      state: "mismatch",
      client: "1.64.0",
      server: "1.58",
    });
  });

  it("names a non-upgrade status", async () => {
    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end("nope");
    });
    const endpoint = await listen(server);
    await expect(probeEndpoint(endpoint, "1.58.0")).resolves.toMatchObject({
      state: "unreachable",
      reason: "HTTP 404 instead of an upgrade",
    });
  });

  it("settles on a hard deadline even when the socket never goes idle", async () => {
    // A server that trickles header bytes forever defeats the socket idle
    // timer; the wall-clock guard must still settle the probe.
    const timers: NodeJS.Timeout[] = [];
    server = createServer();
    server.on("connection", (socket) => {
      socket.write("HTTP/1.1 200 OK\r\n");
      const t = setInterval(() => socket.write("X-Trickle: 1\r\n"), 50);
      timers.push(t);
      socket.on("close", () => clearInterval(t));
      socket.on("error", () => clearInterval(t));
    });
    const endpoint = await listen(server);
    const started = Date.now();
    const result = await probeEndpoint(endpoint, "1.58.0", 400);
    for (const t of timers) clearInterval(t);
    expect(result).toMatchObject({ state: "unreachable" });
    expect(Date.now() - started).toBeLessThan(2000);
    server.closeAllConnections();
  });

  it("reports unreachable instead of throwing", async () => {
    server = createServer();
    const endpoint = await listen(server);
    await new Promise<void>((done) => server?.close(() => done()));
    server = undefined;
    const result = await probeEndpoint(endpoint, "1.58.0", 1000);
    expect(result.state).toBe("unreachable");
    await expect(probeEndpoint("not a url", "1.58.0")).resolves.toMatchObject({
      state: "unreachable",
    });
  });
});
