/**
 * Mesh sidecar persistence — a failed write is the caller's error, never a
 * stray process-level rejection or leftover temp file.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJson } from "../core/mesh/persist.js";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  unhandled.length = 0;
});

describe("writePrivateJson", () => {
  it("rejects to its caller only — no unhandled rejection from the write queue", async () => {
    process.on("unhandledRejection", onUnhandled);
    const dir = await mkdtemp(join(tmpdir(), "talon-mesh-persist-"));
    const target = join(dir, "sidecar.json");
    await mkdir(target); // rename onto a directory fails
    await expect(writePrivateJson(target, [1])).rejects.toThrow();
    // Let the rejection-tracking tick run.
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
  });

  it("keeps serving a path's write queue after one of its writes failed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "talon-mesh-persist-"));
    const target = join(dir, "sidecar.json");
    await mkdir(target);
    await expect(writePrivateJson(target, ["a"])).rejects.toThrow();
    await rmdir(target);
    await writePrivateJson(target, ["b"]);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(["b"]);
  });

  it("removes its temp file when the write fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "talon-mesh-persist-"));
    const target = join(dir, "sidecar.json");
    await mkdir(target);
    await expect(writePrivateJson(target, [1])).rejects.toThrow();
    await expect(writePrivateJson(target, [2])).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["sidecar.json"]);
  });
});
