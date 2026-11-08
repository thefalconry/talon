/**
 * Typed rows → a `memory.md` document, and back again.
 *
 * Most cases hand `renderMemoryMarkdown` an explicit row set: the SQLite
 * database is shared by every suite in the worker, so ordering and budget
 * assertions are only meaningful against rows the case owns. The
 * round-trip case uses the real store, scoped by `source.chat`.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { importDailyNotes, importMemoryFile } from "../core/memory/import.js";
import {
  renderMemoryMarkdown,
  writeRenderedMemory,
} from "../core/memory/render.js";
import {
  MEMORY_KINDS,
  listMemories,
  type MemoryRow,
} from "../storage/memory.js";

let seq = 0;
let nextId = 1000;

function freshTag(): string {
  return `ren${++seq}x${Date.now().toString(36)}`;
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "talon-memory-render-"));
}

/** A synthetic row — the render only reads fields, never the database. */
function row(over: Partial<MemoryRow> & { subject: string }): MemoryRow {
  return {
    id: ++nextId,
    kind: "fact",
    text: `text for ${over.subject}`,
    source: { actor: "import" },
    trust: "operator",
    confidence: 1,
    createdAt: 0,
    lastSeenAt: 0,
    hitCount: 0,
    salience: 0,
    pinned: false,
    contentHash: "hash",
    ...over,
  };
}

describe("renderMemoryMarkdown", () => {
  it("renders the same rows to the same bytes", () => {
    const rows = [
      row({ subject: "alpha", salience: 2 }),
      row({ subject: "beta", kind: "directive" }),
      row({ subject: "gamma", kind: "episode" }),
    ];
    expect(renderMemoryMarkdown({ rows })).toBe(renderMemoryMarkdown({ rows }));
  });

  it("orders pinned rows first, then by kind", () => {
    const rows = [
      row({ subject: "an episode", kind: "episode", pinned: true }),
      row({ subject: "a directive", kind: "directive" }),
      row({ subject: "a fact" }),
      row({ subject: "a person", kind: "relationship" }),
    ];
    const headings = [
      ...renderMemoryMarkdown({ rows }).matchAll(/^## (.+)$/gm),
    ].map((match) => match[1]);
    expect(headings).toEqual([
      "an episode",
      "a directive",
      "a person",
      "a fact",
    ]);
  });

  it("renders a state row under its key and regroups chunked rows", () => {
    const rows = [
      row({ subject: "ci.watch", key: "ci.watch", kind: "state", text: "red" }),
      row({ subject: "long (1/2)", text: "first half" }),
      row({ subject: "long (2/2)", text: "second half" }),
    ];
    const markdown = renderMemoryMarkdown({ rows });
    expect(markdown).toContain("## ci.watch\n\nred\n");
    expect(markdown).toContain("## long\n\nfirst half\n\nsecond half\n");
  });

  it("stops at a section boundary and names what was left out", () => {
    const body = (label: string): string => `${label} body `.repeat(80).trim();
    const rows = [
      row({ subject: "first", salience: 3, text: body("first") }),
      row({ subject: "second", salience: 2, text: body("second") }),
      row({ subject: "third", salience: 1, text: body("third") }),
    ];
    const whole = renderMemoryMarkdown({ rows, budget: 1_000_000 });
    // 100 chars short of the whole: the last section can no longer fit.
    const budget = whole.length - 100;
    const cut = renderMemoryMarkdown({ rows, budget });

    expect(cut.length).toBeLessThanOrEqual(budget);
    expect(cut).toContain("## first");
    expect(cut).toContain("## second");
    expect(cut).not.toContain("## third");
    // Whole sections only: no half-written heading or body survived.
    expect(cut).not.toContain(body("third"));
    expect(cut.trimEnd()).toMatch(
      /_… 1 more section in the store — `talon memory list`_$/,
    );
  });

  it("renders live store rows when no rows are supplied", () => {
    const dir = scratch();
    const tag = freshTag();
    const path = join(dir, `memory-${tag}.md`);
    writeFileSync(path, `# M\n\n## Directives ${tag}\n\n- keep it terse\n`);
    importMemoryFile(path);

    const markdown = renderMemoryMarkdown({ budget: 2_000_000 });
    expect(markdown).toContain(`## directives ${tag}`);
    expect(markdown).toContain("- keep it terse");
  });
});

describe("writeRenderedMemory", () => {
  it("archives the previous file once a day, then writes the render", () => {
    const dir = scratch();
    const archive = join(dir, "archive");
    const path = join(dir, "memory.md");
    writeFileSync(path, "# hand-written\n");

    const rows = [row({ subject: "written fact", text: "one claim" })];
    const first = writeRenderedMemory(path, { rows, archiveDir: archive });
    expect(first.backup).toBeDefined();
    expect(readFileSync(first.backup!, "utf8")).toBe("# hand-written\n");
    expect(readFileSync(path, "utf8")).toContain("## written fact");
    expect(first.bytes).toBe(readFileSync(path, "utf8").length);

    // Second render the same day must not overwrite the archived original.
    const second = writeRenderedMemory(path, { rows, archiveDir: archive });
    expect(second.backup).toBeUndefined();
    expect(readFileSync(first.backup!, "utf8")).toBe("# hand-written\n");
  });

  it("writes without an archive when there is no file yet", () => {
    const dir = scratch();
    const path = join(dir, "fresh", "memory.md");
    const result = writeRenderedMemory(path, {
      rows: [row({ subject: "fresh fact" })],
      archiveDir: join(dir, "archive"),
    });
    expect(result.backup).toBeUndefined();
    expect(existsSync(path)).toBe(true);
  });
});

describe("import → render → import", () => {
  it("is a fixed point: re-importing a render inserts nothing", () => {
    const dir = scratch();
    const tag = freshTag();
    const chat = `memory-${tag}.md`;
    const path = join(dir, chat);
    writeFileSync(
      path,
      [
        "# Agent Memory",
        "",
        `## Directives ${tag}`,
        "",
        "- Never force-push main",
        "",
        `## User: Ada ${tag}`,
        "",
        "- Prefers terse answers",
        "",
        `## Inbox / CI Watch ${tag} (as of 2026-08-11, Run #7)`,
        "",
        "- flaky: telegram smoke",
        "",
        `## Historical Notes ${tag}`,
        "",
        "- The soul kernel was torn down",
        "",
      ].join("\n"),
    );
    const daily = join(dir, "daily");
    mkdirSync(daily, { recursive: true });
    writeFileSync(join(daily, "2026-08-11.md"), `- shipped ${tag}\n`);

    expect(importMemoryFile(path).inserted).toBe(4);
    expect(importDailyNotes(daily).inserted).toBe(1);

    const chats = new Set([chat, "2026-08-11.md"]);
    const rows = MEMORY_KINDS.flatMap((kind) =>
      listMemories({ kind, limit: 500 }).filter(
        (r) => r.source.actor === "import" && chats.has(r.source.chat ?? ""),
      ),
    );
    expect(rows).toHaveLength(5);

    const rendered = join(dir, "rendered.md");
    writeFileSync(rendered, renderMemoryMarkdown({ rows, budget: 2_000_000 }));

    expect(importMemoryFile(rendered)).toEqual({
      inserted: 0,
      superseded: 0,
      skipped: 5,
    });
  });
});
