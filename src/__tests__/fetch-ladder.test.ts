/**
 * Fetch ladder (core/fetch): rung ordering, blocked vs bad-URL
 * classification, redirect guarding, byte caps, config → rungs, and the
 * curl-impersonate / egress adapters — all offline, against a local mock
 * server or fake rungs.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fetchConfigSchema } from "../core/config/index.js";
import {
  classifyResponse,
  looksLikeChallenge,
} from "../core/fetch/classify.js";
import {
  assetFor,
  curlImpersonateRung,
  extractTarMember,
  installCurlImpersonate,
  parseHeaderDump,
} from "../core/fetch/curl-impersonate.js";
import { buildRungs, socksCredentials } from "../core/fetch/index.js";
import {
  DailyByteBudget,
  FetchLadder,
  isPrivateTarget,
} from "../core/fetch/ladder.js";
import {
  browserRung,
  egressRung,
  plainRung,
  shellQuote,
} from "../core/fetch/rungs.js";
import type { RawResponse, Rung, RungRequest } from "../core/fetch/types.js";
import type { Resolver } from "../core/engine/gateway-actions/fetch-url/guard.js";

const CF_CHALLENGE = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body><div id="cf-chl-widget"></div><script>window._cf_chl_opt={}</script></body></html>`;
const ARTICLE = `<html><body><h1>Research</h1>${"<p>Real content paragraph.</p>".repeat(50)}</body></html>`;

// ── mock server ─────────────────────────────────────────────────────────────

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    const html = (status: number, body: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    if (path === "/ok") return html(200, ARTICLE);
    if (path === "/wall") return html(403, CF_CHALLENGE);
    if (path === "/challenge200") return html(200, CF_CHALLENGE);
    if (path === "/missing")
      return html(
        404,
        `<html><body>${"Not found. ".repeat(500)}</body></html>`,
      );
    if (path === "/boom") return html(500, "oops");
    if (path === "/redirect") {
      res.writeHead(302, { location: "/ok" });
      return res.end();
    }
    if (path === "/wall-unless-browser") {
      return req.headers["x-browser"] === "yes"
        ? html(200, ARTICLE)
        : html(403, CF_CHALLENGE);
    }
    html(404, "?");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

// ── helpers ─────────────────────────────────────────────────────────────────

/** A rung that talks to the mock server through the plain rung, plus extra headers. */
function serverRung(
  name: string,
  extra: Record<string, string> = {},
  over: Partial<Rung> = {},
): Rung & { calls: number } {
  const plain = plainRung();
  const rung = {
    name,
    relayed: false,
    followsRedirects: false,
    publicOnly: false,
    calls: 0,
    async available(): Promise<true | string> {
      return true;
    },
    async request(req: RungRequest): Promise<RawResponse> {
      rung.calls++;
      return plain.request({ ...req, headers: { ...req.headers, ...extra } });
    },
    ...over,
  };
  return rung;
}

/** A canned-response rung for guard/redirect cases with fake hosts. */
function scriptedRung(
  responses: Array<RawResponse | Error>,
  over: Partial<Rung> = {},
): Rung & { urls: string[] } {
  const urls: string[] = [];
  return {
    name: "scripted",
    relayed: false,
    followsRedirects: false,
    publicOnly: true,
    urls,
    async available() {
      return true;
    },
    async request(req) {
      urls.push(req.url.href);
      const next = responses.shift() ?? new Error("no more responses");
      if (next instanceof Error) throw next;
      return next;
    },
    ...over,
  };
}

const resp = (
  status: number,
  body = "",
  headers: Record<string, string> = {},
): RawResponse => ({
  status,
  headers: new Headers(headers),
  body: Buffer.from(body),
  url: "",
});

const publicResolver: Resolver = async () => ["93.184.215.14"];

function ladder(
  rungs: Rung[],
  extra: Partial<ConstructorParameters<typeof FetchLadder>[0]> = {},
) {
  return new FetchLadder({
    rungs,
    allowPrivateNetworks: true,
    maxBytes: 1024 * 1024,
    resolve: publicResolver,
    ...extra,
  });
}

// ── classification ──────────────────────────────────────────────────────────

describe("classifyResponse", () => {
  it.each([403, 429, 503, 999])("treats %i as blocked", (status) => {
    expect(classifyResponse(status, Buffer.from("x"))).toBe("blocked");
  });

  it.each([404, 410])(
    "treats %i as not-found (a bad URL, not a block)",
    (status) => {
      expect(classifyResponse(status, Buffer.from("<html>gone</html>"))).toBe(
        "not-found",
      );
    },
  );

  it("treats other errors as definitive http errors", () => {
    expect(classifyResponse(500, Buffer.from("oops"))).toBe("http-error");
    expect(classifyResponse(401, Buffer.from("login"))).toBe("http-error");
  });

  it("flags a 200 challenge interstitial as blocked", () => {
    expect(classifyResponse(200, Buffer.from(CF_CHALLENGE))).toBe("blocked");
  });

  it("does not flag ordinary pages that load Cloudflare's scripts", () => {
    const page = `<html><body><p>Hello</p><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body></html>`;
    expect(classifyResponse(200, Buffer.from(page))).toBe("ok");
  });

  it("ignores markers in large bodies", () => {
    const big = `${CF_CHALLENGE}${"x".repeat(40_000)}`;
    expect(looksLikeChallenge(big)).toBe(false);
  });
});

// ── the climb ───────────────────────────────────────────────────────────────

describe("FetchLadder", () => {
  it("climbs past a blocked rung to the first one that gets content", async () => {
    const a = serverRung("a");
    const b = serverRung("b", { "x-browser": "yes" });
    const c = serverRung("c");
    const result = await ladder([a, b, c]).fetch(`${base}/wall-unless-browser`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.via).toBe("b");
    expect(result.body.toString()).toContain("Real content");
    expect(result.attempts.map((x) => [x.via, x.verdict, x.status])).toEqual([
      ["a", "blocked", 403],
      ["b", "ok", 200],
    ]);
    expect(c.calls).toBe(0);
  });

  it("stops on a 404 and says it is a wrong URL, not a block", async () => {
    const a = serverRung("a");
    const b = serverRung("b");
    const result = await ladder([a, b]).fetch(`${base}/missing`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.verdict).toBe("not-found");
    expect(result.error).toMatch(/^HTTP 404 via a — /);
    expect(result.error).toContain("wrong URL, not a block");
    expect(b.calls).toBe(0);
  });

  it("stops on other definitive errors", async () => {
    const b = serverRung("b");
    const result = await ladder([serverRung("a"), b]).fetch(`${base}/boom`);
    expect(result).toMatchObject({
      ok: false,
      verdict: "http-error",
      error: "HTTP 500 via a",
    });
    expect(b.calls).toBe(0);
  });

  it("reports a block honestly when every rung is walled", async () => {
    const result = await ladder([serverRung("a"), serverRung("b")]).fetch(
      `${base}/wall`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.verdict).toBe("blocked");
    expect(result.error).toContain(
      "Blocked on every rung (a HTTP 403, b HTTP 403)",
    );
    expect(result.error).toContain("not a bad URL");
  });

  it("keeps a 2xx challenge-looking page as a caveated fallback", async () => {
    const result = await ladder([serverRung("a"), serverRung("b")]).fetch(
      `${base}/challenge200`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.via).toBe("a");
    expect(result.note).toMatch(/bot-check/);
  });

  it("follows redirects for rungs that don't", async () => {
    const result = await ladder([serverRung("a")]).fetch(`${base}/redirect`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toBe(`${base}/ok`);
  });

  it("moves on after a network error and records it", async () => {
    const broken = scriptedRung([new Error("ECONNRESET")], {
      name: "broken",
      publicOnly: false,
    });
    const result = await ladder([broken, serverRung("a")]).fetch(`${base}/ok`);
    expect(result.ok).toBe(true);
    expect(result.attempts[0]).toMatchObject({
      via: "broken",
      verdict: "network",
      detail: "ECONNRESET",
    });
  });

  it("records unavailable rungs as skipped with the reason", async () => {
    const missing = serverRung(
      "imp",
      {},
      { available: async () => "curl-impersonate unavailable" },
    );
    const result = await ladder([missing, serverRung("a")]).fetch(`${base}/ok`);
    expect(result.attempts[0]).toMatchObject({
      via: "imp",
      verdict: "skipped",
      detail: "curl-impersonate unavailable",
    });
    expect(missing.calls).toBe(0);
  });

  it("only uses local-capable rungs for private targets", async () => {
    const remote = serverRung("exit", {}, { publicOnly: true });
    const local = serverRung("plain");
    const result = await new FetchLadder({
      rungs: [remote, local],
      allowPrivateNetworks: true,
      maxBytes: 1 << 20,
    }).fetch(`${base}/ok`);
    expect(result.ok && result.via).toBe("plain");
    expect(remote.calls).toBe(0);
  });

  it("skips relayed rungs once the daily byte cap is spent, and counts their bytes", async () => {
    const budget = new DailyByteBudget(10);
    const relay = serverRung("relay", {}, { relayed: true });
    const first = await ladder([relay], { byteBudget: budget }).fetch(
      `${base}/ok`,
    );
    expect(first.ok).toBe(true);
    expect(budget.exhausted()).toBe(true);
    const second = await ladder([relay, serverRung("plain")], {
      byteBudget: budget,
    }).fetch(`${base}/ok`);
    expect(second.attempts[0]).toMatchObject({
      via: "relay",
      verdict: "skipped",
      detail: "daily byte cap reached",
    });
    expect(second.ok && second.via).toBe("plain");
  });

  it("resets the byte budget at UTC midnight", () => {
    let t = Date.parse("2026-09-30T23:59:00Z");
    const budget = new DailyByteBudget(5, () => t);
    budget.add(10);
    expect(budget.exhausted()).toBe(true);
    t = Date.parse("2026-10-01T00:00:01Z");
    expect(budget.exhausted()).toBe(false);
  });

  it("skips rungs once the time budget is used up", async () => {
    let t = 0;
    const slow = scriptedRung([resp(403, "no")], {
      name: "slow",
      publicOnly: false,
      request: async () => {
        t += 10_000;
        return resp(403, "no");
      },
    });
    const next = serverRung("next");
    const result = await ladder([slow, next], {
      budgetMs: 11_000,
      now: () => t,
    }).fetch(`${base}/ok`);
    expect(result.attempts[1]).toMatchObject({
      via: "next",
      verdict: "skipped",
      detail: "time budget used up",
    });
    expect(next.calls).toBe(0);
  });

  describe("with the SSRF guard on", () => {
    const guarded = (rungs: Rung[], resolve: Resolver = publicResolver) =>
      new FetchLadder({
        rungs,
        allowPrivateNetworks: false,
        maxBytes: 1 << 20,
        resolve,
      });

    it("never contacts a blocked host", async () => {
      const rung = scriptedRung([resp(200, "secret")]);
      const result = await guarded([rung]).fetch("http://169.254.169.254/");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/Refusing/);
      expect(rung.urls).toEqual([]);
    });

    it("re-checks each redirect and refuses one into a private address", async () => {
      const rung = scriptedRung([
        resp(302, "", { location: "https://hop.example/next" }),
        resp(307, "", { location: "http://127.0.0.1:19876/admin" }),
      ]);
      const result = await guarded([rung]).fetch("https://start.example/");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/Refusing to fetch 127\.0\.0\.1/);
      expect(rung.urls).toEqual([
        "https://start.example/",
        "https://hop.example/next",
      ]);
    });

    it("refuses a redirect to a name that resolves privately", async () => {
      const rung = scriptedRung([
        resp(302, "", { location: "http://sneaky.example/" }),
      ]);
      const resolve: Resolver = async (host) =>
        host === "sneaky.example" ? ["192.168.0.10"] : ["93.184.215.14"];
      const result = await guarded([rung], resolve).fetch(
        "https://start.example/",
      );
      expect(!result.ok && result.error).toMatch(/192\.168\.0\.10/);
    });

    it("pins each hop to the addresses it checked", async () => {
      const seen: Array<readonly string[] | undefined> = [];
      const rung = scriptedRung([resp(200, ARTICLE)], {
        request: async (req) => {
          seen.push(req.pinnedAddresses);
          return resp(200, ARTICLE);
        },
      });
      await guarded([rung]).fetch("https://start.example/");
      expect(seen).toEqual([["93.184.215.14"]]);
    });

    it("follows public relative redirects and caps the chain", async () => {
      const ok = scriptedRung([
        resp(301, "", { location: "/relative" }),
        resp(200, ARTICLE),
      ]);
      const r1 = await guarded([ok]).fetch("https://start.example/a");
      expect(r1.ok).toBe(true);
      expect(ok.urls[1]).toBe("https://start.example/relative");

      const loop = scriptedRung(
        Array.from({ length: 10 }, () =>
          resp(302, "", { location: "https://loop.example/" }),
        ),
      );
      const r2 = await guarded([loop]).fetch("https://loop.example/");
      expect(!r2.ok && r2.error).toMatch(/Too many redirects/);
    });
  });
});

describe("isPrivateTarget", () => {
  it.each([
    "http://127.0.0.1/",
    "http://localhost:3000/",
    "http://nas.local/",
    "http://[::1]/",
  ])("%s is private", async (url) => {
    expect(await isPrivateTarget(new URL(url), publicResolver)).toBe(true);
  });

  it("resolves names", async () => {
    expect(
      await isPrivateTarget(new URL("http://lab.example/"), async () => [
        "10.0.0.5",
      ]),
    ).toBe(true);
    expect(
      await isPrivateTarget(new URL("https://example.com/"), publicResolver),
    ).toBe(false);
  });
});

// ── config → rungs ──────────────────────────────────────────────────────────

describe("buildRungs", () => {
  const engine = vi.fn((opts: { target: string; proxyLabel?: string }) => ({
    name: opts.proxyLabel
      ? `impersonate:${opts.target}@${opts.proxyLabel}`
      : `impersonate:${opts.target}`,
    relayed: !!opts.proxyLabel,
    followsRedirects: false,
    publicOnly: true,
    available: async () => true as const,
    request: async () => resp(200),
  }));

  it("orders impersonation → exits → plain → browser → egress", () => {
    const rungs = buildRungs(
      {
        fetch: {
          impersonateTargets: ["safari184", "chrome146"],
          socksExits: [
            "socks5h://socks-nl1.example:1080",
            "socks5h://socks-se1.example:1080",
          ],
          camoufox: true,
          browserEndpoint: "ws://localhost:9323/camoufox",
          egressDevice: "mac",
        },
      },
      { maxBytes: 1, engine: engine as never },
    );
    expect(rungs.map((r) => r.name)).toEqual([
      "impersonate:safari184",
      "impersonate:chrome146",
      "impersonate:safari184@socks-nl1.example",
      "impersonate:safari184@socks-se1.example",
      "plain",
      "camoufox",
      "egress:mac",
    ]);
    expect(rungs.filter((r) => r.relayed).map((r) => r.name)).toEqual([
      "impersonate:safari184@socks-nl1.example",
      "impersonate:safari184@socks-se1.example",
      "egress:mac",
    ]);
  });

  it("defaults to impersonation + plain, and honours impersonate: false", () => {
    const defaults = buildRungs(null, { maxBytes: 1, engine: engine as never });
    expect(defaults.map((r) => r.name)).toEqual([
      "impersonate:safari184",
      "impersonate:chrome146",
      "impersonate:firefox147",
      "plain",
    ]);
    const off = buildRungs(
      {
        fetch: { impersonate: false, socksExits: ["socks5h://x.example:1080"] },
      },
      {
        maxBytes: 1,
        engine: engine as never,
      },
    );
    expect(off.map((r) => r.name)).toEqual(["plain"]);
  });

  it("takes the browser endpoint from the playwright plugin config", () => {
    const rungs = buildRungs(
      {
        fetch: { camoufox: true, impersonate: false },
        playwright: { endpoint: "ws://h/c" },
      },
      { maxBytes: 1 },
    );
    expect(rungs.map((r) => r.name)).toEqual(["plain", "camoufox"]);
  });

  it("reads SOCKS credentials from env, never from config", () => {
    expect(
      socksCredentials(undefined, {
        TALON_FETCH_SOCKS_USER: "u",
        TALON_FETCH_SOCKS_PASS: "p",
      }),
    ).toEqual({
      user: "u",
      pass: "p",
    });
    expect(socksCredentials(undefined, {})).toBeUndefined();
  });
});

describe("fetch config schema", () => {
  it("refuses SOCKS URLs with inline credentials", () => {
    const r = fetchConfigSchema.safeParse({
      socksExits: ["socks5h://user:secret@socks.example:1080"],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("TALON_FETCH_SOCKS_USER");
  });

  it("refuses non-SOCKS proxies and accepts a clean exit", () => {
    expect(
      fetchConfigSchema.safeParse({ socksExits: ["http://proxy.example:8080"] })
        .success,
    ).toBe(false);
    const ok = fetchConfigSchema.safeParse({
      socksExits: ["socks5h://socks-nl1.nordvpn.com:1080"],
    });
    expect(ok.success).toBe(true);
    expect(ok.data).toMatchObject({
      impersonate: true,
      camoufox: false,
      dailyByteCap: 100 * 1024 * 1024,
    });
  });
});

// ── curl-impersonate adapter ────────────────────────────────────────────────

describe("curlImpersonateRung", () => {
  it("passes the profile, pins addresses, and keeps proxy credentials out of argv", async () => {
    const run = vi.fn(async (_exe: string, args: string[], _stdin: string) => {
      const hdr = args[args.indexOf("--dump-header") + 1];
      const body = args[args.indexOf("--output") + 1];
      const { writeFile } = await import("node:fs/promises");
      await writeFile(hdr, "HTTP/2 200\r\ncontent-type: text/html\r\n\r\n");
      await writeFile(body, ARTICLE);
      return { code: 0, stdout: "200", stderr: "" };
    });
    const rung = curlImpersonateRung({
      target: "safari184",
      proxy: { url: "socks5h://socks.example:1080", user: "u", pass: "s3cret" },
      proxyLabel: "socks.example",
      resolveExe: async () => "/bin/curl-impersonate",
      run,
    });
    expect(rung.name).toBe("impersonate:safari184@socks.example");
    expect(rung.relayed).toBe(true);
    const res = await rung.request({
      url: new URL("https://site.example/p"),
      headers: {},
      timeoutMs: 20_000,
      maxBytes: 1000_000,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    const [, args, stdin] = run.mock.calls[0];
    expect(args.slice(0, 2)).toEqual(["--impersonate", "safari184"]);
    expect(args).toContain("--compressed");
    expect(args.join(" ")).not.toContain("s3cret");
    expect(stdin).toContain('proxy = "socks5h://socks.example:1080"');
    expect(stdin).toContain('proxy-user = "u:s3cret"');
  });

  it("pins the checked addresses on direct requests", async () => {
    const run = vi.fn(
      async (_exe: string, _args: string[], _stdin: string) => ({
        code: 0,
        stdout: "204",
        stderr: "",
      }),
    );
    const rung = curlImpersonateRung({
      target: "chrome146",
      resolveExe: async () => "x",
      run,
    });
    await rung.request({
      url: new URL("https://site.example/"),
      headers: {},
      timeoutMs: 5_000,
      maxBytes: 10,
      pinnedAddresses: ["93.184.215.14", "2606:2800::1"],
    });
    const args = run.mock.calls[0][1];
    expect(args[args.indexOf("--resolve") + 1]).toBe(
      "site.example:443:93.184.215.14,[2606:2800::1]",
    );
  });

  it("turns a curl failure into a network error and --max-filesize into too-large", async () => {
    const fail = curlImpersonateRung({
      target: "chrome146",
      resolveExe: async () => "x",
      run: async () => ({
        code: 6,
        stdout: "000",
        stderr: "curl: (6) Could not resolve host: nx.example",
      }),
    });
    const req = {
      url: new URL("https://nx.example/"),
      headers: {},
      timeoutMs: 5_000,
      maxBytes: 10,
    };
    await expect(fail.request(req)).rejects.toThrow(/Could not resolve host/);
    const big = curlImpersonateRung({
      target: "chrome146",
      resolveExe: async () => "x",
      run: async () => ({ code: 63, stdout: "200", stderr: "" }),
    });
    await expect(big.request(req)).rejects.toThrow();
  });

  it("reports itself unavailable when the binary can't be resolved", async () => {
    const rung = curlImpersonateRung({
      target: "safari184",
      resolveExe: async () => {
        throw new Error("no pinned build");
      },
    });
    expect(await rung.available()).toBe("no pinned build");
  });

  it("parses the last header block of a dump", () => {
    const h = parseHeaderDump(
      "HTTP/1.1 100 Continue\r\n\r\nHTTP/2 200\r\nContent-Type: text/plain\r\nX-A: 1\r\n\r\n",
    );
    expect(h.get("content-type")).toBe("text/plain");
    expect(h.get("x-a")).toBe("1");
  });
});

describe("curl-impersonate install", () => {
  /** A minimal ustar archive with the given members. */
  function tar(members: Record<string, string>): Buffer {
    const blocks: Buffer[] = [];
    for (const [name, content] of Object.entries(members)) {
      const header = Buffer.alloc(512);
      header.write(name, 0, "utf8");
      header.write(content.length.toString(8).padStart(11, "0"), 124, "utf8");
      header.write("0", 156, "utf8");
      blocks.push(header);
      const data = Buffer.alloc(Math.ceil(content.length / 512) * 512);
      data.write(content, 0, "utf8");
      blocks.push(data);
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
  }

  it("extracts a member, with or without a ./ prefix", () => {
    const archive = tar({
      LICENSE: "mit",
      "./curl-impersonate.exe": "MZbinary",
    });
    expect(extractTarMember(archive, "curl-impersonate.exe")?.toString()).toBe(
      "MZbinary",
    );
    expect(extractTarMember(archive, "missing")).toBeNull();
  });

  it("maps hosts to pinned assets", () => {
    expect(assetFor("linux", "x64")?.url).toMatch(
      /curl-impersonate-v[\d.]+\.x86_64-linux-musl\.tar\.gz$/,
    );
    expect(assetFor("win32", "x64")?.exe).toBe("curl-impersonate.exe");
    expect(assetFor("sunos", "sparc")).toBeUndefined();
  });

  it("refuses an archive whose digest doesn't match the pin", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "talon-ci-test-"));
    await expect(
      installCurlImpersonate({
        root,
        platform: "linux",
        arch: "x64",
        download: async () =>
          gzipSync(tar({ "curl-impersonate": "#!/bin/sh\necho evil" })),
      }),
    ).rejects.toThrow(/digest mismatch/);
  });
});

// ── egress device adapter ───────────────────────────────────────────────────

describe("egressRung", () => {
  it("runs curl on the device and parses status, type and redirect", async () => {
    const exec = vi.fn(async (_device: string, _cmd: string, _ms: number) => ({
      ok: true,
      stdout: `${ARTICLE}\n__TALON_FETCH__ 200  text/html; charset=utf-8`,
    }));
    const rung = egressRung("mac", exec);
    const res = await rung.request({
      url: new URL("https://site.example/it's"),
      headers: {},
      timeoutMs: 30_000,
      maxBytes: 1000,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.body.toString()).toBe(ARTICLE);
    const cmd = exec.mock.calls[0][1];
    expect(cmd).toContain(shellQuote("https://site.example/it's"));
    expect(cmd.startsWith("curl ")).toBe(true);
  });

  it("surfaces a redirect for the ladder to follow", async () => {
    const rung = egressRung("mac", async () => ({
      ok: true,
      stdout: "\n__TALON_FETCH__ 301 https://site.example/new text/html",
    }));
    const res = await rung.request({
      url: new URL("https://site.example/"),
      headers: {},
      timeoutMs: 5_000,
      maxBytes: 10,
    });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://site.example/new");
  });

  it("fails as a network error when the device gives no answer", async () => {
    const rung = egressRung("mac", async () => ({
      ok: false,
      stdout: "",
      error: "device offline",
    }));
    await expect(
      rung.request({
        url: new URL("https://site.example/"),
        headers: {},
        timeoutMs: 5_000,
        maxBytes: 10,
      }),
    ).rejects.toThrow("device offline");
  });
});

// ── anti-detect browser adapter ─────────────────────────────────────────────

describe("browserRung", () => {
  it("returns the rendered DOM as UTF-8 HTML with the navigation status", async () => {
    const run = vi.fn(async (_args: string[], _ms: number) => ({
      status: 200,
      url: "https://site.example/after-challenge",
      headers: { "content-type": "text/html", "content-encoding": "br" },
      html: ARTICLE,
    }));
    const rung = browserRung({
      endpoint: "ws://localhost:9323/camoufox",
      guard: false,
      corePath: () => "/nm/playwright-core/index.js",
      run,
    });
    expect(await rung.available()).toBe(true);
    const res = await rung.request({
      url: new URL("https://site.example/"),
      headers: {},
      timeoutMs: 45_000,
      maxBytes: 1 << 20,
    });
    expect(res).toMatchObject({
      status: 200,
      url: "https://site.example/after-challenge",
    });
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(run.mock.calls[0][0].slice(0, 3)).toEqual([
      "/nm/playwright-core/index.js",
      "ws://localhost:9323/camoufox",
      "https://site.example/",
    ]);
  });

  it("stays out of the ladder when the SSRF guard is on or playwright is missing", async () => {
    const guarded = browserRung({
      endpoint: "ws://x",
      guard: true,
      corePath: () => "/p",
    });
    expect(await guarded.available()).toMatch(/allowPrivateNetworks: false/);
    const missing = browserRung({
      endpoint: "ws://x",
      guard: false,
      corePath: () => undefined,
    });
    expect(await missing.available()).toMatch(/not installed/);
  });
});
