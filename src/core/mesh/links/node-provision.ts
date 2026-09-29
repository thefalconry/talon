/**
 * NodeProvisionStore — one-time grants that turn a fresh host into a mesh
 * node with a single command.
 *
 * The daemon mints a grant bound to one resolved binary (path + digest) and
 * one target platform; the bridge serves two UNAUTHENTICATED but
 * token-gated routes against it:
 *
 *   GET /node/install?provision=<token>   → installer script (once)
 *   GET /node/binary?provision=<token>    → the binary itself (once)
 *
 * The routes must work pre-auth — the whole point is a host that holds no
 * bridge credential yet — so the grant token IS the authorization, exactly
 * like streamed-transfer tokens (transfers/transfers.ts): random 192-bit, single-use
 * per leg, expiring unused. The script carries the bridge bearer token and
 * pinned TLS fingerprint into the node's config, verifies the downloaded
 * binary against the grant's digest, installs it, and registers the boot
 * service via `talon-node install`.
 *
 * Over HTTPS both fetches (script and binary) are pinned to the bridge's own
 * key — curl `--pinnedpubkey`, a certificate SHA-256 check on Windows — so a
 * man in the middle can neither swap the script nor read the grant's bearer
 * credential off the wire. Plain HTTP has nothing to pin.
 *
 * Every value that lands in generated sh/PowerShell text is validated to a
 * quote-safe alphabet at the edge ({@link checkBridgeUrl}, device names) and
 * escaped for its quoting context here anyway.
 */

import { randomBytes } from "node:crypto";

/** Unclaimed grants die after this long. */
const GRANT_TTL_MS = 30 * 60 * 1000;

export type NodeProvisionGrant = {
  token: string;
  goos: "linux" | "darwin" | "windows";
  goarch: string;
  /** Device name baked into the installer (optional — defaults to hostname). */
  name?: string;
  /** The resolved binary this grant serves. */
  binaryPath: string;
  sha256: string;
  size: number;
  version: string;
  /** Bridge base URL as reachable from the target host. */
  bridgeUrl: string;
  /** Bridge bearer token the node will authenticate with. */
  bearerToken: string;
  /** Bridge TLS certificate fingerprint to pre-pin (absent over plain HTTP). */
  fingerprint?: string;
  /** Base64 SHA-256 of the bridge key's SPKI — curl's pin (absent over HTTP). */
  spkiPin?: string;
  createdAt: number;
  scriptUsed: boolean;
  binaryUsed: boolean;
};

export class NodeProvisionStore {
  private readonly grants = new Map<string, NodeProvisionGrant>();

  constructor(private readonly ttlMs = GRANT_TTL_MS) {}

  create(
    grant: Omit<
      NodeProvisionGrant,
      "token" | "createdAt" | "scriptUsed" | "binaryUsed"
    >,
  ): NodeProvisionGrant {
    this.sweep();
    const full: NodeProvisionGrant = {
      ...grant,
      // Device names are injected into generated shell/PowerShell text —
      // keep them to characters that can't break out of a quoted string.
      ...(grant.name
        ? { name: grant.name.replace(/[^\w .-]+/g, "").slice(0, 64) }
        : {}),
      token: randomBytes(24).toString("base64url"),
      createdAt: Date.now(),
      scriptUsed: false,
      binaryUsed: false,
    };
    this.grants.set(full.token, full);
    return full;
  }

  /** Serve the installer script for a live grant — once. */
  openScript(token: string): { script: string; filename: string } | null {
    const grant = this.claim(token, "scriptUsed");
    if (!grant) return null;
    return grant.goos === "windows"
      ? {
          script: powershellInstaller(grant),
          filename: "install-talon-node.ps1",
        }
      : { script: shellInstaller(grant), filename: "install-talon-node.sh" };
  }

  /** Resolve the binary leg of a live grant — once. */
  openBinary(token: string): { path: string; size: number } | null {
    const grant = this.claim(token, "binaryUsed");
    if (!grant) return null;
    return { path: grant.binaryPath, size: grant.size };
  }

  /** Expire-check + single-use latch for one leg of a grant. */
  private claim(
    token: string,
    leg: "scriptUsed" | "binaryUsed",
  ): NodeProvisionGrant | null {
    this.sweep();
    const grant = this.grants.get(token);
    if (!grant || grant[leg]) return null;
    grant[leg] = true;
    if (grant.scriptUsed && grant.binaryUsed) this.grants.delete(token);
    return grant;
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [token, grant] of this.grants) {
      if (grant.createdAt < cutoff) this.grants.delete(token);
    }
  }
}

/**
 * Anything that could end, expand, or escape inside a quoted sh,
 * PowerShell, or cmd.exe string: both quote kinds, `$`, backtick,
 * backslash, `%` (cmd.exe expands `%VAR%` even inside quotes), and
 * everything outside printable ASCII — whitespace, control characters, and
 * the Unicode "smart" quotes PowerShell also treats as quotes.
 */
const UNSAFE_URL_CHAR = /["'`$\\%]|[^\x21-\x7e]/;

/**
 * Validate a bridge base URL before it is baked into installer scripts: an
 * http(s) URL with a host, made only of characters that are inert in every
 * quoting context the installers use. Returns the URL without trailing
 * slashes, or why it was refused.
 */
export function checkBridgeUrl(
  raw: string,
  label = "bridge_url",
): string | { error: string } {
  const url = raw.trim().replace(/\/+$/, "");
  const refused = {
    error: `${label} must be a plain http(s) URL (no quotes, $, backticks, backslashes, % or whitespace), got ${JSON.stringify(url)}.`,
  };
  if (UNSAFE_URL_CHAR.test(url)) return refused;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refused;
  }
  const web = parsed.protocol === "http:" || parsed.protocol === "https:";
  return web && parsed.hostname ? url : refused;
}

// ── Quoting ──────────────────────────────────────────────────────────────────

/** Escape for a double-quoted POSIX sh string. */
function sh(value: string): string {
  return value.replace(/["$`\\]/g, "\\$&");
}

/** Escape for a double-quoted PowerShell string (backtick is the escape). */
function ps(value: string): string {
  return value.replace(/["$`“”„]/g, "`$&");
}

/** Escape for a single-quoted PowerShell string (quotes double up). */
function psq(value: string): string {
  return value.replace(/['‘’‚‛]/g, "$&$&");
}

/** Keep a value on one line — for `#` comment lines. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

// ── Pinning ──────────────────────────────────────────────────────────────────

/**
 * Pinned fetches for PowerShell, compiled with Add-Type so the certificate
 * callback is a real .NET delegate: a script-block callback only works on
 * the pipeline thread (Windows PowerShell 5.1's synchronous iwr), while
 * pwsh 7's HttpClient calls it from the thread pool, where no runspace
 * exists. HttpWebRequest's per-request callback exists on .NET Framework
 * 4.5+ and every .NET Core, so one source serves both shells; -IgnoreWarnings
 * because pwsh 7 would fail on WebRequest's obsolete warning.
 *
 * The check: the presented certificate's SHA-256 (BitConverter's `AB-CD-…`
 * form) must equal `[TalonPin]::Pin` — the same certificate hash talon-node
 * pins afterwards. An unset pin fails closed. The source holds no quotes,
 * `$` or `%`, so it survives a PowerShell single-quoted string inside a
 * cmd.exe (or PowerShell) double-quoted `-Command` argument.
 */
const PIN_TYPE_SOURCE =
  "using System;using System.IO;using System.Net;using System.Security.Cryptography;" +
  "public static class TalonPin{public static string Pin;" +
  "static WebResponse Open(string u){var r=(HttpWebRequest)WebRequest.Create(u);" +
  "r.ServerCertificateValidationCallback=(s,c,h,e)=>c!=null&&string.Equals(" +
  "BitConverter.ToString(SHA256.Create().ComputeHash(c.GetRawCertData())),Pin,StringComparison.OrdinalIgnoreCase);" +
  "return r.GetResponse();}" +
  "public static string Get(string u){using(var w=Open(u))using(var t=new StreamReader(w.GetResponseStream()))return t.ReadToEnd();}" +
  "public static void Save(string u,string p){using(var w=Open(u))using(var i=w.GetResponseStream())using(var o=File.Create(p))i.CopyTo(o);}}";

/** `abcd…` → `AB-CD-…`, the form BitConverter.ToString gives a hash. */
function dashedFingerprint(fingerprint: string): string {
  return (fingerprint.match(/.{2}/g) ?? []).join("-").toUpperCase();
}

/** PowerShell statements that load TalonPin and arm it with the pin. */
function psPinSetup(fingerprint: string): string {
  return (
    `if (-not ('TalonPin' -as [type])) { Add-Type -IgnoreWarnings -TypeDefinition '${psq(PIN_TYPE_SOURCE)}' }; ` +
    `[TalonPin]::Pin = '${psq(dashedFingerprint(fingerprint))}'`
  );
}

/**
 * curl flags for a bridge fetch. With a pin, `-k` stays on purpose: the
 * bridge cert is self-signed and curl still chain-verifies without `-k`,
 * even when the pin matches — while `--pinnedpubkey` is enforced with or
 * without `-k`. So the pin, not the chain, is the real check. Without one
 * (plain HTTP, nothing to pin) the flags are unchanged.
 */
function curlFlags(spkiPin: string | undefined): string {
  return spkiPin ? `-fsSk --pinnedpubkey "sha256//${sh(spkiPin)}"` : "-fsSk";
}

// ── Generated commands ───────────────────────────────────────────────────────

/** The command a human (or the model over SSH) runs on the target host. */
export function installOneLiner(grant: NodeProvisionGrant): string {
  const url = `${grant.bridgeUrl}/node/install?provision=${grant.token}`;
  if (grant.goos !== "windows") {
    return `curl ${curlFlags(grant.spkiPin)} "${sh(url)}" | sh`;
  }
  if (grant.fingerprint) {
    // No `$` anywhere, so the line means the same pasted into cmd.exe or a
    // PowerShell prompt (whose double quotes would expand variables).
    return (
      `powershell -ExecutionPolicy Bypass -Command "` +
      `${psPinSetup(grant.fingerprint)}; ` +
      `iex ([TalonPin]::Get('${psq(url)}'))"`
    );
  }
  // Plain HTTP: nothing to pin, and the trust-all callback is inert. The
  // line is meant for cmd.exe, where $true survives the outer double quotes.
  return (
    `powershell -ExecutionPolicy Bypass -Command "` +
    `[Net.ServicePointManager]::ServerCertificateValidationCallback={$true}; ` +
    `iwr -UseBasicParsing '${psq(url)}' | Select-Object -ExpandProperty Content | iex"`
  );
}

/**
 * POSIX installer: fetch the binary over the same grant (pinned like the
 * script fetch), verify its digest, install it next to the node's config,
 * and register the boot service. The certificate fingerprint is pre-pinned
 * into the node's config for every connection after install.
 */
function shellInstaller(grant: NodeProvisionGrant): string {
  const nameFlag = grant.name ? ` --name "${sh(grant.name)}"` : "";
  const fpFlag = grant.fingerprint
    ? ` --fingerprint "${sh(grant.fingerprint)}"`
    : "";
  const target = `${grant.version} (${grant.goos}/${grant.goarch})`;
  return `#!/bin/sh
# talon-node installer — generated by Talon ${oneLine(`${grant.version} for ${grant.goos}/${grant.goarch}`)}
set -eu
BRIDGE="${sh(grant.bridgeUrl)}"
SHA="${sh(grant.sha256)}"
if [ "$(id -u)" = "0" ]; then DEST_DIR="\${TALON_NODE_DIR:-/usr/local/bin}"; else DEST_DIR="\${TALON_NODE_DIR:-$HOME/.talon-node/bin}"; fi
mkdir -p "$DEST_DIR"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
echo "Downloading talon-node ${sh(target)}..."
curl ${curlFlags(grant.spkiPin)} "$BRIDGE/node/binary?provision=${sh(grant.token)}" -o "$TMP"
if command -v sha256sum >/dev/null 2>&1; then GOT="$(sha256sum "$TMP" | cut -d' ' -f1)"; else GOT="$(shasum -a 256 "$TMP" | cut -d' ' -f1)"; fi
if [ "$GOT" != "$SHA" ]; then echo "talon-node download failed its checksum — refusing to install" >&2; exit 1; fi
BIN="$DEST_DIR/talon-node"
mv "$TMP" "$BIN"
chmod 0755 "$BIN"
trap - EXIT
echo "Installed $BIN"
"$BIN" install --bridge "$BRIDGE" --token "${sh(grant.bearerToken)}"${fpFlag}${nameFlag}
echo "Done — this host is now on the mesh. Check with: $BIN status"
`;
}

/** The PowerShell lines that download the binary to `$bin`. */
function psBinaryFetch(grant: NodeProvisionGrant): string {
  const url = `"$bridge/node/binary?provision=${ps(grant.token)}"`;
  return grant.fingerprint
    ? `${psPinSetup(grant.fingerprint)}\n[TalonPin]::Save(${url}, $bin)`
    : `[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }\n` +
        `Invoke-WebRequest -UseBasicParsing ${url} -OutFile $bin`;
}

/**
 * PowerShell installer (Windows PowerShell 5.1 and pwsh 7). The binary lands
 * in the installing user's %LOCALAPPDATA% and `talon-node install` registers
 * a boot task that runs as that same user (never SYSTEM — a SYSTEM task would
 * run a binary the user can rewrite). Registering a boot task needs an
 * elevated PowerShell.
 */
function powershellInstaller(grant: NodeProvisionGrant): string {
  const nameArg = grant.name ? `, "--name", "${ps(grant.name)}"` : "";
  const fpArg = grant.fingerprint
    ? `, "--fingerprint", "${ps(grant.fingerprint)}"`
    : "";
  const target = `${grant.version} (${grant.goos}/${grant.goarch})`;
  return `# talon-node installer — generated by Talon ${oneLine(`${grant.version} for ${grant.goos}/${grant.goarch}`)}
$ErrorActionPreference = "Stop"
$bridge = "${ps(grant.bridgeUrl)}"
$dest = Join-Path $env:LOCALAPPDATA "talon-node"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$bin = Join-Path $dest "talon-node.exe"
Write-Host "Downloading talon-node ${ps(target)}..."
${psBinaryFetch(grant)}
$got = (Get-FileHash $bin -Algorithm SHA256).Hash.ToLower()
if ($got -ne "${ps(grant.sha256)}") { Remove-Item $bin; throw "talon-node download failed its checksum - refusing to install" }
Write-Host "Installed $bin"
Write-Host "Registering the boot task to run as $env:USERDOMAIN\\$env:USERNAME (not SYSTEM)..."
& $bin install --bridge $bridge --token "${ps(grant.bearerToken)}"${fpArg}${nameArg}
Write-Host "Done - this host is now on the mesh. Check with: $bin status"
`;
}
