/**
 * Frontend registry — identity, chat-id routing, and the create seam.
 *
 * The registry replaces four hand-maintained copies of the frontend
 * if/else chain (bootstrap resolution, gateway action routing, backend
 * MCP scoping, app.ts creation switch); these tests pin the semantics
 * those call sites relied on, including the two historical tie-breaks:
 * telegram's numeric matcher runs last, and the terminal claims the
 * legacy chat id "1".
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  attachFrontendCreate,
  createFrontendById,
  getFrontendDescriptor,
  hasFrontend,
  listFrontends,
  registerFrontend,
  resetFrontendRegistry,
  resolveFrontendIdAmong,
  resolveOwnerFrontendId,
  type Frontend,
} from "../core/frontend-runtime/index.js";
import {
  frontendForChatId,
  frontendsForChat,
  nonTerminalFrontends,
} from "../backend/runtime/frontends.js";
import type { TalonConfig } from "../core/config/index.js";
import type { Gateway } from "../core/engine/gateway.js";

afterEach(() => resetFrontendRegistry());

describe("built-in descriptors", () => {
  it("registers all six built-ins on import", () => {
    expect(listFrontends().map((f) => f.id)).toEqual([
      "discord",
      "native",
      "teams",
      "telegram",
      "terminal",
      "whatsapp",
    ]);
  });

  it("only the terminal is non-messaging and stdin-sharing", () => {
    for (const f of listFrontends()) {
      expect(f.messaging).toBe(f.id !== "terminal");
      expect(f.sharesStdin === true).toBe(f.id === "terminal");
    }
  });

  it("rejects duplicate registration", () => {
    expect(() =>
      registerFrontend({
        id: "telegram",
        label: "Imposter",
        ownsChatId: () => true,
        routePriority: 1,
        messaging: true,
        create: () => ({}) as Frontend,
      }),
    ).toThrow(/already registered/);
  });
});

describe("chat-id ownership (resolveOwnerFrontendId)", () => {
  it("classifies each built-in id shape", () => {
    expect(resolveOwnerFrontendId("d_1751640000000_ab12cd")).toBe("native");
    expect(resolveOwnerFrontendId("teams_chat_19:abc@thread.v2")).toBe("teams");
    expect(resolveOwnerFrontendId("discord_guild_123_456")).toBe("discord");
    expect(resolveOwnerFrontendId("-1009876543210")).toBe("telegram");
    expect(resolveOwnerFrontendId("123456789")).toBe("telegram");
  });

  it("resolves terminal ids to null unless non-messaging is included", () => {
    expect(resolveOwnerFrontendId("t_1751640000000")).toBeNull();
    expect(
      resolveOwnerFrontendId("t_1751640000000", { includeNonMessaging: true }),
    ).toBe("terminal");
  });

  it('terminal beats telegram for the legacy chat id "1"', () => {
    // "1" matches both the terminal's legacy id and telegram's numeric
    // matcher — routePriority must keep the historical terminal-first
    // order.
    expect(resolveOwnerFrontendId("1", { includeNonMessaging: true })).toBe(
      "terminal",
    );
    expect(resolveOwnerFrontendId("1")).toBe("telegram");
  });

  it("returns null for cross-surface contexts", () => {
    expect(resolveOwnerFrontendId("heartbeat")).toBeNull();
    expect(
      resolveOwnerFrontendId("heartbeat", { includeNonMessaging: true }),
    ).toBeNull();
  });
});

describe("candidate resolution (resolveFrontendIdAmong)", () => {
  it("a single candidate always wins", () => {
    expect(resolveFrontendIdAmong("d_123", ["telegram"])).toBe("telegram");
  });

  it("the owning candidate wins", () => {
    expect(resolveFrontendIdAmong("d_123", ["telegram", "native"])).toBe(
      "native",
    );
    expect(resolveFrontendIdAmong("-100", ["telegram", "native"])).toBe(
      "telegram",
    );
    expect(resolveFrontendIdAmong("1", ["telegram", "terminal"])).toBe(
      "terminal",
    );
  });

  it("falls back to the first messaging candidate", () => {
    expect(
      resolveFrontendIdAmong(undefined, ["terminal", "telegram", "native"]),
    ).toBe("telegram");
    expect(resolveFrontendIdAmong("heartbeat", ["terminal", "native"])).toBe(
      "native",
    );
  });

  it("falls back to the first candidate when none are messaging", () => {
    expect(resolveFrontendIdAmong(undefined, ["terminal", "terminal"])).toBe(
      "terminal",
    );
  });
});

describe("create seam", () => {
  const config = {} as TalonConfig;
  const gateway = {} as Gateway;

  it("creates through an attached factory", async () => {
    const instance = { name: "terminal" } as Frontend;
    attachFrontendCreate("terminal", () => instance);
    await expect(createFrontendById("terminal", config, gateway)).resolves.toBe(
      instance,
    );
  });

  it("rejects unknown ids with the known list", async () => {
    await expect(createFrontendById("slack", config, gateway)).rejects.toThrow(
      /Unknown frontend "slack".*discord, native, teams, telegram, terminal, whatsapp/,
    );
  });

  it("rejects a descriptor with no factory attached", async () => {
    await expect(
      createFrontendById("telegram", config, gateway),
    ).rejects.toThrow(/no factory attached/);
  });

  it("rejects attaching to an unknown id or twice", () => {
    expect(() => attachFrontendCreate("slack", () => ({}) as Frontend)).toThrow(
      /not registered/,
    );
    attachFrontendCreate("native", () => ({}) as Frontend);
    expect(() =>
      attachFrontendCreate("native", () => ({}) as Frontend),
    ).toThrow(/already has a factory/);
  });

  it("registers a plugin frontend (descriptor + create in one call)", async () => {
    const instance = { name: "slack" } as Frontend;
    registerFrontend({
      id: "slack",
      label: "Slack",
      ownsChatId: (id) => id.startsWith("slack_"),
      routePriority: 50,
      messaging: true,
      create: () => instance,
    });
    expect(hasFrontend("slack")).toBe(true);
    expect(resolveOwnerFrontendId("slack_C042")).toBe("slack");
    expect(getFrontendDescriptor("slack")?.label).toBe("Slack");
    await expect(createFrontendById("slack", config, gateway)).resolves.toBe(
      instance,
    );
    // Built-in matchers still win by shape, unaffected by the addition.
    expect(resolveOwnerFrontendId("d_123")).toBe("native");
  });
});

describe("backend/runtime/frontends.ts stays a thin view of the registry", () => {
  it("nonTerminalFrontends filters by the messaging trait, keeps unknowns", () => {
    expect(
      nonTerminalFrontends(["telegram", "terminal", "native", "mystery"]),
    ).toEqual(["telegram", "native", "mystery"]);
    expect(nonTerminalFrontends("terminal")).toEqual([]);
    expect(nonTerminalFrontends(undefined)).toEqual([]);
  });

  it("frontendForChatId matches registry ownership", () => {
    expect(frontendForChatId("d_1")).toBe("native");
    expect(frontendForChatId("t_1")).toBeNull();
    expect(frontendForChatId("heartbeat")).toBeNull();
  });

  it("frontendsForChat scopes to a registered plugin frontend too", () => {
    registerFrontend({
      id: "slack",
      label: "Slack",
      ownsChatId: (id) => id.startsWith("slack_"),
      routePriority: 50,
      messaging: true,
      create: () => ({}) as Frontend,
    });
    expect(frontendsForChat("slack_C042", ["telegram", "slack"])).toEqual([
      "slack",
    ]);
  });
});
