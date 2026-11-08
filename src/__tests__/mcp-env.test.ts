/**
 * Tool exclusions — composeTools drops tools by tag.
 */

import { describe, it, expect } from "vitest";
import { composeTools } from "../core/tools/index.js";

describe("composeTools with exclusions (the server-side effect)", () => {
  it("excluding the stickers tag removes the sticker tools", () => {
    const all = composeTools({ frontend: "telegram" });
    const trimmed = composeTools({
      frontend: "telegram",
      excludeTags: ["stickers"],
    });
    expect(trimmed.length).toBeLessThan(all.length);
    expect(trimmed.some((t) => t.tag === "stickers")).toBe(false);
    // end_turn survives — it's tagged messaging, not stickers.
    expect(trimmed.some((t) => t.name === "end_turn")).toBe(true);
  });
});
