/**
 * The non-impersonation rungs: plain fetch, anti-detect browser
 * (Camoufox over the Playwright wire protocol) and a mesh egress device.
 * curl-impersonate lives in curl-impersonate.ts.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { binaryOnPath } from "../../util/binary-on-path.js";
import {
  readBodyLimited,
  ResponseTooLargeError,
} from "../../util/http-body.js";
import { getMeshService } from "../mesh/index.js";
import { CHALLENGE_PATTERN } from "./classify.js";
import { fetchError } from "./errors.js";
import type { RawResponse, Rung, RungRequest } from "./types.js";

// ── plain ───────────────────────────────────────────────────────────────────

/** The runtime's own fetch, honest User-Agent, one hop per call. */
export function plainRung(): Rung {
  return {
    name: "plain",
    relayed: false,
    followsRedirects: false,
    publicOnly: false,
    async available() {
      return true;
    },
    async request(req: RungRequest): Promise<RawResponse> {
      const resp = await fetch(req.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(req.timeoutMs),
        headers: { "User-Agent": "Talon/1.0", ...req.headers },
      });
      const contentLength = Number(resp.headers.get("content-length") ?? "");
      if (contentLength > req.maxBytes) {
        await resp.body?.cancel().catch(() => {});
        throw new ResponseTooLargeError();
      }
      const body =
        resp.status >= 300 && resp.status < 400
          ? (await resp.body?.cancel().catch(() => {}), Buffer.alloc(0))
          : await readBodyLimited(resp, req.maxBytes);
      return {
        status: resp.status,
        headers: resp.headers,
        body,
        url: req.url.href,
      };
    },
  };
}

// ── anti-detect browser ─────────────────────────────────────────────────────

/**
 * playwright-core as bundled by @playwright/mcp — the one client version
 * the playwright plugin already pins to match the Camoufox server (see
 * plugins/playwright/version-coupling.ts). Undefined when not installed
 * (e.g. a standalone binary without node_modules).
 */
function playwrightCorePath(): string | undefined {
  try {
    const here = createRequire(import.meta.url);
    const mcpPkg = here.resolve("@playwright/mcp/package.json");
    return createRequire(mcpPkg).resolve("playwright-core");
  } catch {
    return undefined;
  }
}

/** Read the playwright plugin's endpoint the same way the plugin does. */
export function playwrightEndpoint(pw?: {
  endpoint?: string;
  endpointFile?: string;
}): string | undefined {
  if (pw?.endpoint) return pw.endpoint;
  if (pw?.endpointFile) {
    try {
      return readFileSync(pw.endpointFile, "utf-8").trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The browser driver, run under Node in a child process: playwright's
 * WebSocket client does not connect under Bun (verified 2026-09-30 —
 * `firefox.connect` times out), which is also why the playwright plugin
 * runs @playwright/mcp under `node`. argv: playwright-core path, endpoint,
 * url, timeout ms, challenge regex source. Prints one JSON object.
 */
const BROWSER_DRIVER = `
const [pwPath, endpoint, url, timeoutMs, challenge] = process.argv.slice(1);
const { firefox } = require(pwPath);
const CH = new RegExp(challenge, "i");
(async () => {
  const browser = await firefox.connect(endpoint, { timeout: Math.min(15000, +timeoutMs) });
  let out;
  try {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      let last = null;
      page.on("response", (r) => {
        if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) last = r;
      });
      const first = await page.goto(url, { waitUntil: "domcontentloaded", timeout: +timeoutMs });
      last = last || first;
      let html = await page.content();
      if (html.length < 32768 && CH.test(html)) {
        await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
        await page.waitForTimeout(1000);
        html = await page.content();
      }
      const headers = last ? await last.allHeaders().catch(() => ({})) : {};
      out = { status: last ? last.status() : 200, url: page.url(), headers, html };
    } finally {
      await ctx.close().catch(() => {});
    }
  } finally {
    // For a connected browser this disconnects; the server keeps running.
    await browser.close().catch(() => {});
  }
  process.stdout.write(JSON.stringify(out));
})().catch((e) => {
  process.stderr.write(String((e && e.message) || e).split("\\n")[0]);
  process.exit(1);
});
`;

type DriverOutput = {
  status: number;
  url: string;
  headers: Record<string, string>;
  html: string;
};

/** Runs the driver; resolves with its parsed stdout. Test seam. */
type RunBrowserDriver = (
  args: string[],
  timeoutMs: number,
) => Promise<DriverOutput>;

const runBrowserDriver: RunBrowserDriver = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const node = process.versions.bun ? "node" : process.execPath;
    execFile(
      node,
      ["-e", BROWSER_DRIVER, ...args],
      { timeout: timeoutMs + 20_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(fetchError(String(stderr).trim() || err.message));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as DriverOutput);
        } catch {
          reject(fetchError("browser driver returned no result"));
        }
      },
    );
  });

export type BrowserRungOptions = {
  endpoint: string;
  /** fetchUrl.allowPrivateNetworks: false — see available(). */
  guard: boolean;
  corePath?: () => string | undefined;
  run?: RunBrowserDriver;
};

export function browserRung(opts: BrowserRungOptions): Rung {
  const corePath = opts.corePath ?? playwrightCorePath;
  const run = opts.run ?? runBrowserDriver;
  return {
    name: "camoufox",
    relayed: false,
    followsRedirects: true,
    publicOnly: true,
    timeoutMs: 45_000,
    async available() {
      // A page pulls subresources and follows redirects inside the
      // browser, out of reach of the per-hop SSRF check.
      if (opts.guard) {
        return "not used with fetchUrl.allowPrivateNetworks: false (the browser's own requests can't be guarded)";
      }
      if (!corePath())
        return "playwright-core (via @playwright/mcp) is not installed";
      if (process.versions.bun && !binaryOnPath("node")) {
        return "node is not on PATH (the browser driver runs under Node)";
      }
      return true;
    },
    async request(req: RungRequest): Promise<RawResponse> {
      const core = corePath();
      if (!core) throw fetchError("playwright-core not installed");
      const out = await run(
        [
          core,
          opts.endpoint,
          req.url.href,
          String(req.timeoutMs),
          CHALLENGE_PATTERN,
        ],
        req.timeoutMs,
      );
      const headers = new Headers();
      for (const [k, v] of Object.entries(out.headers ?? {})) {
        try {
          headers.set(k, v);
        } catch {
          /* skip headers Headers refuses */
        }
      }
      // The body is the rendered DOM, serialized as UTF-8 HTML.
      headers.set("content-type", "text/html; charset=utf-8");
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.delete("location");
      const body = Buffer.from(out.html ?? "", "utf8");
      if (body.length > req.maxBytes) throw new ResponseTooLargeError();
      return {
        status: out.status || 200,
        headers,
        body,
        url: out.url || req.url.href,
      };
    },
  };
}

// ── mesh egress device ──────────────────────────────────────────────────────

/** Runs a shell command on a device; resolves with its stdout. */
export type DeviceExec = (
  device: string,
  cmd: string,
  timeoutMs: number,
) => Promise<{ ok: boolean; stdout: string; error?: string }>;

const meshExec: DeviceExec = async (device, cmd, timeoutMs) => {
  const dispatched = await getMeshService().dispatchCommand(
    device,
    "exec",
    { cmd, timeoutMs },
    timeoutMs + 5_000,
  );
  if ("error" in dispatched)
    return { ok: false, stdout: "", error: dispatched.error };
  const data = dispatched.result.data ?? {};
  return {
    ok: dispatched.result.ok,
    stdout: typeof data.stdout === "string" ? data.stdout : "",
    error: dispatched.result.message,
  };
};

/** POSIX single-quote a shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const EGRESS_MARK = "__TALON_FETCH__";
const EGRESS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15";

export function egressRung(device: string, exec: DeviceExec = meshExec): Rung {
  return {
    name: `egress:${device}`,
    relayed: true,
    followsRedirects: false,
    publicOnly: true,
    async available() {
      return true;
    },
    async request(req: RungRequest): Promise<RawResponse> {
      const secs = Math.max(1, Math.ceil(req.timeoutMs / 1000) - 2);
      const parts = [
        "curl -sS --proto =http,https",
        `--max-time ${secs}`,
        `--max-filesize ${req.maxBytes}`,
        `-A ${shellQuote(EGRESS_UA)}`,
        ...Object.entries(req.headers).map(
          ([k, v]) => `-H ${shellQuote(`${k}: ${v}`)}`,
        ),
        "-o -",
        `-w ${shellQuote(`\n${EGRESS_MARK} %{http_code} %{redirect_url} %{content_type}`)}`,
        shellQuote(req.url.href),
      ];
      const out = await exec(device, parts.join(" "), req.timeoutMs);
      const at = out.stdout.lastIndexOf(`\n${EGRESS_MARK} `);
      if (at < 0) {
        throw fetchError(
          out.error || `egress device ${device} returned no HTTP answer`,
        );
      }
      const [code = "0", redirect = "", ...ct] = out.stdout
        .slice(at + EGRESS_MARK.length + 2)
        .trim()
        .split(" ");
      const status = Number(code);
      if (!status)
        throw fetchError(out.error || `curl on ${device} got no HTTP answer`);
      const headers = new Headers();
      if (ct.length) headers.set("content-type", ct.join(" "));
      if (redirect) headers.set("location", redirect);
      // Device exec carries text; binary bodies do not survive the trip.
      const body = Buffer.from(out.stdout.slice(0, at), "utf8");
      return { status, headers, body, url: req.url.href };
    },
  };
}
