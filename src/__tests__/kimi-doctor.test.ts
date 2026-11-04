/**
 * Kimi doctor + auth-detection tests.
 *
 * Checks binary resolution, version floor, config parsing,
 * and dynamic model catalog probing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileSyncMock = vi.hoisted(() => vi.fn());
const binaryOnPathMock = vi.hoisted(() => vi.fn(() => true));
vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});
vi.mock("../util/binary-on-path.js", () => ({
  binaryOnPath: binaryOnPathMock,
}));

const { kimiDoctorChecks } = await import("../backend/kimi/doctor.js");
const { detectKimiAuth, isKimiAuthFailure, kimiAuthError } =
  await import("../backend/kimi/auth.js");

let dir: string;
let configPath: string;

const SAMPLE_MODELS_JSON = JSON.stringify({
  models: {
    "openrouter/liquid/lfm-2.5-2.6b:free": {
      name: "Liquid LFM 2.5",
      max_context_tokens: 32768,
    },
  },
});

const byLabel = (checks: Awaited<ReturnType<typeof kimiDoctorChecks>>) =>
  Object.fromEntries(checks.map((c) => [c.label, c]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kimi-doctor-"));
  configPath = join(dir, "config.toml");
  process.env.TALON_KIMI_CONFIG_FILE = join(dir, "absent.toml");
  binaryOnPathMock.mockReturnValue(true);
  execFileSyncMock.mockImplementation((_bin: string, args: string[]) =>
    args[0] === "--version" ? "2.0.2\n" : SAMPLE_MODELS_JSON,
  );
});

afterEach(() => {
  delete process.env.TALON_KIMI_CONFIG_FILE;
  delete process.env.KIMI_BINARY;
  rmSync(dir, { recursive: true, force: true });
});

describe("kimi auth detection", () => {
  it("reads configured providers from config.toml", () => {
    writeFileSync(
      configPath,
      `
[providers.openrouter]
api_key = "sk-or-v1-test"
model = "liquid/lfm-2.5-2.6b:free"
`,
    );
    process.env.TALON_KIMI_CONFIG_FILE = configPath;
    const auth = detectKimiAuth();
    expect(auth).toMatchObject({
      present: true,
      providers: ["openrouter"],
    });
  });

  it("reports missing config file safely", () => {
    process.env.TALON_KIMI_CONFIG_FILE = join(dir, "nope.toml");
    const auth = detectKimiAuth();
    expect(auth.present).toBe(false);
    expect(auth.problem).toMatch(/no config file found/);
  });

  it("handles unparseable or empty config files", () => {
    writeFileSync(configPath, "not valid toml :::");
    process.env.TALON_KIMI_CONFIG_FILE = configPath;
    const auth = detectKimiAuth();
    expect(auth.present).toBe(false);
    expect(auth.problem).toMatch(/no \[providers\] found/);
  });

  it("recognises Kimi auth error messages", () => {
    expect(isKimiAuthFailure("Unauthorized: Invalid API key")).toBe(true);
    expect(isKimiAuthFailure("authentication required for provider")).toBe(true);
    expect(isKimiAuthFailure("no api key found")).toBe(true);
    expect(isKimiAuthFailure("Network timeout after 30s")).toBe(false);
  });

  it("formats auth error with actionable remediation", () => {
    const err = kimiAuthError(new Error("provider 401"));
    expect(err.message).toMatch(/kimi provider add/);
    expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
  });
});

describe("kimi doctor", () => {
  it("fails fast when binary is missing from PATH", async () => {
    binaryOnPathMock.mockReturnValue(false);
    const checks = await kimiDoctorChecks(undefined);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: "fail" });
    expect(checks[0].detail).toMatch(/kimiBinary|KIMI_BINARY/);
  });

  it("reports binary, version, auth, and models when all is healthy", async () => {
    writeFileSync(
      configPath,
      `
[providers.openrouter]
api_key = "test"
`,
    );
    process.env.TALON_KIMI_CONFIG_FILE = configPath;
    const checks = byLabel(await kimiDoctorChecks(undefined));
    expect(checks["Kimi CLI installed"].status).toBe("ok");
    expect(checks["Kimi CLI version"]).toMatchObject({
      status: "ok",
      detail: "2.0.2",
    });
    expect(checks["Kimi auth"].status).toBe("ok");
    expect(checks["Kimi models"]).toMatchObject({ status: "ok" });
    expect(checks["Kimi models"].detail).toContain("1 available");
  });

  it("fails when version is below minimum floor (2.0.0)", async () => {
    execFileSyncMock.mockImplementation((_b: string, args: string[]) =>
      args[0] === "--version" ? "1.8.0\n" : SAMPLE_MODELS_JSON,
    );
    const checks = byLabel(await kimiDoctorChecks(undefined));
    expect(checks["Kimi CLI too old (1.8.0)"]).toMatchObject({
      status: "fail",
    });
  });

  it("accepts a newer version", async () => {
    execFileSyncMock.mockImplementation((_b: string, args: string[]) =>
      args[0] === "--version" ? "2.5.0\n" : SAMPLE_MODELS_JSON,
    );
    const checks = byLabel(await kimiDoctorChecks(undefined));
    expect(checks["Kimi CLI version"].status).toBe("ok");
  });

  it("warns when no providers are configured", async () => {
    const checks = byLabel(await kimiDoctorChecks(undefined));
    const auth = checks["Kimi auth missing"];
    expect(auth).toMatchObject({ status: "warn", issue: true });
    expect(auth.detail).toMatch(/kimi provider add/);
  });

  it("warns when model list returns empty", async () => {
    execFileSyncMock.mockImplementation((_b: string, args: string[]) =>
      args[0] === "--version" ? "2.0.2\n" : JSON.stringify({ models: {} }),
    );
    const checks = byLabel(await kimiDoctorChecks(undefined));
    expect(checks["Kimi models empty"]).toMatchObject({
      status: "warn",
      issue: true,
    });
  });

  it("skips model probe when backend is not active", async () => {
    await kimiDoctorChecks(undefined, false);
    const argsProbed = execFileSyncMock.mock.calls.map(
      (c) => (c[1] as string[])[0],
    );
    expect(argsProbed).not.toContain("provider");
  });

  it("honours configured binary and env override", async () => {
    await kimiDoctorChecks({ kimiBinary: "/opt/custom/kimi" } as never);
    expect(execFileSyncMock.mock.calls[0][0]).toBe("/opt/custom/kimi");

    execFileSyncMock.mockClear();
    process.env.KIMI_BINARY = "/env/kimi";
    await kimiDoctorChecks({ kimiBinary: "/opt/custom/kimi" } as never);
    expect(execFileSyncMock.mock.calls[0][0]).toBe("/env/kimi");
  });
});
