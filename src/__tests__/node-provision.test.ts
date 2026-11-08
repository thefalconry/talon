/**
 * Node provisioning grants — single-use legs, expiry, and the generated
 * installer scripts (POSIX sh for linux/darwin, PowerShell for windows).
 */

import { describe, it, expect } from "vitest";
import {
  autoInstallOneLiners,
  checkBridgeUrl,
  installOneLiner,
  installRefusalScript,
  NodeProvisionStore,
} from "../core/mesh/links/node-provision.js";

const BASE = {
  goos: "linux" as const,
  goarch: "arm64",
  binaryPath: "/tmp/talon-node-linux-arm64",
  sha256: "ab".repeat(32),
  size: 6_000_000,
  version: "3.4.0",
  bridgeUrl: "https://100.64.0.7:19880",
  bearerToken: "bearer-secret",
  fingerprint: "cd".repeat(32),
};

const PIN = "pL1+qb9HTMRZJmuC/bB/ZI9d302BYrrqiVuRyW+DGrU=";
const DASHED = Array.from({ length: 32 }, () => "CD").join("-");

describe("NodeProvisionStore", () => {
  it("serves each leg exactly once", () => {
    const store = new NodeProvisionStore();
    const grant = store.create(BASE);
    expect(store.openScript(grant.token)?.filename).toBe(
      "install-talon-node.sh",
    );
    expect(store.openScript(grant.token)).toBeNull();
    expect(store.openBinary(grant.token)).toEqual({
      path: BASE.binaryPath,
      size: BASE.size,
    });
    expect(store.openBinary(grant.token)).toBeNull();
  });

  it("rejects unknown tokens and expires unclaimed grants", () => {
    const store = new NodeProvisionStore(-1); // everything already expired
    const grant = store.create(BASE);
    expect(store.openScript("nope")).toBeNull();
    expect(store.openScript(grant.token)).toBeNull();
  });

  it("sanitizes device names against quote breakouts", () => {
    const store = new NodeProvisionStore();
    const grant = store.create({ ...BASE, name: 'evil"; rm -rf / #box 1' });
    expect(grant.name).toBe("evil rm -rf  box 1");
  });
});

describe("installer scripts", () => {
  it("sh installer wires bridge, digest, token, and fingerprint through", () => {
    const store = new NodeProvisionStore();
    const grant = store.create({ ...BASE, name: "build-box" });
    const { script, filename } = store.openScript(grant.token)!;
    expect(filename).toBe("install-talon-node.sh");
    expect(script).toContain(`BRIDGE="${BASE.bridgeUrl}"`);
    expect(script).toContain(`SHA="${BASE.sha256}"`);
    expect(script).toContain(`/node/binary?provision=${grant.token}`);
    expect(script).toContain(`--token "${BASE.bearerToken}"`);
    expect(script).toContain(`--fingerprint "${BASE.fingerprint}"`);
    expect(script).toContain(`--name "build-box"`);
    // The digest check must gate the install, not decorate it.
    expect(script).toContain("refusing to install");
  });

  it("windows grants produce a PowerShell installer and one-liner", () => {
    const store = new NodeProvisionStore();
    const grant = store.create({ ...BASE, goos: "windows", goarch: "amd64" });
    const { script, filename } = store.openScript(grant.token)!;
    expect(filename).toBe("install-talon-node.ps1");
    expect(script).toContain("Get-FileHash");
    expect(script).toContain(BASE.sha256);
    expect(installOneLiner(grant)).toContain("powershell");
  });

  it("unix one-liner pipes the install route into sh", () => {
    const store = new NodeProvisionStore();
    const grant = store.create(BASE);
    expect(installOneLiner(grant)).toBe(
      `curl -fsSk "${BASE.bridgeUrl}/node/install?provision=${grant.token}" | sh`,
    );
  });

  it("omits fingerprint and name flags when absent", () => {
    const store = new NodeProvisionStore();
    const { fingerprint: _drop, ...rest } = BASE;
    const grant = store.create(rest);
    const { script } = store.openScript(grant.token)!;
    expect(script).not.toContain("--fingerprint");
    expect(script).not.toContain("--name");
  });
});

describe("TLS pinning", () => {
  it("unix one-liner and installer pin the bridge key, keeping -k", () => {
    const store = new NodeProvisionStore();
    const grant = store.create({ ...BASE, spkiPin: PIN });
    expect(installOneLiner(grant)).toBe(
      `curl -fsSk --pinnedpubkey "sha256//${PIN}" "${BASE.bridgeUrl}/node/install?provision=${grant.token}" | sh`,
    );
    const { script } = store.openScript(grant.token)!;
    expect(script).toContain(
      `curl -fsSk --pinnedpubkey "sha256//${PIN}" "$BRIDGE/node/binary?provision=${grant.token}"`,
    );
  });

  it("windows one-liner and installer check the certificate hash, not trust-all", () => {
    const store = new NodeProvisionStore();
    const grant = store.create({ ...BASE, goos: "windows", goarch: "amd64" });
    const line = installOneLiner(grant);
    expect(line).toContain("Add-Type -IgnoreWarnings");
    expect(line).toContain(`[TalonPin]::Pin = '${DASHED}'`);
    expect(line).toContain(
      `iex ([TalonPin]::Get('${BASE.bridgeUrl}/node/install?provision=${grant.token}'))`,
    );
    expect(line).not.toContain("{$true}");
    // Same meaning in cmd.exe and a PowerShell prompt: nothing to expand,
    // and the only double quotes are the -Command argument's own.
    expect(line).not.toMatch(/[$%]/);
    expect(line.match(/"/g)).toHaveLength(2);

    const { script } = store.openScript(grant.token)!;
    expect(script).toContain(`[TalonPin]::Pin = '${DASHED}'`);
    expect(script).toContain(
      `[TalonPin]::Save("$bridge/node/binary?provision=${grant.token}", $bin)`,
    );
    expect(script).not.toContain("{ $true }");
    // The callback compares SHA-256 of the presented cert and fails closed.
    expect(script).toContain("SHA256.Create().ComputeHash(c.GetRawCertData())");
    expect(script).toContain("c!=null&&string.Equals(");
  });

  it("leaves plain-HTTP grants unpinned (nothing to pin)", () => {
    const store = new NodeProvisionStore();
    const { fingerprint: _drop, ...rest } = BASE;
    const unix = store.create({ ...rest, bridgeUrl: "http://10.0.0.2:19880" });
    expect(installOneLiner(unix)).toBe(
      `curl -fsSk "http://10.0.0.2:19880/node/install?provision=${unix.token}" | sh`,
    );
    const win = store.create({
      ...rest,
      goos: "windows",
      goarch: "amd64",
      bridgeUrl: "http://10.0.0.2:19880",
    });
    expect(installOneLiner(win)).toContain(
      "ServerCertificateValidationCallback={$true}",
    );
    expect(store.openScript(win.token)!.script).toContain(
      "Invoke-WebRequest -UseBasicParsing",
    );
  });
});

describe("bridge URL validation", () => {
  it("accepts ordinary http(s) URLs and trims trailing slashes", () => {
    expect(checkBridgeUrl(" https://100.64.0.7:19880/ ")).toBe(
      "https://100.64.0.7:19880",
    );
    expect(checkBridgeUrl("http://talon.lan:8080/bridge")).toBe(
      "http://talon.lan:8080/bridge",
    );
    expect(checkBridgeUrl("https://[fd00::7]:19880")).toBe(
      "https://[fd00::7]:19880",
    );
  });

  it.each([
    'https://evil.example/"; curl x | sh; echo "',
    "https://evil.example/$(id)",
    "https://evil.example/`id`",
    "https://evil.example/${HOME}",
    "https://evil.example/\\x",
    "https://evil.example/'; iex x; '",
    "https://evil.example/%PATH%",
    "https://evil.example/a b",
    "https://evil.example/\nrm",
    "https://evil.example/\u201c",
    "ftp://evil.example",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
  ])("refuses %j", (url) => {
    const result = checkBridgeUrl(url);
    expect(typeof result).toBe("object");
    expect((result as { error: string }).error).toContain("bridge_url");
  });

  it("names the setting it is checking", () => {
    expect(checkBridgeUrl("https://x/$y", "native.publicUrl")).toEqual({
      error: expect.stringContaining("native.publicUrl"),
    });
  });
});

describe("installer escaping (defence in depth)", () => {
  const HOSTILE = {
    bridgeUrl: 'https://h/"$(id)`id`\\',
    bearerToken: 'tok"$x`y',
  };

  it("sh installer escapes every interpolated value", () => {
    const store = new NodeProvisionStore();
    const grant = store.create({ ...BASE, ...HOSTILE });
    const { script } = store.openScript(grant.token)!;
    expect(script).toContain('BRIDGE="https://h/\\"\\$(id)\\`id\\`\\\\"');
    expect(script).toContain('--token "tok\\"\\$x\\`y"');
    expect(installOneLiner(grant)).toContain('"https://h/\\"\\$(id)');
  });

  it("PowerShell installer escapes every interpolated value", () => {
    const store = new NodeProvisionStore();
    const grant = store.create({
      ...BASE,
      ...HOSTILE,
      goos: "windows",
      goarch: "amd64",
    });
    const { script } = store.openScript(grant.token)!;
    expect(script).toContain('$bridge = "https://h/`"`$(id)``id``\\"');
    expect(script).toContain('--token "tok`"`$x``y"');
  });

  it("single-quoted PowerShell URLs double their quotes", () => {
    const store = new NodeProvisionStore();
    const grant = store.create({
      ...BASE,
      goos: "windows",
      goarch: "amd64",
      bridgeUrl: "https://h/'x",
    });
    expect(installOneLiner(grant)).toContain("Get('https://h/''x/node/install");
  });

  it("still sanitises device names", () => {
    const store = new NodeProvisionStore();
    const grant = store.create({ ...BASE, name: 'a"$(b)`c`' });
    expect(grant.name).toBe("abc");
    expect(store.openScript(grant.token)!.script).toContain('--name "abc"');
  });
});

describe("auto grants", () => {
  const { goos, goarch, binaryPath, sha256, size, version, ...common } = BASE;
  const target = { goos, goarch, binaryPath, sha256, size, version };

  it("serve nothing until pinned, then behave like an ordinary grant", () => {
    const store = new NodeProvisionStore();
    const pending = store.createAuto(common);
    expect(store.isPending(pending.token)).toBe(true);
    expect(store.openScript(pending.token)).toBeNull();
    expect(store.openBinary(pending.token)).toBeNull();

    expect(store.pin(pending.token, target)).toBe(true);
    expect(store.isPending(pending.token)).toBe(false);
    expect(store.pin(pending.token, target)).toBe(false);
    expect(store.openScript(pending.token)?.script).toContain(sha256);
    expect(store.openBinary(pending.token)).toEqual({ path: binaryPath, size });
  });

  it("expire unclaimed like any other grant", () => {
    const store = new NodeProvisionStore(-1);
    const pending = store.createAuto(common);
    expect(store.isPending(pending.token)).toBe(false);
    expect(store.pin(pending.token, target)).toBe(false);
  });

  it("sanitize the device name", () => {
    const store = new NodeProvisionStore();
    const pending = store.createAuto({ ...common, name: 'x"; reboot #' });
    expect(pending.name).toBe("x reboot ");
  });

  it("report the platform through pinned fetches", () => {
    const cmd = autoInstallOneLiners({
      bridgeUrl: BASE.bridgeUrl,
      token: "T",
      fingerprint: BASE.fingerprint,
      spkiPin: PIN,
    });
    expect(cmd.posix).toBe(
      `curl -fsSk --pinnedpubkey "sha256//${PIN}" "${BASE.bridgeUrl}/node/install?provision=T&os=$(uname -s)&arch=$(uname -m)" | sh`,
    );
    expect(cmd.windows).toContain(`[TalonPin]::Pin = '${DASHED}'`);
    expect(cmd.windows).toContain(
      `iex ([TalonPin]::Get('${BASE.bridgeUrl}/node/install?provision=T&os=windows&arch=' + $env:PROCESSOR_ARCHITECTURE))`,
    );
    expect(cmd.windows).not.toContain("{$true}");
  });

  it("fall back to unpinned fetches over plain HTTP", () => {
    const cmd = autoInstallOneLiners({
      bridgeUrl: "http://100.64.0.7:19880",
      token: "T",
    });
    expect(cmd.posix).toBe(
      `curl -fsSk "http://100.64.0.7:19880/node/install?provision=T&os=$(uname -s)&arch=$(uname -m)" | sh`,
    );
    expect(cmd.windows).toContain(
      "&os=windows&arch=' + $env:PROCESSOR_ARCHITECTURE",
    );
  });

  it("refusal scripts can't be broken out of", () => {
    const script = installRefusalScript('bad "os" $(rm -rf /) `x` \\ 50% end');
    const [line, rest] = script.split("\n", 2) as [string, string];
    expect(line.startsWith('echo "talon-node install refused: bad')).toBe(true);
    expect(line.slice('echo "'.length, -1)).not.toMatch(/["'`$\\%]/);
    expect(rest).toBe("exit 1");
  });
});
