/**
 * Cross-process write contention on talon.db. The daemon and a CLI
 * command (`talon memory …`), or an outgoing daemon and its respawned
 * successor, share one database file: a write that meets another
 * process's write lock must wait for it, not fail on the spot with
 * "database is locked".
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { closeDatabase, getDatabase } from "../storage/db.js";

let workDir: string;
let holder: ChildProcess | undefined;

beforeEach(() => {
  closeDatabase();
  workDir = mkdtempSync(join(tmpdir(), "talon-db-busy-"));
});

afterEach(() => {
  holder?.kill();
  holder = undefined;
  closeDatabase();
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Start a second process that takes the write lock, reports it, holds it
 * for `holdMs`, then commits. Resolves once the lock is held.
 */
function holdWriteLock(path: string, holdMs: number): Promise<void> {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(path)});
    db.exec("BEGIN IMMEDIATE");
    db.exec("INSERT INTO busy_probe VALUES ('holder')");
    process.stdout.write("locked\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
    db.exec("COMMIT");
    db.close();
  `;
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  holder = child;
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("locked")) resolve();
    });
    child.on("exit", (code) => reject(new Error(`holder exited (${code})`)));
  });
}

describe("getDatabase — concurrent writers", () => {
  it("waits out another process's write lock instead of throwing SQLITE_BUSY", async () => {
    const path = join(workDir, "talon.db");
    const db = getDatabase(path);
    db.exec("CREATE TABLE busy_probe (who TEXT)");

    await holdWriteLock(path, 400);

    // Blocks until the holder commits (~400ms), then lands.
    expect(() =>
      db.prepare("INSERT INTO busy_probe VALUES (?)").run("daemon"),
    ).not.toThrow();
    const rows = db.prepare("SELECT who FROM busy_probe ORDER BY rowid").all();
    expect(rows).toEqual([{ who: "holder" }, { who: "daemon" }]);
  });
});
