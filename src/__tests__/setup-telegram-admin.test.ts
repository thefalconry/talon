/**
 * A Telegram bot always has an owner. `talon setup` requires the admin's
 * Telegram id and, when no allowlist exists yet, makes that admin the only
 * allowed DM user. The Docker first-boot seed enforces the same rule.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildSetupConfig,
  validateTelegramAdminId,
  type SetupAnswers,
} from "../cli/setup.js";
import { DEFAULTS, type Config } from "../cli/config.js";

const answers = (over: Partial<SetupAnswers> = {}): SetupAnswers => ({
  selectedFrontends: ["telegram"],
  backend: "claude",
  botToken: "123:abc",
  model: "default",
  pulse: true,
  adminId: "4242",
  ...over,
});

describe("talon setup — Telegram admin", () => {
  it("requires a numeric admin id", () => {
    expect(validateTelegramAdminId("")).toMatch(/Required/);
    expect(validateTelegramAdminId("   ")).toMatch(/Required/);
    expect(validateTelegramAdminId(undefined)).toMatch(/Required/);
    expect(validateTelegramAdminId("@me")).toMatch(/numeric/);
    expect(validateTelegramAdminId("-5")).toMatch(/numeric/);
    expect(validateTelegramAdminId("0")).toMatch(/numeric/);
    expect(validateTelegramAdminId("424242420")).toBeUndefined();
  });

  it("defaults the DM allowlist to the admin on a fresh config", () => {
    const saved = buildSetupConfig({ ...DEFAULTS } as Config, answers());
    expect(saved.adminUserId).toBe(4242);
    expect(saved.allowedUsers).toEqual([4242]);
  });

  it("keeps an allowlist the operator already wrote", () => {
    const saved = buildSetupConfig(
      { ...DEFAULTS, allowedUsers: [1, 2] } as Config,
      answers(),
    );
    expect(saved.adminUserId).toBe(4242);
    expect(saved.allowedUsers).toEqual([1, 2]);
  });

  it("leaves admin and allowlist alone when Telegram is not selected", () => {
    const saved = buildSetupConfig(
      { ...DEFAULTS, adminUserId: 7, allowedUsers: [7] } as Config,
      answers({ selectedFrontends: ["native"], adminId: undefined }),
    );
    expect(saved.adminUserId).toBe(7);
    expect(saved.allowedUsers).toEqual([7]);
  });
});

describe("docker first-boot seed", () => {
  const SEED = resolve(import.meta.dirname, "../../docker/seed-config.mjs");
  let home: string | undefined;

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  function seed(env: Record<string, string>) {
    home = mkdtempSync(join(tmpdir(), "talon-seed-"));
    const result = spawnSync(process.execPath, [SEED], {
      env: { PATH: process.env.PATH ?? "", TALON_HOME: home, ...env },
      encoding: "utf-8",
    });
    const file = join(home, "config.json");
    return {
      status: result.status,
      stderr: result.stderr,
      config: existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>)
        : null,
    };
  }

  it("refuses a Telegram bot token without an admin id", () => {
    const out = seed({ TALON_BOT_TOKEN: "123:abc" });
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/TALON_ADMIN_USER_ID is required/);
    expect(out.config).toBeNull();
  });

  it("refuses an explicit telegram frontend without an admin id", () => {
    const out = seed({ TALON_FRONTEND: "telegram,native" });
    expect(out.status).toBe(1);
    expect(out.config).toBeNull();
  });

  it("seeds the admin as the only allowed user", () => {
    const out = seed({
      TALON_BOT_TOKEN: "123:abc",
      TALON_ADMIN_USER_ID: "4242",
    });
    expect(out.status).toBe(0);
    expect(out.config).toMatchObject({
      frontend: "telegram",
      adminUserId: 4242,
      allowedUsers: [4242],
    });
  });

  it("still seeds a native-only install with no admin", () => {
    const out = seed({});
    expect(out.status).toBe(0);
    expect(out.config).toMatchObject({ frontend: "native" });
  });
});
