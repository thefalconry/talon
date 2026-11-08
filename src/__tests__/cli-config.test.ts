/**
 * CLI config helpers — isConfigured is the gate between the main menu
 * and the setup wizard, so a wrong answer here traps a working install
 * in first-run setup forever. The credential rule must match doctor's:
 * telegram/teams/discord need their tokens, terminal and native need
 * nothing, anything unrecognized fails closed.
 */

import { describe, expect, it } from "vitest";
import { DEFAULTS, isConfigured, type Config } from "../cli/config.js";

function cfg(overrides: Partial<Config>): Config {
  return { ...DEFAULTS, ...overrides };
}

describe("isConfigured", () => {
  it("telegram needs a bot token and an admin", () => {
    expect(isConfigured(cfg({ frontend: "telegram" }))).toBe(false);
    // A token alone is not enough: without an admin the daemon refuses to
    // start, so a plain `talon` must route to setup instead.
    expect(isConfigured(cfg({ frontend: "telegram", botToken: "t" }))).toBe(
      false,
    );
    expect(
      isConfigured(
        cfg({ frontend: "telegram", botToken: "t", adminUserId: 42 }),
      ),
    ).toBe(true);
  });

  it("terminal and native need no credentials", () => {
    expect(isConfigured(cfg({ frontend: "terminal" }))).toBe(true);
    expect(isConfigured(cfg({ frontend: "native" }))).toBe(true);
    expect(isConfigured(cfg({ frontend: ["terminal", "native"] }))).toBe(true);
  });

  it("a mixed list is judged per-frontend", () => {
    expect(
      isConfigured(
        cfg({
          frontend: ["telegram", "native"],
          botToken: "t",
          adminUserId: 42,
        }),
      ),
    ).toBe(true);
    expect(isConfigured(cfg({ frontend: ["telegram", "native"] }))).toBe(false);
  });

  it("teams and discord need their credentials", () => {
    expect(isConfigured(cfg({ frontend: "teams" }))).toBe(false);
    expect(
      isConfigured(cfg({ frontend: "teams", teamsWebhookUrl: "https://x" })),
    ).toBe(true);
    expect(isConfigured(cfg({ frontend: "discord" }))).toBe(false);
    expect(
      isConfigured(
        cfg({
          frontend: "discord",
          discord: { botToken: "t", applicationId: "a" },
        }),
      ),
    ).toBe(true);
  });

  it("fails closed on an unknown frontend name", () => {
    expect(isConfigured(cfg({ frontend: "carrier-pigeon" }))).toBe(false);
  });
});
