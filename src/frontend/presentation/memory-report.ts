/**
 * `/memory` — a read-only window on the typed memory store, rendered in
 * any frontend's markup.
 *
 * Four shapes, all reads: the ranked listing, a full-text search, one
 * row's provenance (`why <id>`) and a per-kind listing. Nothing here
 * writes: asserting, superseding and dropping are the write path's job,
 * so the operator can always ask what Talon remembers without the answer
 * being able to change it.
 *
 * Every line is model- or user-authored text, so it goes through
 * `fmt.escape` before it is joined — for Telegram's HTML parse mode that
 * is what keeps a `<` in a memory from failing the whole send. Who may
 * read memory at all is the calling frontend's decision.
 */

import {
  formatMemory,
  getMemory,
  isMemoryKind,
  listMemories,
  memoryHistory,
  searchMemories,
  MEMORY_KINDS,
  type MemoryRow,
} from "../../storage/memory.js";
import type { ReportFormatter } from "./reports.js";

/** Rows per reply — a chat listing is a glance, not an export. */
const LIST_LIMIT = 15;

type MemoryFormatter = Pick<ReportFormatter, "bold" | "escape">;

/** Route the argument to one of the four reads. Returns ready markup. */
export function renderMemoryReport(arg: string, fmt: MemoryFormatter): string {
  const why = /^why\b\s*(.*)$/is.exec(arg);
  if (why) return renderWhy(why[1]!.trim(), fmt);
  const kind = /^kind\b\s*(.*)$/is.exec(arg);
  if (kind) return renderKind(kind[1]!.trim(), fmt);
  if (!arg)
    return renderRows(
      listMemories({ limit: LIST_LIMIT }),
      "Nothing remembered yet.",
      fmt,
    );
  return renderRows(
    searchMemories(arg, { limit: LIST_LIMIT }),
    `No memories matching "${arg}".`,
    fmt,
  );
}

/** One escaped line per row, or the (escaped) empty-case sentence. */
function renderRows(
  rows: MemoryRow[],
  empty: string,
  fmt: MemoryFormatter,
): string {
  if (rows.length === 0) return fmt.escape(empty);
  return rows.map((row) => fmt.escape(formatMemory(row))).join("\n");
}

function renderKind(kind: string, fmt: MemoryFormatter): string {
  if (!isMemoryKind(kind))
    return fmt.escape(
      `No such kind "${kind}". Valid kinds: ${MEMORY_KINDS.join(", ")}.`,
    );
  return renderRows(
    listMemories({ kind, limit: LIST_LIMIT }),
    `Nothing remembered under ${kind}.`,
    fmt,
  );
}

/**
 * Provenance for one row: the row itself, the numbers that decide where
 * it ranks, and its audit trail. Reads by id rather than by the live
 * listing, so a superseded or dropped row still explains itself.
 */
function renderWhy(raw: string, fmt: MemoryFormatter): string {
  const id = Number(raw);
  if (!raw || !Number.isInteger(id))
    return fmt.escape(`No memory with id ${raw || "(none given)"}.`);
  const row = getMemory(id);
  if (!row) return fmt.escape(`No memory with id ${id}.`);
  const lines = [
    fmt.escape(formatMemory(row)),
    "",
    fmt.escape(
      `trust ${row.trust} · confidence ${row.confidence} · hits ${row.hitCount} · salience ${row.salience}`,
    ),
    fmt.escape(
      `created ${isoTime(row.createdAt)} · last seen ${isoTime(row.lastSeenAt)}`,
    ),
  ];
  const history = memoryHistory(row.id);
  if (history.length > 0) {
    lines.push("", fmt.bold("History"));
    for (const entry of history) {
      const reason = entry.reason ? ` — ${entry.reason}` : "";
      lines.push(fmt.escape(`${isoTime(entry.at)} ${entry.op}${reason}`));
    }
  }
  return lines.join("\n");
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}
