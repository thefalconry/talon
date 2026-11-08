/**
 * A disk that fills up mid-snapshot. The part's write stream fails with
 * ENOSPC while the tar writer is still feeding it; the build must reject
 * with that error, leave no directory behind, and raise no unhandled
 * rejection — in the CLI (`talon backup now` with the daemon down) an
 * unhandled rejection kills the process before the cleanup runs.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

const disk = vi.hoisted(() => ({ full: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: ((path: string, options?: unknown) => {
      if (!disk.full || !String(path).includes(".tar.zst")) {
        return actual.createWriteStream(path, options as never);
      }
      let written = 0;
      return new Writable({
        write(chunk: Buffer, _encoding, callback) {
          written += chunk.length;
          if (written < 32 * 1024) return callback();
          const err = new Error("ENOSPC: no space left on device, write");
          callback(Object.assign(err, { code: "ENOSPC", syscall: "write" }));
        },
      });
    }) as typeof actual.createWriteStream,
  };
});

const { buildSnapshot } = await import("../core/backup/snapshot.js");
const { resolveBackupSettings } = await import("../core/backup/plan.js");

afterEach(() => {
  disk.full = false;
});

describe("a snapshot on a full disk", () => {
  it("fails cleanly: no leftover directory, no unhandled rejection", async () => {
    const home = mkdtempSync(join(tmpdir(), "talon-enospc-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
    // Incompressible, so the compressor keeps the sink busy.
    writeFileSync(
      join(home, "workspace", "memory", "memory.md"),
      randomBytes(512 * 1024),
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    disk.full = true;
    try {
      await expect(
        buildSnapshot({
          kind: "backup",
          settings: resolveBackupSettings({
            includePalace: false,
            includeSessions: false,
          }),
          home,
          copyDatabase: (dest) => writeFileSync(dest, "SQLite format 3\0"),
        }),
      ).rejects.toThrow(/ENOSPC/);
      // Unhandled rejections are reported on a later turn of the loop.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(readdirSync(join(home, "backups"))).toEqual([]);
  });
});
