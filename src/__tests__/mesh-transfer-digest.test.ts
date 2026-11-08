/**
 * Streamed transfers carry a SHA-256 of the payload (#1042 comment 3 §4).
 *
 * Push: the daemon sends the source's digest with download_file; the device
 * verifies before renaming its temp file and reports what it wrote, and the
 * daemon checks that report. Pull: the device reports the digest of what it
 * sent and the daemon compares it with what arrived, discarding a mismatch.
 * Both are additive: a device that reports no digest (an older build) is
 * trusted as before.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  DeviceFiles,
  type DeviceFilesHost,
} from "../core/mesh/transfers/device-files.js";
import type { DeviceInfo } from "../core/mesh/types.js";

const device: DeviceInfo = {
  id: "phone",
  name: "Pixel 9",
  platform: "android",
  appVersion: "1.0.0",
  capabilities: ["download_file", "upload_file"],
} as DeviceInfo;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** What the emulated device reports as sha256: the true digest, a wrong
 *  one, or nothing at all (a build that predates transfer digests). */
type Report = "true" | "wrong" | "none";

/** A DeviceFiles whose device really moves the bytes over the transfer
 *  store, then answers with the configured digest report. */
function deviceFiles(report: Report, pullPayload = Buffer.alloc(0)) {
  const sent: { name: string; params: Record<string, unknown> }[] = [];
  const digest = (real: string) =>
    report === "true"
      ? { sha256: real }
      : report === "wrong"
        ? { sha256: "0".repeat(64) }
        : {};
  let files!: DeviceFiles;
  const host: DeviceFilesHost = {
    load: async () => {},
    resolveDevice: () => ({ target: device }),
    dispatchCommand: async (_query, name, params) => {
      sent.push({ name, params });
      const token = String(params.token);
      let data: Record<string, unknown>;
      if (name === "download_file") {
        const src = await files.openFileDownload(token, device.id);
        const body = await readFile(src!.path);
        data = { bytesWritten: body.length, ...digest(sha(body)) };
      } else {
        const up = await files.acceptFileUpload(
          token,
          Readable.from([pullPayload]),
          device.id,
        );
        if (!up.ok) throw new Error(up.error);
        data = { bytes: up.bytes, ...digest(sha(pullPayload)) };
      }
      return {
        target: device,
        result: { commandId: "c1", deviceId: device.id, ok: true, data },
      };
    },
    commandTimeoutMs: 30_000,
    resolveNode: (async () => {
      throw new Error("not used");
    }) as unknown as DeviceFilesHost["resolveNode"],
  };
  files = new DeviceFiles(host);
  return { files, sent };
}

async function sourceFile(payload: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "talon-xfer-digest-"));
  const src = join(dir, "src.bin");
  await writeFile(src, payload);
  return src;
}

describe("streamed push digest", () => {
  const payload = Buffer.alloc(300 * 1024, 5);

  it("sends the source's sha256 with download_file", async () => {
    const { files, sent } = deviceFiles("true");
    const res = await files.pushFileToDevice(
      "phone",
      await sourceFile(payload),
      "/sdcard/a.bin",
    );
    expect(res.ok).toBe(true);
    const cmd = sent.find((c) => c.name === "download_file");
    expect(cmd?.params).toMatchObject({
      path: "/sdcard/a.bin",
      sha256: sha(payload),
    });
  });

  it("fails when the device reports a different digest", async () => {
    const { files } = deviceFiles("wrong");
    const res = await files.pushFileToDevice(
      "phone",
      await sourceFile(payload),
      "/sdcard/a.bin",
    );
    expect(res.ok).toBe(false);
    expect(res.text).toContain("Integrity check failed");
  });

  it("skips the check for a device that reports no digest", async () => {
    const { files } = deviceFiles("none");
    const res = await files.pushFileToDevice(
      "phone",
      await sourceFile(payload),
      "/sdcard/a.bin",
    );
    expect(res.ok).toBe(true);
  });
});

describe("streamed pull digest", () => {
  const payload = Buffer.from("pulled bytes ".repeat(5000));

  async function pull(report: Report) {
    const { files, sent } = deviceFiles(report, payload);
    const dir = await mkdtemp(join(tmpdir(), "talon-xfer-digest-"));
    const dest = join(dir, "pulled.bin");
    const res = await files.pullFileFromDevice("phone", "/sdcard/p.bin", dest);
    return { res, dest, sent };
  }

  it("accepts a pull whose reported digest matches what arrived", async () => {
    const { res, dest, sent } = await pull("true");
    expect(res.ok).toBe(true);
    expect((await readFile(dest)).equals(payload)).toBe(true);
    // The pull command itself is unchanged: the device computes the digest.
    expect(Object.keys(sent[0].params).sort()).toEqual(["path", "token"]);
  });

  it("discards a pull whose reported digest does not match", async () => {
    const { res, dest } = await pull("wrong");
    expect(res.ok).toBe(false);
    expect(res.text).toContain("Integrity check failed");
    await expect(access(dest)).rejects.toThrow();
  });

  it("keeps a pull from a device that reports no digest", async () => {
    const { res, dest } = await pull("none");
    expect(res.ok).toBe(true);
    expect((await readFile(dest)).equals(payload)).toBe(true);
  });
});
