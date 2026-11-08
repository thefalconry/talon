/**
 * `memory.md` + daily notes → typed rows.
 *
 * Every case writes its fixture into its own `mkdtemp` directory and tags
 * every heading with a unique token, because the SQLite database is
 * shared by every test in this file (and every other suite in the worker).
 * `source.chat` — the fixture's filename — is what scopes a case's rows
 * back out of the shared store.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { importDailyNotes, importMemoryFile } from "../core/memory/import.js";
import {
  MEMORY_KINDS,
  listMemories,
  type MemoryRow,
} from "../storage/memory.js";

let seq = 0;

/** A token that is unique per case and survives both slugging and lowercasing. */
function freshTag(): string {
  return `imp${++seq}x${Date.now().toString(36)}`;
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "talon-memory-import-"));
}

/** Every live row a given fixture file put in the store. */
function importedRows(chat: string): MemoryRow[] {
  return MEMORY_KINDS.flatMap((kind) =>
    listMemories({ kind, limit: 500 }).filter(
      (row) => row.source.chat === chat && row.source.actor === "import",
    ),
  );
}

function bySubject(chat: string, subject: string): MemoryRow[] {
  return importedRows(chat).filter((row) => row.subject === subject);
}

/** A paragraph big enough that three of them blow the 4000-char text cap. */
const fatParagraph = (label: string): string =>
  `${label} ${"lorem ipsum dolor sit amet ".repeat(80)}`.trim();

/**
 * A fixture in the shape PR 5 has to handle: directives, a person, two
 * snapshots of one status family (newest written first, so file order and
 * recency disagree), a historical section and an oversize one.
 */
function fixture(tag: string, ciText = "- flaky: telegram smoke"): string {
  return [
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
    `## Inbox / CI Watch ${tag} (as of 2026-07-03, Run #134)`,
    "",
    ciText,
    "",
    `## Inbox / CI Watch ${tag} (as of 2026-07-01, Run #100)`,
    "",
    "- flaky: an older snapshot nobody should see",
    "",
    `## Historical Notes ${tag}`,
    "",
    "- The soul kernel was torn down",
    "",
    `## Big Notes ${tag}`,
    "",
    fatParagraph("one"),
    "",
    fatParagraph("two"),
    "",
    fatParagraph("three"),
    "",
  ].join("\n");
}

function writeFixture(dir: string, tag: string, ciText?: string): string {
  const name = `memory-${tag}.md`;
  const path = join(dir, name);
  writeFileSync(path, ciText ? fixture(tag, ciText) : fixture(tag));
  return path;
}

describe("importMemoryFile", () => {
  it("maps each section to a kind, subject and key by its heading tier", () => {
    const dir = scratch();
    const tag = freshTag();
    const path = writeFixture(dir, tag);
    const chat = `memory-${tag}.md`;

    const counts = importMemoryFile(path);
    expect(counts.superseded).toBe(0);
    expect(counts.skipped).toBe(0);

    const directive = bySubject(chat, `directives ${tag}`);
    expect(directive).toHaveLength(1);
    expect(directive[0]!.kind).toBe("directive");
    expect(directive[0]!.trust).toBe("operator");
    expect(directive[0]!.source).toEqual({ actor: "import", chat });
    expect(directive[0]!.text).toBe("- Never force-push main");

    const person = bySubject(chat, `User: Ada ${tag}`);
    expect(person).toHaveLength(1);
    expect(person[0]!.kind).toBe("relationship");

    const past = bySubject(chat, `historical notes ${tag}`);
    expect(past).toHaveLength(1);
    expect(past[0]!.kind).toBe("episode");
  });

  it("keeps only the newest snapshot of a status family as the live state row", () => {
    const dir = scratch();
    const tag = freshTag();
    const path = writeFixture(dir, tag);
    const chat = `memory-${tag}.md`;
    importMemoryFile(path);

    const key = `inbox.ci-watch-${tag}`;
    const state = importedRows(chat).filter((row) => row.kind === "state");
    expect(state).toHaveLength(1);
    expect(state[0]!.key).toBe(key);
    expect(state[0]!.subject).toBe(key);
    expect(state[0]!.text).toBe("- flaky: telegram smoke");
  });

  it("splits an oversize section at paragraph boundaries", () => {
    const dir = scratch();
    const tag = freshTag();
    const path = writeFixture(dir, tag);
    const chat = `memory-${tag}.md`;
    importMemoryFile(path);

    const chunks = importedRows(chat)
      .filter((row) => row.subject.startsWith(`big notes ${tag}`))
      .sort((a, b) => a.subject.localeCompare(b.subject));
    expect(chunks.map((row) => row.subject)).toEqual([
      `big notes ${tag} (1/3)`,
      `big notes ${tag} (2/3)`,
      `big notes ${tag} (3/3)`,
    ]);
    for (const chunk of chunks) {
      expect(chunk.kind).toBe("fact");
      expect(chunk.text.length).toBeLessThanOrEqual(4_000);
    }
    expect(chunks[0]!.text.startsWith("one ")).toBe(true);
    expect(chunks[2]!.text.startsWith("three ")).toBe(true);
  });

  it("is idempotent: a second run skips everything and adds no rows", () => {
    const dir = scratch();
    const tag = freshTag();
    const path = writeFixture(dir, tag);
    const chat = `memory-${tag}.md`;

    const first = importMemoryFile(path);
    const before = importedRows(chat).map((row) => row.id);

    const second = importMemoryFile(path);
    expect(second.inserted).toBe(0);
    expect(second.superseded).toBe(0);
    expect(second.skipped).toBe(first.inserted);
    expect(importedRows(chat).map((row) => row.id)).toEqual(before);
  });

  it("supersedes exactly the section a hand-edit changed", () => {
    const dir = scratch();
    const tag = freshTag();
    const path = writeFixture(dir, tag);
    const chat = `memory-${tag}.md`;
    importMemoryFile(path);
    const before = importedRows(chat);

    writeFileSync(
      path,
      fixture(tag).replace(
        "- Never force-push main",
        "- Never force-push main, ever",
      ),
    );
    const again = importMemoryFile(path);
    expect(again).toEqual({
      inserted: 0,
      superseded: 1,
      skipped: before.length - 1,
    });

    const directive = bySubject(chat, `directives ${tag}`);
    expect(directive).toHaveLength(1);
    expect(directive[0]!.text).toBe("- Never force-push main, ever");
    const old = before.find((row) => row.subject === `directives ${tag}`)!;
    expect(directive[0]!.id).not.toBe(old.id);
    expect(listMemories({ kind: "directive", subject: old.subject })).toEqual(
      directive,
    );
  });

  it("returns empty counts for a file that does not exist", () => {
    expect(importMemoryFile(join(scratch(), "nope.md"))).toEqual({
      inserted: 0,
      superseded: 0,
      skipped: 0,
    });
  });
});

describe("importDailyNotes", () => {
  it("imports one episode per dated note and skips the soul's diary", () => {
    const dir = join(scratch(), "daily");
    mkdirSync(dir, { recursive: true });
    const tag = freshTag();
    writeFileSync(join(dir, "2026-09-01.md"), `- shipped ${tag}\n`);
    writeFileSync(join(dir, "2026-09-02.md"), `- reviewed ${tag}\n`);
    writeFileSync(join(dir, `diary-2026-09-02.md`), `- I felt ${tag}\n`);
    writeFileSync(join(dir, "notes.txt"), `- ignored ${tag}\n`);

    const counts = importDailyNotes(dir);
    expect(counts.inserted).toBe(2);

    const first = importedRows("2026-09-01.md");
    expect(first).toHaveLength(1);
    expect(first[0]!.kind).toBe("episode");
    expect(first[0]!.subject).toBe("2026-09-01");
    expect(first[0]!.text).toBe(`- shipped ${tag}`);
    expect(importedRows("diary-2026-09-02.md")).toHaveLength(0);
    expect(importedRows("notes.txt")).toHaveLength(0);

    expect(importDailyNotes(dir)).toEqual({
      inserted: 0,
      superseded: 0,
      skipped: 2,
    });
  });

  it("demotes a note's own headings so a render cannot re-split the row", () => {
    const dir = join(scratch(), "daily");
    mkdirSync(dir, { recursive: true });
    const tag = freshTag();
    writeFileSync(
      join(dir, "2026-09-03.md"),
      `## Morning\n\n- stood up ${tag}\n\n### Detail\n\n- kept\n`,
    );

    expect(importDailyNotes(dir).inserted).toBe(1);
    const rows = importedRows("2026-09-03.md");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain("### Morning");
    expect(rows[0]!.text).not.toMatch(/^## /m);
    // Still an h3, not an h4: demotion is a one-step, idempotent rule.
    expect(rows[0]!.text).toContain("### Detail");
  });

  it("returns empty counts for a directory that does not exist", () => {
    expect(importDailyNotes(join(scratch(), "missing"))).toEqual({
      inserted: 0,
      superseded: 0,
      skipped: 0,
    });
  });
});
