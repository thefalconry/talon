/**
 * SQLite connection + schema setup — the high-performance data
 * layer's entry point.
 *
 * One database at ~/.talon/data/talon.db, opened through the runtime's
 * built-in SQLite: `node:sqlite` (stable since Node 23.4) under node,
 * `bun:sqlite` under bun — so compiled single binaries need no native
 * addon and there is nothing on disk to resolve. The heavy lifting —
 * storage engine, indexes, FTS5 full-text search — is battle-tested C,
 * orchestrated from TypeScript.
 *
 * Layering (keep it this way):
 *   - sql/schema.sql            all DDL, idempotent, ensured on open
 *   - sql/<store>.sql           every statement for one store
 *   - sql/statements.generated.ts  committed embed of the above
 *                               (`npm run build:sql`, see sql/embed.ts)
 *   - repositories/<store>.ts   statement execution for one store, typed rows
 *   - <store>.ts                public API + domain logic, ZERO SQL
 *   - db.ts (this file)         connection, pragmas, schema setup
 *
 * Why this over the JSON stores it replaces: transactional row writes
 * instead of rewrite-the-whole-file flush timers, indexed reads instead
 * of in-memory scans (so retention needn't be capped), and FTS5 where
 * stores need real search.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { files } from "../util/paths.js";
import { log, logError, logWarn } from "../util/log.js";
import { SCHEMA, dbSql } from "./sql/statements.generated.js";

/**
 * The driver surface the repositories use — the intersection of
 * node:sqlite's DatabaseSync and bun:sqlite's Database, which are
 * API-compatible for exactly this set (verified empirically: prepared
 * statements with positional params, identical row object shapes,
 * multi-statement exec, FTS5 virtual tables).
 */
type SqlStatement = {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
};
export type SqlDatabase = {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  close(): void;
};

// bun (≤1.3.x) does not implement node:sqlite — a compiled binary dies
// at startup with "No such built-in module: node:sqlite". Both
// runtimes ship a native SQLite builtin, so pick at load time. The
// non-literal import specifier keeps tsc and bundlers from trying to
// resolve the module that doesn't exist on the other runtime.
const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const sqliteModule = (await import(
  IS_BUN ? "bun:sqlite" : "node:sqlite"
)) as Record<string, new (path: string) => SqlDatabase>;
const Database = IS_BUN ? sqliteModule.Database : sqliteModule.DatabaseSync;
/** The same constructor, with the options bag both runtimes accept. */
const ReadOnlyDatabase = Database as unknown as new (
  path: string,
  options: Record<string, boolean>,
) => SqlDatabase;

let db: SqlDatabase | null = null;

/** How long a write waits on another connection's lock before SQLITE_BUSY. */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Apply the complete schema. Every statement is IF NOT EXISTS, so this
 * is a no-op on an up-to-date database and creates exactly what's
 * missing on a fresh or older one.
 *
 * Column reconciliation runs first: `ALTER TABLE … ADD COLUMN` has no
 * IF NOT EXISTS form, so columns added to already-shipped tables are
 * ensured by attempting the ALTER and swallowing the two expected
 * failures — "duplicate column name" (column already there) and "no
 * such table" (fresh database; the CREATE TABLE in schema.sql includes
 * the column).
 */
function ensureSchema(database: SqlDatabase): void {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS tables FROM sqlite_master WHERE type = 'table'",
    )
    .get() as { tables: number };
  for (const addColumn of [
    dbSql.addMediaContentHashColumn,
    dbSql.addHistorySenderHandleColumn,
    dbSql.addSessionsMetricsColumn,
    dbSql.addHistoryAttachmentsColumn,
    dbSql.addSessionsLastTurnEndedAtColumn,
    dbSql.addCronTimeoutMsColumn,
  ]) {
    try {
      database.exec(addColumn);
    } catch (err) {
      // Duplicate column or no such table both mean nothing to do. Any
      // other failure (read-only file, full disk) is a real fault the
      // schema step below will likely trip over too — say which ALTER.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name|no such table/i.test(msg)) {
        logWarn(
          "db",
          `schema column reconcile failed: ${msg}${dbErrorFields(err)} sql=${JSON.stringify(addColumn.slice(0, 60))}`,
        );
      }
    }
  }
  database.exec("BEGIN");
  try {
    database.exec(SCHEMA);
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
  if (row.tables === 0) log("db", "Initialized database schema");
}

/**
 * The SQLite result code behind a driver error, as ` key=value` log
 * fields (leading space; empty when there is none). node:sqlite keeps
 * it out of the message — "database or disk is full" arrives as
 * `errcode: 13` — so a log line built from `err.message` alone can't
 * be grepped for SQLITE_FULL (13), SQLITE_BUSY (5) or SQLITE_READONLY (8).
 */
export function dbErrorFields(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const e = err as { code?: unknown; errcode?: unknown; errno?: unknown };
  let out = "";
  if (typeof e.code === "string") out += ` code=${e.code}`;
  // node:sqlite names it errcode, bun:sqlite errno.
  const rc = typeof e.errcode === "number" ? e.errcode : e.errno;
  if (typeof rc === "number") out += ` errcode=${rc}`;
  return out;
}

function defaultPath(): string {
  // Test isolation: the vitest setup file points every worker at a
  // throwaway database so suites never touch ~/.talon/data/talon.db.
  return process.env.TALON_DB_PATH || files.database;
}

/**
 * Open (or return) the process-wide database. The first call wins the
 * path; tests pass an explicit tmp path and call closeDatabase() in
 * teardown.
 */
export function getDatabase(path: string = defaultPath()): SqlDatabase {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  try {
    // Other processes write this file too (CLI commands, a respawned
    // successor overlapping its predecessor). Both drivers default to a
    // zero busy timeout, i.e. "database is locked" the instant a write
    // meets theirs — wait for the lock instead. First, so the pragmas
    // and schema setup below get it too.
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // WAL: readers don't block the writer, and crash recovery is
    // journal-based instead of "hope the rename was atomic".
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec("PRAGMA foreign_keys = ON");
    ensureSchema(database);
  } catch (err) {
    // Setup failed — close the handle so a retry doesn't leak one
    // open file descriptor (and WAL sidecar) per attempt.
    try {
      database.close();
    } catch {
      /* already closed */
    }
    throw err;
  }
  db = database;
  return database;
}

let transactionDepth = 0;

/**
 * Best-effort rollback: a ROLLBACK that itself throws (database closed,
 * I/O error) must not mask the original error from `fn`, and must not
 * skip the depth bookkeeping — a stuck depth would silently turn every
 * later top-level transaction into a savepoint.
 */
function tryExec(database: SqlDatabase, sql: string): void {
  try {
    database.exec(sql);
  } catch (err) {
    logError("db", `Transaction cleanup failed (${sql})`, err);
  }
}

/** Run `fn` inside a transaction; rolls back on throw. Nested calls use SAVEPOINTs. */
export function inTransaction<T>(fn: () => T): T {
  const database = getDatabase();
  if (transactionDepth > 0) {
    const sp = `sp${transactionDepth}`;
    database.exec(`SAVEPOINT "${sp}"`);
    transactionDepth++;
    try {
      const result = fn();
      database.exec(`RELEASE "${sp}"`);
      return result;
    } catch (err) {
      tryExec(database, `ROLLBACK TO "${sp}"`);
      tryExec(database, `RELEASE "${sp}"`);
      throw err;
    } finally {
      transactionDepth--;
    }
  }
  database.exec("BEGIN");
  transactionDepth++;
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (err) {
    tryExec(database, "ROLLBACK");
    throw err;
  } finally {
    transactionDepth--;
  }
}

/**
 * Compact the WAL into the main database file. SQLite commits on
 * every write, so there is no dirty buffer to flush — the shutdown
 * and fatal-error paths call this once for the whole database
 * (replacing the per-store flush functions of the JSON era).
 */
export function flushDatabase(): void {
  if (!db) return;
  try {
    db.exec(dbSql.walCheckpoint);
  } catch (err) {
    // Shutting down — best effort, but a checkpoint that fails here
    // (disk full, I/O error) is the last word on why the WAL grew.
    logWarn(
      "db",
      `WAL checkpoint failed: ${err instanceof Error ? err.message : String(err)}${dbErrorFields(err)}`,
    );
  }
}

/**
 * Write a transactionally consistent copy of the database to `destPath`.
 *
 * The backup subsystem's only way in: a snapshot may not copy
 * `data/talon.db` from disk, because in WAL mode the committed pages
 * live partly in the sidecar and a byte-wise copy of the main file is a
 * corrupt (or silently stale) database. `VACUUM INTO` asks SQLite for
 * the copy instead — one file, no WAL, checkpointed and compacted,
 * consistent as of the moment it runs, with concurrent readers and
 * writers untouched.
 *
 * `destPath` must not exist (SQLite refuses to overwrite); its parent
 * directory is created if needed.
 */
export function snapshotDatabase(destPath: string): void {
  const database = getDatabase();
  mkdirSync(dirname(destPath), { recursive: true });
  database.prepare(dbSql.vacuumInto).run(destPath);
}

/**
 * Consistent copy of ANOTHER program's SQLite file (a backend's session
 * store) — the same `VACUUM INTO` as {@link snapshotDatabase}, through a
 * read-only handle so the owner's database and WAL are never written.
 */
export function snapshotSqliteFile(sourcePath: string, destPath: string): void {
  const foreign = new ReadOnlyDatabase(
    sourcePath,
    IS_BUN ? { readonly: true } : { readOnly: true },
  );
  try {
    mkdirSync(dirname(destPath), { recursive: true });
    foreign.prepare(dbSql.vacuumInto).run(destPath);
  } finally {
    foreign.close();
  }
}

export function closeDatabase(): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* already closed */
  }
  db = null;
}
