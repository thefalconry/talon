/**
 * Browser-TLS impersonation via curl-impersonate
 * (https://github.com/lexiforest/curl-impersonate).
 *
 * Why this and not the alternatives (see docs/fetch-ladder.md):
 *  - Most bot walls judge the TLS/HTTP2 fingerprint (JA3/JA4, SETTINGS
 *    frames, header order) before they look at the IP. Node's and Bun's
 *    fetch have a fixed, well-known fingerprint and neither runtime lets
 *    you change it, so impersonation has to happen outside the JS runtime.
 *  - curl-impersonate is one static binary per platform (BoringSSL build,
 *    `--impersonate <browser>`), no Python, no pip, no native addon. It is
 *    the same engine curl_cffi wraps, so it gets the same results.
 *  - The release is pinned by version AND per-asset sha256 below, then
 *    downloaded into ~/.talon/bin on first use. A digest mismatch refuses
 *    the binary. `fetch.curlImpersonatePath` points at a system copy
 *    instead (packagers, air-gapped hosts) and skips the download.
 *
 * Bumping: change CURL_IMPERSONATE_VERSION, recompute every sha256 from the
 * release assets (`sha256sum curl-impersonate-<v>.<triple>.tar.gz`), and
 * check the DEFAULT_TARGETS still exist (`curl-impersonate --help all`
 * lists them in the wrapper script names of the tarball).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { dirs } from "../../util/paths.js";
import {
  readBodyLimited,
  ResponseTooLargeError,
} from "../../util/http-body.js";
import { log } from "../../util/log.js";
import { fetchError } from "./errors.js";
import type { RawResponse, Rung, RungRequest } from "./types.js";

const CURL_IMPERSONATE_VERSION = "v2.2.3";

/**
 * Browser profiles tried on the direct rung, in order. All four were
 * verified against a Cloudflare-fronted page from a datacenter IP on
 * 2026-09-30 (plain curl: 403; each of these: 200).
 */
export const DEFAULT_TARGETS: readonly string[] = [
  "safari184",
  "chrome146",
  "firefox147",
];

type Asset = { triple: string; sha256: string };

/**
 * Pinned release assets, keyed `${process.platform}-${process.arch}`.
 * Linux uses the static musl builds so glibc version and Alpine/Docker
 * don't matter (32-bit ARM has no musl build; gnueabihf it is).
 */
const ASSETS: Readonly<Record<string, Asset>> = {
  "linux-x64": {
    triple: "x86_64-linux-musl",
    sha256: "288332a313e9edd884a1575c2627844fd9f3388fcefc62982b6b4eae12828357",
  },
  "linux-arm64": {
    triple: "aarch64-linux-musl",
    sha256: "18000c51542fe63f0acc5cd3d89fb2217e35574f4c2911aec33e6774973a0809",
  },
  "linux-arm": {
    triple: "arm-linux-gnueabihf",
    sha256: "bdfba66572546a5331a31e36be99bbbcfa1cbe78cf2175088f2c0ff9d7f6757f",
  },
  "darwin-x64": {
    triple: "x86_64-macos",
    sha256: "4686806d59abea93866a917c3025a049ef3d7a3240de742ad66bd1a4d9890dc7",
  },
  "darwin-arm64": {
    triple: "arm64-macos",
    sha256: "2569f4139460fcb301484d37938de91b1c220efd15487ee22a9db554262062fe",
  },
  "win32-x64": {
    triple: "x86_64-win32",
    sha256: "26085abd9e16139a1394197318dbf4ccea51810e7c1baaab12b348e28553ef4d",
  },
};

const DOWNLOAD_TIMEOUT_MS = 90_000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
/** After a failed install, don't retry on every fetch — once an hour. */
const INSTALL_RETRY_MS = 60 * 60 * 1000;

/** The pinned asset for this host, or undefined when unsupported. */
export function assetFor(
  platform: string = process.platform,
  arch: string = process.arch,
): (Asset & { url: string; exe: string }) | undefined {
  const asset = ASSETS[`${platform}-${arch}`];
  if (!asset) return undefined;
  const v = CURL_IMPERSONATE_VERSION;
  return {
    ...asset,
    url: `https://github.com/lexiforest/curl-impersonate/releases/download/${v}/curl-impersonate-${v}.${asset.triple}.tar.gz`,
    exe: platform === "win32" ? "curl-impersonate.exe" : "curl-impersonate",
  };
}

// ── tar extraction ──────────────────────────────────────────────────────────

/**
 * Pull one regular file out of an uncompressed ustar archive. The release
 * tarballs are flat (optionally "./"-prefixed), so no long-name or pax
 * handling is needed; anything else is simply not found.
 */
export function extractTarMember(tar: Buffer, name: string): Buffer | null {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive block
    const rawName = header
      .subarray(0, 100)
      .toString("utf8")
      .replace(/\0.*$/s, "");
    const prefix = header
      .subarray(345, 500)
      .toString("utf8")
      .replace(/\0.*$/s, "");
    const full = (prefix ? `${prefix}/${rawName}` : rawName).replace(
      /^\.\//,
      "",
    );
    const size = parseInt(
      header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() ||
        "0",
      8,
    );
    const type = String.fromCharCode(header[156] || 48); // NUL = regular file
    const start = offset + 512;
    if (full === name && (type === "0" || type === "\0")) {
      return tar.subarray(start, start + size);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

// ── install ─────────────────────────────────────────────────────────────────

type InstallOptions = {
  /** Install root (default ~/.talon/bin). */
  root?: string;
  /** Download seam for tests. */
  download?: (url: string) => Promise<Buffer>;
  platform?: string;
  arch?: string;
};

async function defaultDownload(url: string): Promise<Buffer> {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!resp.ok) throw fetchError(`HTTP ${resp.status} for ${url}`);
  return await readBodyLimited(resp, MAX_ARCHIVE_BYTES);
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Install the pinned curl-impersonate for this host and return the
 * executable's path. Idempotent: an existing install is re-verified
 * against the digest recorded when it was extracted.
 */
export async function installCurlImpersonate(
  opts: InstallOptions = {},
): Promise<string> {
  const asset = assetFor(opts.platform, opts.arch);
  if (!asset) {
    throw fetchError(
      `no pinned curl-impersonate build for ${opts.platform ?? process.platform}-${opts.arch ?? process.arch}; set fetch.curlImpersonatePath`,
    );
  }
  const dir = join(
    opts.root ?? dirs.bin,
    `curl-impersonate-${CURL_IMPERSONATE_VERSION}`,
  );
  const exe = join(dir, asset.exe);
  const marker = `${exe}.sha256`;
  if (existsSync(exe) && existsSync(marker)) {
    const [recorded, actual] = await Promise.all([
      readFile(marker, "utf8").then((s) => s.trim()),
      readFile(exe).then(sha256),
    ]);
    if (recorded && recorded === actual) return exe;
    log(
      "fetch",
      `curl-impersonate at ${exe} failed its digest check; reinstalling`,
    );
  }

  const archive = await (opts.download ?? defaultDownload)(asset.url);
  const got = sha256(archive);
  if (got !== asset.sha256) {
    throw fetchError(
      `curl-impersonate archive digest mismatch (expected ${asset.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…) — refusing it`,
    );
  }
  const binary = extractTarMember(gunzipSync(archive), asset.exe);
  if (!binary || binary.length === 0) {
    throw fetchError(`${asset.exe} not found in ${asset.url}`);
  }
  await mkdir(dir, { recursive: true });
  const tmp = `${exe}.${process.pid}.tmp`;
  await writeFile(tmp, binary);
  await chmod(tmp, 0o755);
  await rename(tmp, exe);
  await writeFile(marker, `${sha256(binary)}\n`);
  log(
    "fetch",
    `Installed curl-impersonate ${CURL_IMPERSONATE_VERSION} → ${exe}`,
  );
  return exe;
}

/**
 * Process-wide resolver: explicit path > cached install > first-use
 * download. Failures are remembered for an hour so a host without
 * GitHub access doesn't pay a download timeout on every fetch.
 */
let installing: Promise<string> | null = null;
let failedAt = 0;
let failure = "";

export async function resolveCurlImpersonate(
  explicitPath?: string,
): Promise<string> {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw fetchError(
        `fetch.curlImpersonatePath ${explicitPath} does not exist`,
      );
    }
    return explicitPath;
  }
  if (failedAt && Date.now() - failedAt < INSTALL_RETRY_MS) {
    throw fetchError(failure);
  }
  installing ??= installCurlImpersonate().catch((err: unknown) => {
    installing = null;
    failedAt = Date.now();
    failure = `curl-impersonate unavailable: ${err instanceof Error ? err.message : String(err)}`;
    log("fetch", failure);
    throw fetchError(failure);
  });
  return await installing;
}

// ── the rung ────────────────────────────────────────────────────────────────

/** Proxy for a rung: URL without credentials, credentials kept apart. */
export type ProxySpec = { url: string; user?: string; pass?: string };

/** Quote a value for a curl config file (`-K`): double quotes, escaped. */
function curlConfigValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Parse the last header block curl wrote with `-D`. */
export function parseHeaderDump(dump: string): Headers {
  const blocks = dump.split(/\r?\n\r?\n/).filter((b) => b.trim());
  const last = blocks[blocks.length - 1] ?? "";
  const headers = new Headers();
  for (const line of last.split(/\r?\n/).slice(1)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    try {
      headers.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
    } catch {
      /* a header Headers refuses is not one we need */
    }
  }
  return headers;
}

/** Thrown when curl gave no HTTP answer (DNS, connect, TLS, timeout). */
class CurlTransportError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

/** curl exit code for --max-filesize. */
const CURL_FILESIZE_EXCEEDED = 63;

type RunCurl = (
  exe: string,
  args: string[],
  stdin: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const runCurl: RunCurl = (exe, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin);
  });

export type CurlRungOptions = {
  target: string;
  proxy?: ProxySpec;
  /** Label for the proxy in `via` (host only — never credentials). */
  proxyLabel?: string;
  /** Resolves the executable (download on first use by default). */
  resolveExe?: () => Promise<string>;
  /** Process seam for tests. */
  run?: RunCurl;
};

/** A single-hop curl-impersonate request (the ladder follows redirects). */
export function curlImpersonateRung(opts: CurlRungOptions): Rung {
  const resolveExe = opts.resolveExe ?? (() => resolveCurlImpersonate());
  const run = opts.run ?? runCurl;
  const name = opts.proxyLabel
    ? `impersonate:${opts.target}@${opts.proxyLabel}`
    : `impersonate:${opts.target}`;
  return {
    name,
    relayed: !!opts.proxy,
    followsRedirects: false,
    publicOnly: true,
    async available() {
      try {
        await resolveExe();
        return true;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    async request(req: RungRequest): Promise<RawResponse> {
      const exe = await resolveExe();
      const work = await mkdtemp(join(tmpdir(), "talon-fetch-"));
      const headerFile = join(work, "headers");
      const bodyFile = join(work, "body");
      try {
        const args = [
          "--impersonate",
          opts.target,
          "--compressed",
          "--silent",
          "--show-error",
          "--proto",
          "=http,https",
          "--max-time",
          String(Math.max(1, Math.ceil(req.timeoutMs / 1000))),
          "--max-filesize",
          String(req.maxBytes),
          "--dump-header",
          headerFile,
          "--output",
          bodyFile,
          "--write-out",
          "%{http_code}",
          // Config on stdin: proxy credentials never appear in argv (ps).
          "--config",
          "-",
        ];
        if (req.cookieJar)
          args.push("--cookie", req.cookieJar, "--cookie-jar", req.cookieJar);
        if (req.pinnedAddresses?.length && !opts.proxy) {
          const port =
            req.url.port || (req.url.protocol === "https:" ? "443" : "80");
          const host = req.url.hostname.replace(/^\[|\]$/g, "");
          const addrs = req.pinnedAddresses
            .map((a) => (a.includes(":") ? `[${a}]` : a))
            .join(",");
          args.push("--resolve", `${host}:${port}:${addrs}`);
        }
        for (const [k, v] of Object.entries(req.headers)) {
          args.push("--header", `${k}: ${v}`);
        }
        args.push("--url", req.url.href);

        const config: string[] = [];
        if (opts.proxy) {
          config.push(`proxy = ${curlConfigValue(opts.proxy.url)}`);
          if (opts.proxy.user !== undefined) {
            config.push(
              `proxy-user = ${curlConfigValue(`${opts.proxy.user}:${opts.proxy.pass ?? ""}`)}`,
            );
          }
        }
        const { code, stdout, stderr } = await run(
          exe,
          args,
          `${config.join("\n")}\n`,
        );
        const status = Number(stdout.trim().slice(-3)) || 0;
        if (code === CURL_FILESIZE_EXCEEDED) {
          throw new ResponseTooLargeError();
        }
        if (code !== 0 || status === 0) {
          throw new CurlTransportError(
            (stderr.trim().split("\n").pop() ?? "") || `curl exited ${code}`,
            code,
          );
        }
        const [dump, body] = await Promise.all([
          readFile(headerFile, "latin1").catch(() => ""),
          readFile(bodyFile).catch(() => Buffer.alloc(0)),
        ]);
        return {
          status,
          headers: parseHeaderDump(dump),
          body,
          url: req.url.href,
        };
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

/**
 * Seam for a second impersonation engine. A curl_cffi sidecar
 * (`python3 -c` reading a JSON request on stdin) fits here unchanged: it
 * only has to return a Rung for a (target, proxy) pair. Not implemented:
 * curl-impersonate needs no Python and is the engine curl_cffi wraps.
 */
export type ImpersonationEngine = (opts: CurlRungOptions) => Rung;
