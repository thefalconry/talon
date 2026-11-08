# Fetch ladder

`fetch_url` doesn't give up at the first bot wall. It climbs a ladder of
fetch methods, cheapest and most honest first, and stops as soon as one
returns the page — or as soon as the server gives a definitive answer
(a 404 means the URL is wrong, and no rung will change that).

Code: `src/core/fetch/` (`ladder.ts` runs the climb, `classify.ts` decides
blocked vs. bad URL, `curl-impersonate.ts` and `rungs.ts` are the rungs).

## Why it works

Most bot walls (Cloudflare, Akamai, DataDome, Imperva "bot fight" tiers)
first look at the **TLS and HTTP/2 fingerprint** (JA3/JA4, SETTINGS
frames, header order), and only then at the IP. curl, Node and Bun each
have a fixed, well-known fingerprint, and neither runtime lets you change
it. A client that presents a real browser's handshake gets through from a
datacenter IP that plain curl can't use.

Checked on 2026-09-30 from a datacenter VPS against a Cloudflare-fronted
page: plain curl got 403 (5 KB challenge), and every VPN exit got 403 as
well. `curl-impersonate --impersonate safari184` (also `safari170`,
`chrome146`, `firefox147`) got 200 and the full 605 KB page, direct.
Free open-proxy lists were also tested; none of the 20 worked, so they are
not a rung.

## The rungs

| #   | Rung (`via` name)              | What it is                                                                                                                        | Default        |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| a   | `impersonate:<profile>`        | curl-impersonate with a browser TLS/HTTP2 profile, direct. Each profile in `impersonateTargets` is tried in order.                | on             |
| b   | `impersonate:<profile>@<exit>` | The first profile through each SOCKS exit in `socksExits` — for sites that block the IP too.                                      | off (no exits) |
| c   | `plain`                        | The runtime's own `fetch`, `User-Agent: Talon/1.0`. Some sites dislike impersonation; it is also the only rung for local targets. | on             |
| d   | `camoufox`                     | An anti-detect browser (Camoufox over the Playwright protocol) for JavaScript challenges. Returns the rendered DOM.               | off            |
| e   | `egress:<device>`              | `curl` run on a mesh device you name (a laptop on a residential line). Last resort, never a dependency.                           | off            |

The tool result ends with `[fetched via <rung>]`; each attempt is logged
at debug level as `fetch via <rung>: HTTP <status> <bytes>B → <verdict>`.

### Blocked, wrong URL, or down?

Every answer is classified (`classify.ts`):

- **blocked** — 403, 429, 503, 999, or a small page carrying a known
  challenge marker (Cloudflare "Just a moment…", DataDome, Imperva,
  PerimeterX, Akamai "Access Denied … Reference #"). The ladder climbs on.
- **network** — no HTTP answer (timeout, reset, DNS). The ladder climbs on.
- **not-found** — 404 or 410. The ladder **stops** and says the URL is
  wrong, not blocked. Retrying a 404 through every exit only hammers the
  site and then misreports a block.
- **http-error** — any other status (401, 500, …). The ladder stops.

A 2xx page that only _looks_ like a challenge is kept as a fallback: if
no rung does better, it is returned with a caveat in the footer, so a
false positive in the marker scan costs extra rungs, never the content.

When every rung fails the error lists each one, e.g.
`Blocked on every rung (impersonate:safari184 HTTP 403, plain HTTP 403,
camoufox skipped (…)). … a bot wall, not a bad URL.`

### Local targets

Loopback, private and link-local hosts (literal, `localhost`, `*.local`,
`*.internal`, `*.lan`, `*.home.arpa`, or names that resolve there) only
get the `plain` rung: a home-lab page has no bot wall, and an exit or a
remote device can't reach it.

## TLS impersonation: curl-impersonate

Options considered:

1. **curl-impersonate binary** (chosen). One static executable per
   platform (BoringSSL build of curl with `--impersonate <browser>`), from
   [lexiforest/curl-impersonate](https://github.com/lexiforest/curl-impersonate).
   No Python, no pip, no native addon; works the same under Bun and Node.
   It is the engine `curl_cffi` wraps, so it gets the same results.
2. **curl_cffi Python sidecar.** Proven on this host, but it needs
   `python3` plus a pip package on every install. The rung factory type
   (`ImpersonationEngine` in `curl-impersonate.ts`) is the seam: a sidecar
   only has to return a `Rung` for a (profile, proxy) pair.
3. **A custom TLS profile in Bun's fetch.** Not possible: Bun exposes no
   ClientHello/HTTP2 fingerprint control (neither does Node).

The binary is pinned by release **and** per-asset sha256
(`ASSETS` in `curl-impersonate.ts`) and downloaded on first use into
`~/.talon/bin/curl-impersonate-<version>/`. A digest mismatch refuses the
binary; the extracted executable's own digest is recorded and re-checked
before reuse. Linux uses the static musl builds (glibc version and
Alpine/Docker don't matter). A failed install is retried at most hourly,
and the rung reports itself skipped meanwhile. Hosts without GitHub access
(or packagers) can set `fetch.curlImpersonatePath` to a system copy.

Each request runs as a single hop (`--impersonate <profile> --compressed
--proto =http,https --max-filesize …`); the ladder follows redirects itself
so the SSRF guard sees every hop, with a per-attempt cookie jar so
challenge cookies survive the redirect chain. Proxy settings go to curl on
stdin (`--config -`), so SOCKS credentials never appear in `ps`.

To bump: change `CURL_IMPERSONATE_VERSION`, recompute every sha256
(`sha256sum curl-impersonate-<v>.<triple>.tar.gz`), and check the default
profiles still exist (the tarball ships a `curl_<profile>` wrapper per
profile).

## Config

```jsonc
{
  "fetch": {
    "impersonate": true, // rung (a)/(b); default true
    "impersonateTargets": ["safari184", "chrome146", "firefox147"],
    "curlImpersonatePath": "/usr/local/bin/curl-impersonate", // optional
    "socksExits": [
      // rung (b); default []
      "socks5h://socks-nl1.nordvpn.com:1080",
      "socks5h://socks-se10.nordvpn.com:1080",
    ],
    "socksCredentialsFile": "/home/me/.talon/secrets/socks.txt", // "user:pass"
    "camoufox": false, // rung (d)
    "browserEndpoint": "ws://localhost:9323/camoufox", // default: playwright.endpoint(File)
    "egressDevice": "my-laptop", // rung (e); unset = off
    "dailyByteCap": 104857600, // bytes/day through (b) and (e)
  },
  "fetchUrl": { "allowPrivateNetworks": true }, // SSRF guard, unchanged
}
```

- **Credentials never go in config.json.** The schema refuses a SOCKS URL
  with a username or password. Set `TALON_FETCH_SOCKS_USER` /
  `TALON_FETCH_SOCKS_PASS`, or point `socksCredentialsFile` at a one-line
  `user:pass` file (mode 600). The same credentials are used for every
  exit (the common case: one VPN account, many servers).
- Use `socks5h://` so the exit resolves the name (no DNS leak, and the
  exit's view of DNS is the one that matters).
- `dailyByteCap` counts bytes through relayed rungs (SOCKS exits, egress
  device) per UTC day; `0` disables those rungs. The counter is in memory,
  so a restart resets it. Direct rungs are uncapped.
- The Camoufox rung connects to the same server the playwright plugin uses
  (its `endpoint` or `endpointFile`) unless `browserEndpoint` is set. The
  driver runs in a `node` child process because Playwright's WebSocket
  client does not connect under Bun; `node` must be on `PATH`. It reuses
  the playwright-core bundled with `@playwright/mcp`, which is already
  pinned to the Camoufox server's Playwright minor version.
- The egress rung runs `curl` through `device_exec` on a POSIX-shell
  device. Output travels as text, so it suits HTML/JSON pages, not
  binaries.

### With the SSRF guard on

With `fetchUrl.allowPrivateNetworks: false` every hop of every curl and
plain rung is checked before it is sent, and curl rungs are pinned to the
checked addresses (`--resolve`), which also closes the DNS-rebinding race
the plain rung still has. Requests through a SOCKS exit are resolved by
the exit. The Camoufox rung is skipped under the guard: a page loads
subresources and follows redirects inside the browser, out of reach of the
per-hop check.

## Etiquette

The ladder exists so research doesn't dead-end on a datacenter IP — not to
defeat site owners.

- **Research pages only.** Fetch the page you need to read, once. No bulk
  crawling, no scraping loops, no "fetch every link".
- **No paywall or login bypass.** A 401, a login wall or a subscriber page
  is an answer, not a block. The ladder stops on 401 and does not carry
  credentials or cookies between fetches.
- **Cache what you fetched** rather than hitting the same page repeatedly.
- **Relayed rungs are other people's links.** SOCKS exits and the egress
  device cost someone bandwidth and reputation; the daily cap is there for
  that reason. Leave the egress device off unless you need it.
- A 404 is a wrong URL. Find the right address (site search, sitemap,
  the page's links) instead of retrying.

## Testing

- `src/__tests__/fetch-ladder.test.ts` — offline: rung ordering, blocked /
  not-found / error classification against a local mock server, redirect
  guarding, byte cap, config → rungs, and the curl / browser / egress
  adapters with injected processes.
- `src/__tests__/fetch-ladder.live.test.ts` — network, skipped unless
  `TALON_FETCH_LIVE=1`: installs the pinned binary for this platform
  (verifying the digest), checks the fingerprint an echo service sees, and
  with `TALON_FETCH_LIVE_URL=<walled page>` runs the full ladder.
