/**
 * Tests for session-name extraction.
 *
 * The cleaned name appears in `/sessions`, the debug surface, and any
 * future inbox UI — short, descriptive, no formatting artefacts.
 */

import { describe, expect, it } from "vitest";
import { extractSessionName } from "../core/weaver/session-name.js";

describe("extractSessionName", () => {
  it("strips leading `[Name]` prefix", () => {
    expect(extractSessionName("[Ada] hello world")).toBe("hello world");
  });

  it("strips `[msg_id:N]` markers", () => {
    expect(extractSessionName("[msg_id:42] please help with X")).toBe(
      "please help with X",
    );
  });

  it("strips both prefix and msg_id together", () => {
    expect(extractSessionName("[Ada] [msg_id:42] body text")).toBe("body text");
  });

  it("truncates long input with ellipsis", () => {
    const long = "x".repeat(50);
    const name = extractSessionName(long);
    expect(name).toBeDefined();
    expect(name!.length).toBeLessThanOrEqual(30); // MAX_NAME_LENGTH total
    expect(name!.endsWith("...")).toBe(true);
  });

  it("returns undefined for empty text", () => {
    expect(extractSessionName("")).toBeUndefined();
  });

  it("returns undefined when only formatting prefixes remain", () => {
    expect(extractSessionName("[Ada] [msg_id:42]")).toBeUndefined();
  });

  it("returns undefined for whitespace-only text", () => {
    expect(extractSessionName("   \n  ")).toBeUndefined();
  });

  it("preserves text that fits inside MAX_NAME_LENGTH", () => {
    expect(extractSessionName("short text")).toBe("short text");
  });

  it("decodes HTML entities like &quot; and &#34;", () => {
    expect(
      extractSessionName("He said &quot;hello&quot; and &#39;hi&#39;"),
    ).toBe("He said \"hello\" and 'hi'");
  });
});
