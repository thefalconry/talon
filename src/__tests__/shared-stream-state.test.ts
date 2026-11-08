/**
 * Tests for the backend-agnostic stream state accumulator.
 */

import { describe, expect, it } from "vitest";
import {
  createStreamState,
  appendText,
  closeCurrentSegment,
  recordToolUse,
  recordTokens,
  finalizeResponseText,
} from "../backend/runtime/turn/stream-state.js";

describe("createStreamState", () => {
  it("returns a zeroed state object", () => {
    const s = createStreamState();
    expect(s.currentBlockText).toBe("");
    expect(s.allResponseText).toBe("");
    expect(s.lastTrailingText).toBe("");
    expect(s.toolCalls).toBe(0);
    expect(s.turnTerminated).toBe(false);
    expect(s.deliveredTextNorms).toEqual([]);
    expect(s.sdkInputTokens).toBe(0);
    expect(s.numApiCalls).toBe(0);
  });
});

describe("appendText", () => {
  it("appends to both currentBlockText and lastTrailingText", () => {
    const s = createStreamState();
    appendText(s, "Hello ");
    appendText(s, "world");
    expect(s.currentBlockText).toBe("Hello world");
    expect(s.lastTrailingText).toBe("Hello world");
  });

  it("ignores empty fragments", () => {
    const s = createStreamState();
    appendText(s, "");
    expect(s.currentBlockText).toBe("");
  });
});

describe("closeCurrentSegment", () => {
  it("returns trimmed text and moves it to allResponseText", () => {
    const s = createStreamState();
    appendText(s, "  Pre-tool prose  ");
    const segment = closeCurrentSegment(s);
    expect(segment).toBe("Pre-tool prose");
    expect(s.allResponseText).toBe("  Pre-tool prose  ");
    expect(s.currentBlockText).toBe("");
    expect(s.lastTrailingText).toBe("");
  });

  it("returns empty string when nothing to close", () => {
    const s = createStreamState();
    expect(closeCurrentSegment(s)).toBe("");
  });
});

describe("recordToolUse", () => {
  it("increments toolCalls", () => {
    const s = createStreamState();
    recordToolUse(s, "get_weather", { city: "London" });
    expect(s.toolCalls).toBe(1);
  });

  it("captures delivered text for end_turn", () => {
    const s = createStreamState();
    recordToolUse(s, "end_turn", { text: "This is the final reply" });
    expect(s.deliveredTextNorms).toHaveLength(1);
    expect(s.deliveredTextNorms[0]).toBe("this is the final reply");
  });

  it("flips turnTerminated for end_turn", () => {
    const s = createStreamState();
    recordToolUse(s, "end_turn", { text: "bye" });
    expect(s.turnTerminated).toBe(true);
  });

  it("does NOT flip turnTerminated for send (send is mid-turn delivery, not a terminator)", () => {
    const s = createStreamState();
    recordToolUse(s, "send", { type: "text", text: "hi" });
    // `send` does NOT have `endsTurn: true` in the registry — the model
    // can call send mid-turn (e.g. send a photo, then keep working) and
    // close the turn separately with end_turn.
    expect(s.turnTerminated).toBe(false);
    // But the text IS captured for dedup purposes
    expect(s.deliveredTextNorms).toContain("hi");
  });

  it("flips turnTerminated for react (strict default)", () => {
    const s = createStreamState();
    recordToolUse(s, "react", { message_id: 1, emoji: "👍" });
    expect(s.turnTerminated).toBe(true);
  });

  it("does NOT flip turnTerminated for react with end_turn=false (soft)", () => {
    const s = createStreamState();
    recordToolUse(s, "react", {
      message_id: 1,
      emoji: "🤔",
      end_turn: false,
    });
    expect(s.turnTerminated).toBe(false);
  });

  it("does NOT flip turnTerminated for non-terminator tools", () => {
    const s = createStreamState();
    recordToolUse(s, "get_weather", { city: "London" });
    expect(s.turnTerminated).toBe(false);
  });

  it("handles MCP-prefixed tool names", () => {
    const s = createStreamState();
    recordToolUse(s, "mcp__telegram-tools__end_turn", {
      text: "via mcp prefix",
    });
    expect(s.turnTerminated).toBe(true);
  });

  // ── hadBridgeDelivery — catches non-text sends so the handler can
  //   suppress a doubled text-part on the same turn (the live bug
  //   where send(type="photo") landed alongside an assistant text-part).
  it("flips hadBridgeDelivery for end_turn", () => {
    const s = createStreamState();
    recordToolUse(s, "end_turn", { text: "bye" });
    expect(s.hadBridgeDelivery).toBe(true);
  });

  it("flips hadBridgeDelivery for send(type='text')", () => {
    const s = createStreamState();
    recordToolUse(s, "send", { type: "text", text: "hi" });
    expect(s.hadBridgeDelivery).toBe(true);
  });

  it("flips hadBridgeDelivery for send(type='photo')", () => {
    const s = createStreamState();
    recordToolUse(s, "send", {
      type: "photo",
      url: "https://example.com/a.jpg",
    });
    expect(s.hadBridgeDelivery).toBe(true);
    // photo doesn't carry text, so deliveredTextNorms stays empty
    expect(s.deliveredTextNorms).toHaveLength(0);
  });

  it("flips hadBridgeDelivery for MCP-prefixed send", () => {
    const s = createStreamState();
    recordToolUse(s, "talon-tools--1009876543210_send", {
      type: "poll",
      question: "?",
    });
    expect(s.hadBridgeDelivery).toBe(true);
  });

  it("does NOT flip hadBridgeDelivery for react", () => {
    const s = createStreamState();
    recordToolUse(s, "react", { message_id: 1, emoji: "👍" });
    // react annotates the user's message; it's not a separate reply,
    // so a follow-up text-part delivery should NOT be suppressed.
    expect(s.hadBridgeDelivery).toBe(false);
  });

  it("does NOT flip hadBridgeDelivery for read_history", () => {
    const s = createStreamState();
    recordToolUse(s, "read_history", { count: 5 });
    expect(s.hadBridgeDelivery).toBe(false);
  });
});

describe("recordTokens", () => {
  it("records all four fields", () => {
    const s = createStreamState();
    recordTokens(s, {
      inputTokens: 100,
      outputTokens: 200,
      cacheRead: 300,
      cacheWrite: 50,
    });
    expect(s.sdkInputTokens).toBe(100);
    expect(s.sdkOutputTokens).toBe(200);
    expect(s.sdkCacheRead).toBe(300);
    expect(s.sdkCacheWrite).toBe(50);
  });

  it("coerces undefined to 0", () => {
    const s = createStreamState();
    recordTokens(s, {});
    expect(s.sdkInputTokens).toBe(0);
    expect(s.sdkOutputTokens).toBe(0);
  });

  it("clamps negative to 0", () => {
    const s = createStreamState();
    recordTokens(s, { inputTokens: -10 });
    expect(s.sdkInputTokens).toBe(0);
  });
});

describe("finalizeResponseText", () => {
  it("concatenates open block into cumulative + returns trimmed total", () => {
    const s = createStreamState();
    appendText(s, "  hello ");
    closeCurrentSegment(s);
    appendText(s, "world  ");
    const result = finalizeResponseText(s);
    expect(result).toBe("hello world");
    expect(s.currentBlockText).toBe("");
  });

  it("returns just the trailing block when no segments closed", () => {
    const s = createStreamState();
    appendText(s, "  one-shot reply  ");
    expect(finalizeResponseText(s)).toBe("one-shot reply");
  });

  it("returns empty string for empty state", () => {
    const s = createStreamState();
    expect(finalizeResponseText(s)).toBe("");
  });
});
