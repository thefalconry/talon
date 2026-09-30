/**
 * Endpoint-mode version coupling — the machinery behind the pin.
 *
 * In endpoint mode the MCP child connects to a remote Playwright server
 * (the python-playwright process hosting Camoufox). Playwright's server
 * refuses the WebSocket upgrade with "428 Precondition Required" when the
 * client's playwright MINOR (sent in the User-Agent, `Playwright/x.y.z`)
 * differs from its own — so a client bump that nobody noticed turns every
 * browser tool call into an opaque error at the worst possible moment.
 *
 * Three guards, all keyed on ENDPOINT_PLAYWRIGHT_MINOR:
 *  - a unit test asserts the playwright-core that @playwright/mcp bundles is
 *    on that minor, so a dependency bump goes red in CI instead of green;
 *  - `validateConfig` refuses to start the plugin on a mismatch, with a
 *    message that names both versions and the fix;
 *  - `probeEndpoint` performs the real handshake at init and reports the
 *    server's verdict, so a drifted *server* is caught too.
 *
 * Bumping: change ENDPOINT_PLAYWRIGHT_MINOR and `@playwright/mcp` in
 * package.json in the same commit, after upgrading the python side
 * (camoufox caps python-playwright, so the node side cannot chase latest).
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { resolve } from "node:path";
import { connect as tlsConnect } from "node:tls";

/**
 * Playwright minor of the remote endpoint (python playwright behind
 * Camoufox). Must equal the minor of the playwright-core bundled by the
 * pinned @playwright/mcp — see the header comment before changing it.
 */
export const ENDPOINT_PLAYWRIGHT_MINOR = "1.58";

/** "1.58.0-alpha-2026-01-16" → "1.58". */
export function minorOf(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : version;
}

function defaultModulesRoot(): string {
  return resolve(import.meta.dirname ?? ".", "../../../node_modules");
}

/** Version of the playwright-core the MCP child will run with. */
export function bundledPlaywrightVersion(
  modulesRoot: string = defaultModulesRoot(),
): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(
        resolve(modulesRoot, "playwright-core/package.json"),
        "utf-8",
      ),
    ) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

/**
 * Static check: does the bundled client sit on the endpoint's minor?
 * Returns an error message, or undefined when coupled (or when the bundle
 * cannot be read — that is reported separately as a missing install).
 */
export function couplingError(
  bundled: string | undefined,
  expectedMinor: string = ENDPOINT_PLAYWRIGHT_MINOR,
): string | undefined {
  if (!bundled) return undefined;
  const got = minorOf(bundled);
  if (got === expectedMinor) return undefined;
  return (
    `@playwright/mcp bundles playwright-core ${bundled} (minor ${got}) but the ` +
    `remote endpoint is on Playwright ${expectedMinor} — every browser tool call ` +
    `would fail with "428 Precondition Required". Pin @playwright/mcp to the ` +
    `release that bundles playwright-core ${expectedMinor}.x, or bump ` +
    `ENDPOINT_PLAYWRIGHT_MINOR together with the python side ` +
    `(src/plugins/playwright/version-coupling.ts).`
  );
}

export type EndpointProbe =
  | { state: "match"; client: string }
  | { state: "mismatch"; client: string; server: string }
  | { state: "unreachable"; client: string; reason: string };

/** Parse the body Playwright's server sends with its 428. */
export function parseMismatch(
  body: string,
): { server: string; client: string } | undefined {
  const server = body.match(/server version:\s*v?([\d.]+)/);
  const client = body.match(/client version:\s*v?([\d.]+)/);
  return server && client
    ? { server: server[1], client: client[1] }
    : undefined;
}

/** Most bytes the probe will buffer from the server before giving up. */
const MAX_PROBE_BYTES = 64 * 1024;

type ParsedHead = {
  status: number;
  headers: Map<string, string>;
  bodyStart: number;
};

/** Parse an HTTP/1.x status line + headers once the blank line has arrived. */
function parseHead(buf: Buffer): ParsedHead | undefined {
  const end = buf.indexOf("\r\n\r\n");
  if (end < 0) return undefined;
  const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
  const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(lines[0])?.[1]);
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i > 0)
      headers.set(
        line.slice(0, i).trim().toLowerCase(),
        line.slice(i + 1).trim(),
      );
  }
  return {
    status: Number.isFinite(status) ? status : 0,
    headers,
    bodyStart: end + 4,
  };
}

/**
 * Decode a (possibly incomplete) chunked body. `complete` is true once the
 * terminating zero-length chunk has been seen.
 */
function decodeChunked(raw: Buffer): { body: string; complete: boolean } {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const eol = raw.indexOf("\r\n", at);
    if (eol < 0) break;
    const size = parseInt(raw.subarray(at, eol).toString("latin1"), 16);
    if (!Number.isFinite(size)) break;
    if (size === 0)
      return { body: Buffer.concat(parts).toString("utf-8"), complete: true };
    const dataStart = eol + 2;
    if (raw.length < dataStart + size) {
      parts.push(raw.subarray(dataStart));
      break;
    }
    parts.push(raw.subarray(dataStart, dataStart + size));
    at = dataStart + size + 2;
  }
  return { body: Buffer.concat(parts).toString("utf-8"), complete: false };
}

/** The body of a 428 once it is complete (or the connection ended), else undefined. */
function read428Body(
  head: ParsedHead,
  buf: Buffer,
  ended: boolean,
): string | undefined {
  const raw = buf.subarray(head.bodyStart);
  if (/chunked/i.test(head.headers.get("transfer-encoding") ?? "")) {
    const decoded = decodeChunked(raw);
    return decoded.complete || ended ? decoded.body : undefined;
  }
  const length = Number(head.headers.get("content-length"));
  if (Number.isFinite(length) && raw.length >= length)
    return raw.subarray(0, length).toString("utf-8");
  return ended ? raw.toString("utf-8") : undefined;
}

/**
 * The probe's verdict from what the server has sent so far, or undefined
 * while more bytes are needed. `ended` = the connection is closed.
 */
function readVerdict(
  buf: Buffer,
  ended: boolean,
  client: string,
): EndpointProbe | undefined {
  const head = parseHead(buf);
  if (!head) {
    return ended
      ? {
          state: "unreachable",
          client,
          reason: "connection closed before a response",
        }
      : undefined;
  }
  if (head.status === 101) return { state: "match", client };
  if (head.status !== 428) {
    return {
      state: "unreachable",
      client,
      reason: `HTTP ${head.status || "?"} instead of an upgrade`,
    };
  }
  const body = read428Body(head, buf, ended);
  if (body === undefined) return undefined;
  const parsed = parseMismatch(body);
  return parsed
    ? { state: "mismatch", client, server: parsed.server }
    : {
        state: "unreachable",
        client,
        reason: "428 without a version box in the body",
      };
}

/**
 * Perform the WebSocket upgrade the MCP child performs, advertising
 * `clientVersion`, and read the server's verdict. Never throws; never
 * leaves a connection open (a completed upgrade is torn down at once, and
 * Playwright's server treats that as an ordinary client disconnect).
 *
 * The handshake is written and read over a raw TCP/TLS socket rather than
 * node:http's `request`. Runtimes disagree about how an HTTP client surfaces
 * a 101: Node emits "upgrade", Bun (1.3) emits neither "upgrade" nor
 * "response" — the probe just sat until the idle timer fired, adding the
 * full timeout to every boot and reporting a healthy endpoint as
 * unreachable. Reading the status line ourselves behaves identically on
 * both, and a hard wall-clock deadline bounds the probe whatever the
 * server does.
 */
export function probeEndpoint(
  endpoint: string,
  clientVersion: string,
  timeoutMs = 3000,
): Promise<EndpointProbe> {
  return new Promise((settle) => {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      settle({
        state: "unreachable",
        client: clientVersion,
        reason: `invalid endpoint URL: ${endpoint}`,
      });
      return;
    }
    const secure = url.protocol === "wss:" || url.protocol === "https:";
    const port = Number(url.port) || (secure ? 443 : 80);
    // URL keeps IPv6 literals bracketed; sockets want them bare.
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    const hostHeader = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    const socket: Socket = secure
      ? tlsConnect({ host, port, servername: isIP(host) ? undefined : host })
      : netConnect({ host, port });

    let settled = false;
    const done = (result: EndpointProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      settle(result);
    };
    const unreachable = (reason: string) =>
      done({ state: "unreachable", client: clientVersion, reason });
    const deadline = setTimeout(
      () => unreachable(`no verdict within ${timeoutMs}ms`),
      timeoutMs,
    );
    deadline.unref?.();

    let buf = Buffer.alloc(0);
    const verdict = (ended: boolean) => {
      const result = readVerdict(buf, ended, clientVersion);
      if (result) done(result);
    };

    socket.setTimeout(timeoutMs, () => unreachable("timeout"));
    socket.on("error", (err: Error) => unreachable(err.message));
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_PROBE_BYTES) {
        unreachable("response too large");
        return;
      }
      verdict(false);
    });
    socket.on("end", () => verdict(true));
    socket.on("close", () => verdict(true));
    socket.once(secure ? "secureConnect" : "connect", () => {
      socket.write(
        [
          `GET ${url.pathname || "/"}${url.search} HTTP/1.1`,
          `Host: ${hostHeader}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
          `User-Agent: Playwright/${clientVersion} (talon endpoint probe)`,
          "",
          "",
        ].join("\r\n"),
      );
    });
  });
}
