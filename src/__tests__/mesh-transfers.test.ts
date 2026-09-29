/**
 * Streamed-transfer tokens — giving up on a pull must end its HTTP leg.
 *
 * pullViaStream cancels the token when the upload_file command fails or
 * times out. An upload already streaming at that point used to keep going:
 * a peer stalled mid-body held the request and its `.part` file open until
 * the bridge's whole-request deadline, and one that finished late renamed
 * a file into place after the caller had been told the pull failed.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { TransferStore } from "../core/mesh/transfers/transfers.js";

describe("TransferStore.cancel", () => {
  it("aborts an upload stalled mid-body and removes its partial file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "talon-mesh-transfer-"));
    const store = new TransferStore();
    const { token, done } = store.createPull("phone", join(dir, "out.bin"));
    const body = new PassThrough();
    const upload = store.acceptUpload(token, body, "phone");
    body.write(Buffer.alloc(64 * 1024, 1));
    // Some bytes landed in the .part file; the peer then goes silent.
    await new Promise((r) => setTimeout(r, 20));
    expect((await readdir(dir)).some((f) => f.includes(".part-"))).toBe(true);

    store.cancel(token);

    const result = await upload;
    expect(result.ok).toBe(false);
    await expect(done).rejects.toThrow();
    expect(body.destroyed).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  }, 2_000);

  it("never renames a late-finishing upload into place after cancel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "talon-mesh-transfer-"));
    const store = new TransferStore();
    const { token } = store.createPull("phone", join(dir, "out.bin"));
    const body = new PassThrough();
    const upload = store.acceptUpload(token, body, "phone");
    body.write(Buffer.alloc(1024, 1));
    await new Promise((r) => setTimeout(r, 20));

    store.cancel(token);
    body.end(Buffer.alloc(1024, 2));

    expect((await upload).ok).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  }, 2_000);

  it("leaves a completed upload alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "talon-mesh-transfer-"));
    const store = new TransferStore();
    const { token, done } = store.createPull("phone", join(dir, "out.bin"));
    const body = new PassThrough();
    const upload = store.acceptUpload(token, body, "phone");
    body.end(Buffer.alloc(4096, 3));
    expect(await upload).toEqual({ ok: true, bytes: 4096 });
    store.cancel(token);
    expect(await done).toEqual({
      bytes: 4096,
      sha256: createHash("sha256").update(Buffer.alloc(4096, 3)).digest("hex"),
    });
    expect(await readdir(dir)).toEqual(["out.bin"]);
  });
});

describe("TransferStore pull digest", () => {
  it("hashes the body as it streams, across chunks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "talon-mesh-transfer-"));
    const store = new TransferStore();
    const { token, done } = store.createPull("phone", join(dir, "out.bin"));
    const body = new PassThrough();
    const upload = store.acceptUpload(token, body, "phone");
    const parts = [
      Buffer.alloc(70_000, 1),
      Buffer.alloc(3, 2),
      Buffer.from("tail"),
    ];
    for (const p of parts) body.write(p);
    body.end();
    await upload;
    const whole = Buffer.concat(parts);
    expect(await done).toEqual({
      bytes: whole.length,
      sha256: createHash("sha256").update(whole).digest("hex"),
    });
  });
});
