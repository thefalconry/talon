/**
 * Tests for the shared delivered-text / dedup primitives.
 *
 * `normalizeForDedupe`, `isDuplicateOfDelivered`, and
 * `captureDeliveredText` are consumed by every backend's flow-violation
 * check. Their contracts have to stay tight — false positives swallow
 * legitimate user-facing prose, false negatives surface duplicate
 * messages.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeForDedupe,
  isDuplicateOfDelivered,
  captureDeliveredText,
} from "../backend/runtime/turn/delivered-text.js";

describe("normalizeForDedupe", () => {
  it("trims + lowercases", () => {
    expect(normalizeForDedupe("  Hello WORLD  ")).toBe("hello world");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeForDedupe("hello\t\n  world")).toBe("hello world");
  });

  it("strips emoji", () => {
    expect(normalizeForDedupe("hello 👋 world 🎉")).toBe("hello world");
    expect(normalizeForDedupe("🔥🔥🔥")).toBe("");
  });

  it("handles empty input", () => {
    expect(normalizeForDedupe("")).toBe("");
    expect(normalizeForDedupe("   ")).toBe("");
  });
});

describe("isDuplicateOfDelivered", () => {
  it("returns false for empty delivered list", () => {
    expect(isDuplicateOfDelivered("anything", [])).toBe(false);
  });

  it("returns false for very short candidate (below MIN_DEDUP_LENGTH)", () => {
    expect(isDuplicateOfDelivered("ok", ["ok"])).toBe(false);
    expect(isDuplicateOfDelivered("👍", ["👍"])).toBe(false);
  });

  it("detects exact match after normalization", () => {
    expect(
      isDuplicateOfDelivered("Hello there, friend!", [
        normalizeForDedupe("Hello there, friend!"),
      ]),
    ).toBe(true);
  });

  it("detects substring containment (candidate within delivered)", () => {
    const delivered = [
      normalizeForDedupe("Here is the complete response with all the details"),
    ];
    expect(
      isDuplicateOfDelivered("here is the complete response", delivered),
    ).toBe(true);
  });

  it("detects substring containment (delivered within candidate)", () => {
    const delivered = [normalizeForDedupe("short delivered text here")];
    expect(
      isDuplicateOfDelivered(
        "Some preamble, then short delivered text here, and a tail",
        delivered,
      ),
    ).toBe(true);
  });

  it("returns false when nothing meaningful overlaps", () => {
    const delivered = [normalizeForDedupe("completely different content")];
    expect(
      isDuplicateOfDelivered("an unrelated message reply", delivered),
    ).toBe(false);
  });

  it("ignores delivered entries that are themselves too short", () => {
    expect(isDuplicateOfDelivered("a longer candidate string", ["ok"])).toBe(
      false,
    );
  });
});

describe("captureDeliveredText", () => {
  it("captures end_turn text arg", () => {
    expect(captureDeliveredText("end_turn", { text: "Hi there" })).toBe(
      "hi there",
    );
  });

  it("captures send(type=text) text arg", () => {
    expect(
      captureDeliveredText("send", { type: "text", text: "Hi there" }),
    ).toBe("hi there");
  });

  it("strips MCP prefix from tool name", () => {
    // Short text still captures (length filter lives in isDuplicateOfDelivered)
    expect(
      captureDeliveredText("mcp__telegram-tools__end_turn", { text: "Hi" }),
    ).toBe("hi");

    expect(
      captureDeliveredText("mcp__telegram-tools__end_turn", {
        text: "This is a longer reply",
      }),
    ).toBe("this is a longer reply");
  });

  it("returns undefined for non-delivery tools", () => {
    expect(captureDeliveredText("react", { emoji: "👍" })).toBeUndefined();
    expect(
      captureDeliveredText("get_weather", { city: "London" }),
    ).toBeUndefined();
  });

  it("returns undefined for send(type=photo)", () => {
    expect(
      captureDeliveredText("send", { type: "photo", file_path: "x.jpg" }),
    ).toBeUndefined();
  });

  it("returns undefined when text is empty", () => {
    expect(captureDeliveredText("end_turn", { text: "" })).toBeUndefined();
    expect(captureDeliveredText("end_turn", { text: "   " })).toBeUndefined();
  });

  it("returns undefined when text is missing", () => {
    expect(captureDeliveredText("end_turn", {})).toBeUndefined();
    expect(captureDeliveredText("end_turn", { reply_to: 123 })).toBeUndefined();
  });
});
