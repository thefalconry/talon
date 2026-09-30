/**
 * The Windows installer's certificate pin, run for real: the generated
 * one-liner's PowerShell (Add-Type'd TalonPin) against an HTTPS server
 * holding a bridge identity. Runs under every shell present — Windows
 * PowerShell 5.1 (`powershell`, .NET Framework) on Windows runners, pwsh 7
 * (.NET) on Windows and Linux runners — and skips where neither exists.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:https";
import { mkdtemp, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateSelfSignedCertificate,
  certificateFingerprint,
} from "../frontend/native/bridge/tls.js";
import {
  installOneLiner,
  type NodeProvisionGrant,
} from "../core/mesh/links/node-provision.js";

const SHELLS = ["powershell", "pwsh"].filter(
  (shell) =>
    typeof process.versions.bun !== "string" &&
    spawnSync(shell, ["-NoProfile", "-Command", "exit 0"]).status === 0,
);

const SCRIPT = "Write-Output 'talon-pin-ok'";
const BINARY = "talon-node-binary-bytes";

/** The PowerShell inside the one-liner's `-Command "…"`. */
function commandOf(line: string): string {
  const match = /-Command "(.*)"$/.exec(line);
  if (!match) throw new Error(`not a one-liner: ${line}`);
  return match[1]!;
}

function runShell(
  shell: string,
  command: string,
): Promise<{ ok: boolean; out: string }> {
  // Loopback must not detour through a CI or developer proxy.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(https?|all|no)_proxy$/i.test(key)) delete env[key];
  }
  return new Promise((resolvePromise) => {
    execFile(
      shell,
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { env, timeout: 90_000 },
      (err, stdout, stderr) =>
        resolvePromise({ ok: !err, out: `${stdout}${stderr}` }),
    );
  });
}

describe.skipIf(SHELLS.length === 0)("PowerShell installer pinning", () => {
  const { keyPem, certPem } = generateSelfSignedCertificate();
  let server: Server;
  let base = "";

  beforeAll(async () => {
    server = createServer({ key: keyPem, cert: certPem }, (req, res) => {
      res.end(req.url?.startsWith("/node/binary") ? BINARY : SCRIPT);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  function grant(fingerprint: string): NodeProvisionGrant {
    return {
      token: "tok",
      goos: "windows",
      goarch: "amd64",
      binaryPath: "unused",
      sha256: "00",
      size: 0,
      version: "0.0.0",
      bridgeUrl: base,
      bearerToken: "bearer",
      fingerprint,
      createdAt: 0,
      scriptUsed: false,
      binaryUsed: false,
    };
  }

  it.each(SHELLS)(
    "%s fetches and runs the script when the certificate matches",
    async (shell) => {
      const line = installOneLiner(grant(certificateFingerprint(certPem)));
      const result = await runShell(shell, commandOf(line));
      expect(result.out).toContain("talon-pin-ok");
      expect(result.ok).toBe(true);
    },
    120_000,
  );

  it.each(SHELLS)(
    "%s saves the binary through the same pin",
    async (shell) => {
      const dir = await mkdtemp(join(tmpdir(), "talon-pin-"));
      const out = join(dir, "talon-node.exe");
      const command = commandOf(
        installOneLiner(grant(certificateFingerprint(certPem))),
      ).replace(
        /iex \(\[TalonPin\]::Get\('[^']*'\)\)$/,
        `[TalonPin]::Save('${base}/node/binary?provision=tok', '${out}')`,
      );
      const result = await runShell(shell, command);
      expect(result.ok, result.out).toBe(true);
      expect(await readFile(out, "utf-8")).toBe(BINARY);
    },
    120_000,
  );

  it.each(SHELLS)(
    "%s refuses a certificate that doesn't match the pin",
    async (shell) => {
      const line = installOneLiner(grant("00".repeat(32)));
      const result = await runShell(shell, commandOf(line));
      expect(result.out).not.toContain("talon-pin-ok");
      expect(result.ok).toBe(false);
    },
    120_000,
  );
});
