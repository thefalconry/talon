/**
 * Frontend tool-server scoping — a chat gets its OWNING frontend's
 * tool server, not one per configured frontend.
 *
 * The bug this pins down: with `frontend: ["telegram", "native"]`, a
 * native-app conversation used to register BOTH `native-tools` and
 * `telegram-tools`, so the model saw `mcp__telegram-tools__*` names in
 * the native client — confusing UI, and an invitation to deliver a
 * reply to the wrong surface.
 */

import { describe, it, expect } from "vitest";
import {
  frontendForChatId,
  frontendsForChat,
  nonTerminalFrontends,
} from "../backend/runtime/frontends.js";

const ALL = ["telegram", "discord", "teams", "native", "whatsapp"] as const;

describe("frontendForChatId", () => {
  it("classifies each frontend's chat-id shape", () => {
    expect(frontendForChatId("d_1751640000000_ab12cd")).toBe("native");
    expect(frontendForChatId("teams_chat_19:abc@thread.v2")).toBe("teams");
    expect(frontendForChatId("discord_guild_123_456")).toBe("discord");
    expect(frontendForChatId("discord_dm_789")).toBe("discord");
    expect(frontendForChatId("-1009876543210")).toBe("telegram");
    expect(frontendForChatId("123456789")).toBe("telegram");
  });

  it("returns null for cross-surface contexts", () => {
    expect(frontendForChatId("heartbeat")).toBeNull();
    expect(frontendForChatId("t_1751640000000")).toBeNull();
  });
});

describe("frontendsForChat", () => {
  it("scopes an owned chat to exactly its frontend", () => {
    expect(frontendsForChat("d_1751640000000_ab12cd", [...ALL])).toEqual([
      "native",
    ]);
    expect(frontendsForChat("-100123", [...ALL])).toEqual(["telegram"]);
    expect(frontendsForChat("discord_dm_789", [...ALL])).toEqual(["discord"]);
  });

  it("keeps the full set for heartbeat / terminal / unknown chats", () => {
    expect(frontendsForChat("heartbeat", [...ALL])).toEqual([...ALL]);
    expect(frontendsForChat("t_1751640000000", [...ALL])).toEqual([...ALL]);
  });

  it("falls back to the full set when the owner is not configured", () => {
    // A native chat id while only telegram is configured — mis-config
    // or migration; better every tool than none.
    expect(frontendsForChat("d_1751640000000_ab12cd", ["telegram"])).toEqual([
      "telegram",
    ]);
  });
});

describe("nonTerminalFrontends", () => {
  it("normalises string/array and drops terminal", () => {
    expect(nonTerminalFrontends("telegram")).toEqual(["telegram"]);
    expect(nonTerminalFrontends(["telegram", "terminal", "native"])).toEqual([
      "telegram",
      "native",
    ]);
    expect(nonTerminalFrontends(undefined)).toEqual([]);
  });
});
