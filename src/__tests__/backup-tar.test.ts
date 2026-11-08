/**
 * tar round-trip — the format guarantee a snapshot rests on.
 *
 * Covers the three things ustar cannot express on its own (long paths,
 * long symlink targets, and a payload that is not block-aligned), plus
 * the hostile-archive cases extraction must refuse. The GNU-tar case is
 * the interop proof: a snapshot has to be recoverable with `tar --zstd
 * -xf` on a machine with no Talon on it.
 */

import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import {
  TarWriter,
  extractTar,
  resolveMemberPath,
} from "../core/backup/archive/tar.js";
import { binaryOnPath } from "../util/binary-on-path.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `talon-${prefix}-`));
}

/** Collect a writer's output by draining a PassThrough into memory. */
async function pack(build: (w: TarWriter) => Promise<void>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new (await import("node:stream")).PassThrough();
  sink.on("data", (c: Buffer) => chunks.push(c));
  const writer = new TarWriter(sink);
  await build(writer);
  await writer.finalize();
  sink.end();
  await new Promise((r) => sink.on("end", r));
  return Buffer.concat(chunks);
}

/**
 * Windows has no symlink privilege for an unelevated process, so symlink
 * members are written and asserted only where they can exist. Archive
 * paths themselves are always POSIX — that is the format, not the
 * platform — so those assertions run everywhere.
 */
const POSIX = process.platform !== "win32";

const LONG_NAME =
  "deeply/" + "n".repeat(90) + "/" + "m".repeat(90) + "/file.txt";

describe("tar round-trip", () => {
  it("restores files, directories, symlinks and long paths byte for byte", async () => {
    const src = tmp("tar-src");
    mkdirSync(join(src, "sub"), { recursive: true });
    writeFileSync(join(src, "sub", "a.txt"), "hello\n");
    // 300 KB of non-block-aligned payload — exercises the padding path.
    const big = Buffer.alloc(300 * 1024 + 7, 0x41);
    writeFileSync(join(src, "big.bin"), big);
    writeFileSync(join(src, "empty"), "");

    const archive = await pack(async (w) => {
      await w.addDirectory("sub", 0o755, 1700000000);
      await w.addFile(
        "sub/a.txt",
        join(src, "sub", "a.txt"),
        0o600,
        1700000000,
        6,
      );
      await w.addFile(
        "big.bin",
        join(src, "big.bin"),
        0o644,
        1700000000,
        big.length,
      );
      await w.addFile("empty", join(src, "empty"), 0o644, 1700000000, 0);
      if (POSIX) await w.addSymlink("link", "sub/a.txt", 0o777, 1700000000);
      await w.addBuffer(LONG_NAME, Buffer.from("long path payload"));
      if (POSIX) {
        await w.addSymlink(
          "longlink",
          "sub/" + "z".repeat(120),
          0o777,
          1700000000,
        );
      }
    });

    const dest = tmp("tar-dest");
    const entries = await extractTar(Readable.from([archive]), dest);
    expect(entries.map((e) => e.path)).toContain(LONG_NAME);

    expect(readFileSync(join(dest, "sub", "a.txt"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(dest, "big.bin")).equals(big)).toBe(true);
    expect(readFileSync(join(dest, "empty"), "utf8")).toBe("");
    expect(readFileSync(join(dest, LONG_NAME), "utf8")).toBe(
      "long path payload",
    );
    if (POSIX) {
      expect(lstatSync(join(dest, "link")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(dest, "link"))).toBe("sub/a.txt");
      expect(readlinkSync(join(dest, "longlink"))).toBe(
        "sub/" + "z".repeat(120),
      );
      expect(lstatSync(join(dest, "sub", "a.txt")).mode & 0o777).toBe(0o600);
    }
  });

  it("writes an archive GNU tar can list", async () => {
    if (!binaryOnPath("tar")) return;
    const src = tmp("tar-gnu");
    writeFileSync(join(src, "a.txt"), "x".repeat(1000));
    const archive = await pack(async (w) => {
      await w.addFile("a.txt", join(src, "a.txt"), 0o644, 1700000000, 1000);
      await w.addBuffer(LONG_NAME, Buffer.from("payload"));
    });
    const file = join(src, "out.tar");
    writeFileSync(file, archive);
    const listing = execFileSync("tar", ["-tf", file], { encoding: "utf8" });
    expect(listing).toContain("a.txt");
    expect(listing).toContain(LONG_NAME);
    // And it extracts with the real implementation, not just ours.
    const dest = tmp("tar-gnu-out");
    execFileSync("tar", ["-xf", file, "-C", dest]);
    expect(readFileSync(join(dest, LONG_NAME), "utf8")).toBe("payload");
  });
});

describe("tar writer", () => {
  it("writes nothing for a source that vanished since it was listed", async () => {
    const src = tmp("tar-vanish");
    writeFileSync(join(src, "kept.txt"), "kept");
    const archive = await pack(async (w) => {
      await expect(
        w.addFile("gone.txt", join(src, "gone.txt"), 0o644, 1700000000, 5),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await w.addFile("kept.txt", join(src, "kept.txt"), 0o644, 1700000000, 4);
    });
    const dest = tmp("tar-vanish-out");
    const entries = await extractTar(Readable.from([archive]), dest);
    expect(entries.map((e) => e.path)).toEqual(["kept.txt"]);
    expect(readFileSync(join(dest, "kept.txt"), "utf8")).toBe("kept");
  });
});

describe("tar extraction refuses to escape its destination", () => {
  it("rejects traversal, absolute paths and escaping symlinks", async () => {
    const dest = tmp("tar-evil");
    expect(() => resolveMemberPath(dest, "../evil")).toThrow(/traversal/i);
    expect(() => resolveMemberPath(dest, "a/../../evil")).toThrow(/traversal/i);
    expect(() => resolveMemberPath(dest, "/etc/passwd")).toThrow(/unsafe/i);
    expect(() => resolveMemberPath(dest, "..\\evil")).toThrow(/unsafe/i);

    const traversal = await pack((w) =>
      w.addBuffer("../escaped.txt", Buffer.from("pwn")),
    );
    await expect(extractTar(Readable.from([traversal]), dest)).rejects.toThrow(
      /traversal/i,
    );
    expect(existsSync(join(dest, "..", "escaped.txt"))).toBe(false);

    const escaping = await pack((w) =>
      w.addSymlink("out", "../../etc", 0o777, 0),
    );
    await expect(
      extractTar(Readable.from([escaping]), tmp("tar-evil2")),
    ).rejects.toThrow(/escapes/i);

    const absolute = await pack((w) =>
      w.addSymlink("out", "/etc/passwd", 0o777, 0),
    );
    await expect(
      extractTar(Readable.from([absolute]), tmp("tar-evil3")),
    ).rejects.toThrow(/absolute/i);
  });

  it("rejects a corrupt header instead of guessing", async () => {
    const good = await pack((w) => w.addBuffer("a.txt", Buffer.from("hi")));
    const corrupt = Buffer.from(good);
    corrupt[10] = 0x41; // flip a byte inside the name field
    await expect(
      extractTar(Readable.from([corrupt]), tmp("tar-corrupt")),
    ).rejects.toThrow(/checksum/i);
  });
});
