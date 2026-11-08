import { describe, it, expect } from "vitest";

import {
  chatScope,
  deriveNumericChatId,
  generateTerminalChatId,
  isTerminalChatId,
  numericChatIdFor,
} from "../core/frontend-runtime/chat-id.js";

describe("deriveNumericChatId", () => {
  it("returns a positive number", () => {
    const id = deriveNumericChatId("test-chat");
    expect(id).toBeGreaterThan(0);
    expect(Number.isInteger(id)).toBe(true);
  });

  it("returns the same value for the same input", () => {
    const a = deriveNumericChatId("stable-id");
    const b = deriveNumericChatId("stable-id");
    expect(a).toBe(b);
  });

  it("returns different values for different inputs", () => {
    const a = deriveNumericChatId("chat-alpha");
    const b = deriveNumericChatId("chat-beta");
    expect(a).not.toBe(b);
  });

  it("handles terminal-style IDs", () => {
    const id = deriveNumericChatId("t_1711360000000");
    expect(id).toBeGreaterThan(0);
  });

  it("handles empty string", () => {
    const id = deriveNumericChatId("");
    expect(id).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(id)).toBe(true);
  });
});

describe("generateTerminalChatId", () => {
  it("returns a string starting with t_", () => {
    const id = generateTerminalChatId();
    expect(id).toMatch(/^t_\d+$/);
  });

  it("returns a string with numeric timestamp portion", () => {
    const id = generateTerminalChatId();
    const ts = Number(id.slice(2));
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThan(0);
  });

  it("uses a recent timestamp", () => {
    const before = Date.now();
    const id = generateTerminalChatId();
    const after = Date.now();
    const ts = Number(id.slice(2));
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("isTerminalChatId", () => {
  it('returns true for "1" (legacy ID)', () => {
    expect(isTerminalChatId("1")).toBe(true);
  });

  it("returns true for t_ prefixed IDs", () => {
    expect(isTerminalChatId("t_1711360000000")).toBe(true);
    expect(isTerminalChatId("t_0")).toBe(true);
    expect(isTerminalChatId("t_abc")).toBe(true);
  });

  it("returns false for Telegram numeric IDs", () => {
    expect(isTerminalChatId("123456789")).toBe(false);
    expect(isTerminalChatId("-100123456")).toBe(false);
  });

  it("returns false for Teams IDs", () => {
    expect(isTerminalChatId("teams_chat_abc123")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isTerminalChatId("")).toBe(false);
  });

  it('returns false for "10" and other strings starting with 1', () => {
    expect(isTerminalChatId("10")).toBe(false);
    expect(isTerminalChatId("100")).toBe(false);
  });
});

describe("numericChatIdFor", () => {
  it("passes Telegram ids through as numbers, negative supergroups included", () => {
    expect(numericChatIdFor("424242420")).toBe(424242420);
    expect(numericChatIdFor("-1009876543210")).toBe(-1009876543210);
  });

  it("derives every other frontend's id the way that frontend does", () => {
    for (const id of [
      "d_1789500775292_df4e0n",
      "wa_dm_447700900103",
      "discord_1",
      "teams_chat_19:abc",
      "t_1",
    ]) {
      expect(numericChatIdFor(id)).toBe(deriveNumericChatId(id));
    }
  });
});

describe("chatScope", () => {
  it("reads group and DM straight off the explicit prefixes", () => {
    expect(chatScope("discord_guild_123_456")).toBe("group");
    expect(chatScope("discord_dm_123")).toBe("dm");
    expect(chatScope("wa_group_120363000@g.us")).toBe("group");
    expect(chatScope("wa_dm_447700900103")).toBe("dm");
  });

  it("reads a Telegram id by sign — negative is a group/supergroup/channel", () => {
    expect(chatScope("-1009876543210")).toBe("group");
    expect(chatScope("-123456789")).toBe("group");
    expect(chatScope("424242420")).toBe("dm");
  });

  it("treats the local single-operator surfaces as DMs", () => {
    expect(chatScope("t_1711360000000")).toBe("dm");
    expect(chatScope("1")).toBe("dm");
    expect(chatScope("d_1789500775292_df4e0n")).toBe("dm");
  });

  it("says unknown when the grammar cannot tell", () => {
    // A Teams chat id covers 1:1 and group chats alike.
    expect(chatScope("teams_chat_19:abc@thread.v2")).toBe("unknown");
    expect(chatScope("some_future_frontend_42")).toBe("unknown");
  });
});
