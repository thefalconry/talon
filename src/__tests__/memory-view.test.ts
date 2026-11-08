/**
 * Tests for the persistent-memory view — ranked selection of `memory.md`
 * under a char budget.
 *
 * The fixture mirrors the shape that motivated the module: a real
 * deployment's memory file where three near-duplicate status snapshots sat
 * above the head-slice cut and the durable knowledge (`## Active
 * Investigations`, with a root-cause analysis in it) sat below and never
 * reached the prompt at all.
 */

import { describe, expect, it } from "vitest";
import {
  MEMORY_INJECT_MAX_CHARS,
  renderMemoryView,
} from "../core/prompt/memory-view.js";

/** Filler that makes a section big enough to matter against the budget. */
const bulk = (n: number): string => `- ${"detail ".repeat(n)}\n`;

/**
 * A memory file in the observed pathological shape: status snapshots first
 * and largest, durable knowledge last and smallest.
 */
function liveShapedMemory(): string {
  return [
    "# Agent Memory",
    "",
    "## User: Ada",
    "- Creator and primary user",
    "- Based in London",
    "",
    "## Inbox / CI Watch (as of 2026-07-03 ~23:15Z, Run #134)",
    bulk(900),
    "## Inbox / CI Watch (as of 2026-07-03 ~10:56Z, Run #122)",
    bulk(1300),
    "## Inbox / CI Watch (as of 2026-07-01 ~15:03Z, Run #121)",
    bulk(1800),
    "## Active Investigations",
    "",
    "### Export pipeline failure — ROOT CAUSE",
    "- The export step drops the cached weights",
    "",
    "## Branches to clean up",
    "- ada-isolate-export-bug",
  ].join("\n");
}

describe("renderMemoryView", () => {
  describe("under the budget", () => {
    it("returns the input byte-identically", () => {
      const content = "# Memory\n\n## User: Ada\n- Lives in London";
      const view = renderMemoryView(content);
      expect(view.text).toBe(content);
      expect(view.truncated).toBe(false);
      expect(view.omitted).toBe("");
    });

    it("does not collapse duplicate status families", () => {
      // Reordering only earns its risk when the alternative is losing
      // content — a file that fits is passed through untouched.
      const content = [
        "## Watch (Run #2)",
        "- b",
        "",
        "## Watch (Run #1)",
        "- a",
      ].join("\n");
      expect(renderMemoryView(content).text).toBe(content);
    });
  });

  describe("over the budget", () => {
    it("keeps durable knowledge that head-slicing would have evicted", () => {
      const content = liveShapedMemory();
      expect(content.length).toBeGreaterThan(MEMORY_INJECT_MAX_CHARS);

      // The old behaviour: a positional cut that never reaches the tail.
      expect(content.slice(0, MEMORY_INJECT_MAX_CHARS)).not.toContain(
        "## Active Investigations",
      );

      const view = renderMemoryView(content);
      expect(view.truncated).toBe(true);
      expect(view.text).toContain("## Active Investigations");
      expect(view.text).toContain("ROOT CAUSE");
      expect(view.text).toContain("## Branches to clean up");
      expect(view.text).toContain("## User: Ada");
    });

    it("collapses a status family to its newest member", () => {
      const view = renderMemoryView(liveShapedMemory());
      const watches = view.text.match(/^## Inbox \/ CI Watch/gm) ?? [];
      expect(watches).toHaveLength(1);
      expect(view.text).toContain("Run #134");
      expect(view.text).not.toContain("Run #122");
      expect(view.text).not.toContain("Run #121");
    });

    it("names the sections it held back", () => {
      const view = renderMemoryView(liveShapedMemory());
      expect(view.omitted).toContain("Run #122");
      expect(view.omitted).toContain("Run #121");
      expect(view.omitted).not.toContain("Active Investigations");
    });

    it("stays within the budget", () => {
      const view = renderMemoryView(liveShapedMemory());
      expect(view.text.length).toBeLessThanOrEqual(MEMORY_INJECT_MAX_CHARS);
    });

    it("emits surviving sections in file order, not tier order", () => {
      const view = renderMemoryView(liveShapedMemory());
      const iUser = view.text.indexOf("## User: Ada");
      const iWatch = view.text.indexOf("## Inbox / CI Watch");
      const iActive = view.text.indexOf("## Active Investigations");
      // `status` ranks below `active`, but the emitted body preserves the
      // author's ordering so the prompt prefix doesn't churn on retier.
      expect(iUser).toBeLessThan(iWatch);
      expect(iWatch).toBeLessThan(iActive);
    });

    it("prefers a dated snapshot over an undated sibling", () => {
      const content = [
        "## Status",
        bulk(400),
        "## Status (as of 2026-07-09)",
        bulk(400),
      ].join("\n");
      const view = renderMemoryView(content, 3_000);
      expect(view.text).toContain("2026-07-09");
    });

    it("ranks directives above status when the budget is tight", () => {
      const content = [
        "## Inbox status (Run #9)",
        bulk(300),
        "## Standing rules",
        "- Never put credentials in the repo",
      ].join("\n");
      const view = renderMemoryView(content, 1_000);
      expect(view.text).toContain("Never put credentials in the repo");
      expect(view.text).not.toContain("## Inbox status");
      expect(view.omitted).toContain("Inbox status (Run #9)");
    });

    it("ranks historical sections last", () => {
      const content = [
        "## Historical: merge flurry",
        bulk(300),
        "## Deploy notes",
        "- staging mirrors prod",
      ].join("\n");
      const view = renderMemoryView(content, 1_000);
      expect(view.text).toContain("staging mirrors prod");
      expect(view.text).not.toContain("## Historical");
    });
  });

  describe("degenerate input", () => {
    it("head-slices a file with no section headings", () => {
      const content = `# Memory\n${bulk(500)}`;
      const view = renderMemoryView(content, 1_000);
      expect(view.truncated).toBe(true);
      expect(view.text.length).toBeLessThanOrEqual(1_000);
      expect(view.text.length).toBeGreaterThan(0);
    });

    it("head-slices when a single section exceeds the whole budget", () => {
      const content = `## One huge section\n${bulk(500)}`;
      const view = renderMemoryView(content, 500);
      expect(view.truncated).toBe(true);
      expect(view.text.length).toBeGreaterThan(0);
      expect(view.text.length).toBeLessThanOrEqual(500);
      expect(view.omitted).toBe("");
    });

    it("handles content that starts at a section heading", () => {
      const content = ["## A", bulk(200), "## B", bulk(200)].join("\n");
      const view = renderMemoryView(content, 1_500);
      expect(view.text).toMatch(/^## /);
    });

    it("elides a long omitted tail", () => {
      const content = Array.from(
        { length: 20 },
        (_, i) => `## Watch ${i} (Run #${i})\n${bulk(60)}`,
      ).join("\n");
      const view = renderMemoryView(content, 1_000);
      expect(view.omitted).toMatch(/and \d+ more$/);
    });
  });
});
