/**
 * Core mesh service — the daemon-wide device mesh the model reaches from
 * every frontend:
 *   - tool composition: mesh tools are NOT frontend-restricted
 *   - shared gateway actions: list_devices / get_device_location resolve
 *     without any frontend handler
 *   - locate flow: dispatcher fan-out, fresh-fix wait, last-known fallback,
 *     and the no-transport fast path
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtemp,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MeshRegistry,
  MeshService,
  getMeshService,
  setMeshService,
} from "../core/mesh/index.js";
import { meshHandlers } from "../core/engine/gateway-actions/mesh.js";
import { composeTools } from "../core/tools/index.js";

async function tempService(
  options?: ConstructorParameters<typeof MeshService>[1],
): Promise<MeshService> {
  const dir = await mkdtemp(join(tmpdir(), "talon-mesh-service-"));
  const registry = new MeshRegistry({
    devices: join(dir, "devices.json"),
    locations: join(dir, "locations.json"),
    history: join(dir, "history.json"),
  });
  return new MeshService(registry, options);
}

async function registerPhone(service: MeshService): Promise<void> {
  await service.register({
    id: "phone",
    name: "Pixel 9",
    platform: "android",
    appVersion: "1.0.0",
    battery: 77,
  });
}

afterEach(() => setMeshService(null));

describe("mesh tool availability", () => {
  it.each(["telegram", "discord", "teams", "terminal", "native"] as const)(
    "exposes every mesh tool on the %s frontend",
    (frontend) => {
      const names = composeTools({ frontend }).map((t) => t.name);
      for (const tool of [
        "list_devices",
        "get_device_location",
        "get_device_history",
        "ring_device",
        "get_device_status",
        "device_exec",
        "device_list_dir",
        "device_read_file",
        "device_write_file",
        "device_pull_file",
        "device_push_file",
        "update_device",
        "update_node",
        "get_node_binary",
        "make_node_install_link",
        "remove_device",
      ]) {
        expect(names).toContain(tool);
      }
    },
  );
});

describe("mesh shared gateway actions", () => {
  it("serves list_devices and get_device_location through the shared registry", async () => {
    const service = await tempService({
      freshFixTimeoutMs: 50,
      pollIntervalMs: 10,
    });
    setMeshService(service);
    await registerPhone(service);
    await service.storeLocation({
      deviceId: "phone",
      lat: 53.1,
      lon: -6.2,
      ts: Date.now(),
    });

    const list = await meshHandlers.list_devices(
      { action: "list_devices" },
      1,
      undefined,
      "1",
    );
    expect(list.ok).toBe(true);
    expect(list.text).toContain("Pixel 9");
    expect(list.text).toContain("[id: phone]");
    expect(list.text).toContain("53.100000,-6.200000");

    const loc = await meshHandlers.get_device_location(
      { action: "get_device_location", device: "pixel" },
      1,
      undefined,
      "1",
    );
    expect(loc.ok).toBe(true);
    expect(loc.text).toContain("Pixel 9 is at 53.100000, -6.200000");
  });

  it("getMeshService returns a stable singleton until reset", () => {
    const a = getMeshService();
    expect(getMeshService()).toBe(a);
    setMeshService(null);
    expect(getMeshService()).not.toBe(a);
  });
});

describe("MeshService locate flow", () => {
  it("answers from last-known immediately when no transport is attached", async () => {
    const service = await tempService({ freshFixTimeoutMs: 5_000 });
    await registerPhone(service);
    await service.storeLocation({
      deviceId: "phone",
      lat: 1,
      lon: 2,
      ts: Date.now() - 60_000,
    });

    const started = Date.now();
    const result = await service.locateDevice();
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Pixel 9 is at 1.000000, 2.000000");
    // No dispatcher — must not wait out the 5s fresh-fix window.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("dispatches a targeted locate and resolves on the fresh fix", async () => {
    const service = await tempService({
      freshFixTimeoutMs: 2_000,
      pollIntervalMs: 25,
    });
    await registerPhone(service);
    const locates: Array<string | undefined> = [];
    service.registerTransport({
      locate: (deviceId) => {
        locates.push(deviceId);
        // Simulate the companion answering the locate with a fresh fix.
        void service.storeLocation({
          deviceId: "phone",
          lat: 53.5,
          lon: -6.5,
          ts: Date.now(),
        });
      },
      command: () => {},
    });

    const result = await service.locateDevice("phone");
    expect(locates).toEqual(["phone"]);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("53.500000, -6.500000");
  });

  it("falls back to last-known when no fresh fix arrives in time", async () => {
    const service = await tempService({
      freshFixTimeoutMs: 60,
      pollIntervalMs: 20,
    });
    await registerPhone(service);
    await service.storeLocation({
      deviceId: "phone",
      lat: 9,
      lon: 8,
      ts: Date.now() - 120_000,
    });
    service.registerTransport({
      locate: () => {
        /* transport attached, but the device never answers */
      },
      command: () => {},
    });

    const result = await service.locateDevice("phone");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("9.000000, 8.000000");
  });

  it("survives a throwing dispatcher and honours unsubscribe", async () => {
    const service = await tempService({
      freshFixTimeoutMs: 40,
      pollIntervalMs: 10,
    });
    await registerPhone(service);
    const seen: Array<string | undefined> = [];
    service.registerTransport({
      locate: () => {
        throw new Error("broken transport");
      },
      command: () => {},
    });
    const unsubscribe = service.registerTransport({
      locate: (id) => seen.push(id),
      command: () => {},
    });

    expect(service.requestLocate("phone")).toBe(true);
    expect(seen).toEqual(["phone"]);

    unsubscribe(); // one dispatcher (the broken one) still attached
    expect(service.requestLocate("phone")).toBe(true);
    expect(seen).toEqual(["phone"]);
  });

  it("lists known devices when the query matches nothing, and reports the empty mesh", async () => {
    const service = await tempService({ freshFixTimeoutMs: 40 });
    const empty = await service.locateDevice("phone");
    expect(empty).toMatchObject({
      ok: false,
      text: "No mesh devices are registered.",
    });

    await registerPhone(service);
    const miss = await service.locateDevice("watch");
    expect(miss.ok).toBe(false);
    expect(miss.text).toContain('No mesh device matches "watch"');
    expect(miss.text).toContain("Pixel 9");
  });

  it("builds a movement + battery history from stored fixes", async () => {
    const service = await tempService();
    await registerPhone(service);
    const now = Date.now();
    // A morning of fixes: home -> across town, battery draining.
    const fixes = [
      { lat: 53.3, lon: -6.25, batteryPct: 90, ts: now - 3 * 3_600_000 },
      { lat: 53.31, lon: -6.24, batteryPct: 84, ts: now - 2 * 3_600_000 },
      { lat: 53.32, lon: -6.23, batteryPct: 79, ts: now - 1 * 3_600_000 },
      { lat: 53.33, lon: -6.22, batteryPct: 71, ts: now - 10 * 60_000 },
    ];
    for (const f of fixes) {
      await service.storeLocation({ deviceId: "phone", ...f });
    }

    const result = await service.deviceHistory("phone", 6);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("4 fixes in the last 6h");
    expect(result.text).toContain("battery 90% → 71%");
    expect(result.text).toMatch(/moved ~\d/);
    expect(result.text).toContain("53.33000,-6.22000");

    // Window filtering: only the recent fix lands in a 1h window.
    const short = await service.deviceHistory("phone", 1);
    expect(short.text).toContain("1 fix in the last 1h");

    // Empty window is a clean answer, not an error.
    const other = await service.register({
      id: "tab",
      name: "Tablet",
      platform: "android",
      appVersion: "1.0.0",
    });
    expect(other.id).toBe("tab");
    const empty = await service.deviceHistory("tablet", 24);
    expect(empty.ok).toBe(true);
    expect(empty.text).toContain("No location reports");

    // Shared action path + history survives a reload from disk.
    setMeshService(service);
    const viaAction = await meshHandlers.get_device_history(
      { action: "get_device_history", device: "phone", hours: 6 },
      1,
      undefined,
      "1",
    );
    expect(viaAction.text).toContain("4 fixes");
  });

  it("prefers mobile devices as the default target", async () => {
    const service = await tempService();
    await service.register({
      id: "mac",
      name: "MacBook",
      platform: "macos",
      appVersion: "1.0.0",
    });
    await registerPhone(service);
    expect(service.chooseDevice()?.id).toBe("phone");
    expect(service.chooseDevice("mac")?.id).toBe("mac");
    expect(service.chooseDevice("macbook")?.id).toBe("mac");
  });

  it("dispatches a command and resolves on the device's answer", async () => {
    const service = await tempService({ commandTimeoutMs: 2_000 });
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["locate", "ring", "status"],
    });
    const sent: Array<{ name: string; params: Record<string, unknown> }> = [];
    service.registerTransport({
      locate: () => {},
      command: (cmd) => {
        sent.push({ name: cmd.name, params: cmd.params });
        // Simulate the companion answering over POST /devices/command-result.
        queueMicrotask(() =>
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
            ...(cmd.name === "status"
              ? { data: { battery: "77%", network: "wifi" } }
              : {}),
          }),
        );
      },
    });

    const ring = await service.ringDevice("phone", "where are you");
    expect(ring.ok).toBe(true);
    expect(ring.text).toContain("Pixel 9 is ringing");
    expect(sent[0]).toEqual({
      name: "ring",
      params: { message: "where are you" },
    });

    const status = await service.getDeviceStatus("phone");
    expect(status.ok).toBe(true);
    expect(status.text).toContain("battery: 77%");
    expect(status.text).toContain("network: wifi");
  });

  it("times out a command the device never answers", async () => {
    const service = await tempService({ commandTimeoutMs: 60 });
    await registerPhone(service);
    service.registerTransport({ locate: () => {}, command: () => {} });
    const result = await service.ringDevice("phone");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("did not answer");
  });

  it("refuses commands a device declares it cannot run", async () => {
    const service = await tempService({ commandTimeoutMs: 60 });
    await service.register({
      id: "mac",
      name: "MacBook",
      platform: "macos",
      appVersion: "1.0.0",
      capabilities: ["locate", "status"],
    });
    service.registerTransport({ locate: () => {}, command: () => {} });
    const result = await service.ringDevice("mac");
    expect(result.ok).toBe(false);
    expect(result.text).toContain('does not support "ring"');
    expect(result.text).toContain("locate, status");
  });

  it("fails fast with no transport and ignores stale results", async () => {
    const service = await tempService({ commandTimeoutMs: 60 });
    await registerPhone(service);

    const noTransport = await service.ringDevice("phone");
    expect(noTransport.ok).toBe(false);
    expect(noTransport.text).toContain("No companion transport is connected");

    // A result for an unknown/expired correlation id is ignored, not fatal.
    expect(
      service.completeCommand({
        commandId: "nope",
        deviceId: "phone",
        ok: true,
      }),
    ).toBe(false);
  });

  it("routes command tools through the shared gateway actions", async () => {
    const service = await tempService({ commandTimeoutMs: 2_000 });
    setMeshService(service);
    await service.register({
      id: "mac",
      name: "MacBook",
      platform: "macos",
      appVersion: "1.0.0",
      capabilities: ["ring", "status"],
    });
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() =>
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
            ...(cmd.name === "status"
              ? { data: { battery: "93%", os: "macOS 15" } }
              : {}),
          }),
        ),
    });

    const ring = await meshHandlers.ring_device(
      { action: "ring_device", device: "mac" },
      1,
      undefined,
      "1",
    );
    expect(ring.ok).toBe(true);
    expect(ring.text).toContain("MacBook is ringing");

    const status = await meshHandlers.get_device_status(
      { action: "get_device_status", device: "mac" },
      1,
      undefined,
      "1",
    );
    expect(status.ok).toBe(true);
    expect(status.text).toContain("battery: 93%");
    expect(status.text).toContain("os: macOS 15");
  });
});

describe("MeshService presence + clock-skew hardening", () => {
  it("treats a fix that arrives after the request as fresh, whatever the device clock says", async () => {
    const service = await tempService({
      freshFixTimeoutMs: 2_000,
      pollIntervalMs: 25,
    });
    await registerPhone(service);
    service.registerTransport({
      locate: () => {
        // Device clock runs ~1h behind: the fix's `ts` is in the past, yet it
        // physically arrives now (after the locate request). The old code
        // compared loc.ts >= requestedAt and would reject this as stale,
        // burning the full timeout; server-receipt time gets it right.
        void service.storeLocation({
          deviceId: "phone",
          lat: 53.5,
          lon: -6.5,
          ts: Date.now() - 3_600_000,
        });
      },
      command: () => {},
    });

    const started = Date.now();
    const res = await service.locateDevice("phone");
    expect(res.ok).toBe(true);
    expect(res.text).toContain("53.500000, -6.500000");
    // Resolved on arrival — not timed out.
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("gives up on a command when the device drops mid-flight", async () => {
    // The pre-flight offline check only sees presence as it was BEFORE
    // dispatch. A device that is online when the command goes out and dies a
    // second later (ignition off, hotspot gone) leaves the promise waiting on
    // a reply that can never come — for the whole budget, which on a file
    // transfer is minutes, with every later message in that chat queued
    // behind it. Presence has to be re-checked while the wait is in flight.
    const service = await tempService({
      commandTimeoutMs: 60_000,
      presenceWatchIntervalMs: 25,
    });
    await registerPhone(service);
    service.registerTransport({
      locate: () => {},
      command: () => {
        // Accepted, then the device goes dark: lastSeen falls outside the
        // presence window and no result is ever posted back.
        void service.register(
          {
            id: "phone",
            name: "Pixel 9",
            platform: "android",
            appVersion: "1.0.0",
            capabilities: ["ring"],
          },
          Date.now() - 200_000,
        );
      },
    });

    const started = Date.now();
    const res = await service.ringDevice("phone");
    expect(res.ok).toBe(false);
    expect(res.text).toContain("went offline");
    // Without the watchdog this sits for the full 60s budget.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not wait out the fresh-fix window for an offline device", async () => {
    const service = await tempService({
      freshFixTimeoutMs: 5_000,
      pollIntervalMs: 50,
    });
    // lastSeen far past the 180s presence window → offline.
    await service.register(
      {
        id: "phone",
        name: "Pixel 9",
        platform: "android",
        appVersion: "1.0.0",
      },
      Date.now() - 200_000,
    );
    service.registerTransport({ locate: () => {}, command: () => {} });

    const started = Date.now();
    const res = await service.locateDevice("phone");
    expect(res.ok).toBe(false);
    expect(res.text).toContain("appears offline");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("short-circuits a command to an offline device instead of timing out", async () => {
    const service = await tempService({ commandTimeoutMs: 5_000 });
    await service.register(
      {
        id: "phone",
        name: "Pixel 9",
        platform: "android",
        appVersion: "1.0.0",
        capabilities: ["ring"],
      },
      Date.now() - 200_000,
    );
    service.registerTransport({ locate: () => {}, command: () => {} });

    const started = Date.now();
    const res = await service.ringDevice("phone");
    expect(res.ok).toBe(false);
    expect(res.text).toContain("appears offline");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("persists concurrent location reports without corrupting the sidecar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "talon-mesh-atomic-"));
    const files = {
      devices: join(dir, "devices.json"),
      locations: join(dir, "locations.json"),
      history: join(dir, "history.json"),
    };
    const service = new MeshService(new MeshRegistry(files));
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
    });
    // Fire many reports at once — atomic tmp+rename + the per-path write queue
    // must leave every sidecar as valid JSON.
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        service.storeLocation({
          deviceId: "phone",
          lat: 53 + i * 0.0001,
          lon: -6,
          ts: Date.now() + i,
        }),
      ),
    );

    const reloaded = new MeshRegistry(files);
    await reloaded.load();
    expect(reloaded.getLocation("phone")).toBeTruthy();
    expect(reloaded.getHistory("phone").length).toBeGreaterThan(0);
  });
});

describe("MeshService exec + filesystem channel", () => {
  it("runs a shell command and formats exit code + stdout/stderr", async () => {
    const service = await tempService({ commandTimeoutMs: 2_000 });
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["exec"],
    });
    const seen: Array<Record<string, unknown>> = [];
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() => {
          seen.push(cmd.params);
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
            data: {
              stdout: "hello world\n",
              stderr: "",
              exitCode: 0,
              via: "shizuku",
            },
          });
        }),
    });

    const res = await service.execOnDevice(
      "phone",
      "echo hello world",
      "/sdcard",
    );
    expect(res.ok).toBe(true);
    expect(res.text).toContain("[Pixel 9 via shizuku] exit 0");
    expect(res.text).toContain("hello world");
    expect(seen[0]).toMatchObject({ cmd: "echo hello world", cwd: "/sdcard" });
  });

  it("reassembles a chunked file read off the device", async () => {
    const service = await tempService();
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["read_file"],
    });
    const content = "A".repeat(600 * 1024); // spans 3 × 256KB chunks
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() => {
          const offset = Number(cmd.params.offset) || 0;
          const len = Number(cmd.params.len) || 0;
          const slice = Buffer.from(content).subarray(offset, offset + len);
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
            data: {
              base64: slice.toString("base64"),
              eof: offset + slice.length >= content.length,
            },
          });
        }),
    });

    const res = await service.readFileFromDevice("phone", "/sdcard/big.txt");
    expect(res.ok).toBe(true);
    expect(res.text).toContain("600.0 KB");
    expect(res.text).toContain("AAAA");
  });

  it("writes a file to the device in truncate-then-append chunks", async () => {
    const service = await tempService();
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["write_file"],
    });
    const chunks: Array<{ offset: number; len: number; truncate: boolean }> =
      [];
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() => {
          const buf = Buffer.from(String(cmd.params.base64), "base64");
          chunks.push({
            offset: Number(cmd.params.offset),
            len: buf.length,
            truncate: cmd.params.truncate === true,
          });
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
            data: { bytesWritten: buf.length },
          });
        }),
    });

    const res = await service.writeFileToDevice(
      "phone",
      "/sdcard/out.txt",
      "Z".repeat(1200 * 1024),
    );
    expect(res.ok).toBe(true);
    expect(chunks.length).toBe(2); // 1MB + 176KB
    expect(chunks[0].truncate).toBe(true);
    expect(chunks[1].truncate).toBe(false);
    expect(chunks[0].offset).toBe(0);
    expect(chunks[1].offset).toBe(1024 * 1024);
  });

  it("pulls a file via the streamed path (one command, one HTTP body)", async () => {
    const service = await tempService();
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["upload_file"],
    });
    const payload = Buffer.alloc(2 * 1024 * 1024, 3);
    let commands = 0;
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(async () => {
          commands += 1;
          expect(cmd.name).toBe("upload_file");
          // Emulate the device: stream the body up, THEN answer the command.
          const up = await service.acceptFileUpload(
            String(cmd.params.token),
            Readable.from(payload),
          );
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: up.ok,
            data: up.ok ? { bytes: up.bytes } : {},
          });
        }),
    });

    const dir = await mkdtemp(join(tmpdir(), "talon-stream-pull-"));
    const dest = join(dir, "pulled.bin");
    const res = await service.pullFileFromDevice(
      "phone",
      "/sdcard/big.bin",
      dest,
    );
    expect(res.ok).toBe(true);
    expect(res.text).toContain("streamed");
    expect(commands).toBe(1); // the whole 2MB moved in ONE command round trip
    expect((await fsReadFile(dest)).equals(payload)).toBe(true);
  });

  it("pushes a file via the streamed path without buffering it in memory", async () => {
    const service = await tempService();
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["download_file"],
    });
    const dir = await mkdtemp(join(tmpdir(), "talon-stream-push-"));
    const src = join(dir, "src.bin");
    const payload = Buffer.alloc(1536 * 1024, 9);
    await fsWriteFile(src, payload);

    let downloaded: Buffer | undefined;
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(async () => {
          expect(cmd.name).toBe("download_file");
          const file = await service.openFileDownload(String(cmd.params.token));
          expect(file).not.toBeNull();
          downloaded = await fsReadFile(file!.path);
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
            data: { bytesWritten: downloaded.length },
          });
        }),
    });

    const res = await service.pushFileToDevice("phone", src, "/sdcard/in.bin");
    expect(res.ok).toBe(true);
    expect(res.text).toContain("streamed");
    expect(downloaded?.equals(payload)).toBe(true);
  });

  it("update_device pushes the APK then installs it with a matching digest", async () => {
    const service = await tempService();
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["download_file", "install_apk"],
    });
    const dir = await mkdtemp(join(tmpdir(), "talon-update-"));
    const apk = join(dir, "app.apk");
    const payload = Buffer.alloc(400 * 1024, 7);
    await fsWriteFile(apk, payload);
    const { createHash } = await import("node:crypto");
    const expectedSha = createHash("sha256").update(payload).digest("hex");

    let installParams: Record<string, unknown> | undefined;
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(async () => {
          if (cmd.name === "download_file") {
            const file = await service.openFileDownload(
              String(cmd.params.token),
            );
            const bytes = await fsReadFile(file!.path);
            service.completeCommand({
              commandId: cmd.id,
              deviceId: cmd.deviceId,
              ok: true,
              data: { bytesWritten: bytes.length },
            });
          } else if (cmd.name === "install_apk") {
            installParams = cmd.params;
            service.completeCommand({
              commandId: cmd.id,
              deviceId: cmd.deviceId,
              ok: true,
              message: "Update staged.",
              data: { staged: true },
            });
          }
        }),
    });

    const res = await service.updateDeviceApp("phone", apk);
    expect(res.ok).toBe(true);
    // The digest computed here must be exactly what the device is asked to
    // verify — that's the anti-truncation guarantee.
    expect(installParams?.sha256).toBe(expectedSha);
    expect(installParams?.path).toBe(
      "/sdcard/Download/talon-companion-update.apk",
    );
    expect(res.text).toContain("staged the update");
  });

  it("update_device refuses a device without the install_apk capability", async () => {
    const service = await tempService();
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["download_file"], // no install_apk
    });
    const dir = await mkdtemp(join(tmpdir(), "talon-update-nocap-"));
    const apk = join(dir, "app.apk");
    await fsWriteFile(apk, Buffer.alloc(1024, 1));

    const res = await service.updateDeviceApp("phone", apk);
    expect(res.ok).toBe(false);
    expect(res.text).toContain("can't self-update");
  });

  it("update_device surfaces a device-side install refusal", async () => {
    const service = await tempService();
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["download_file", "install_apk"],
    });
    const dir = await mkdtemp(join(tmpdir(), "talon-update-refuse-"));
    const apk = join(dir, "app.apk");
    await fsWriteFile(apk, Buffer.alloc(2048, 5));

    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(async () => {
          if (cmd.name === "download_file") {
            const file = await service.openFileDownload(
              String(cmd.params.token),
            );
            const bytes = await fsReadFile(file!.path);
            service.completeCommand({
              commandId: cmd.id,
              deviceId: cmd.deviceId,
              ok: true,
              data: { bytesWritten: bytes.length },
            });
          } else if (cmd.name === "install_apk") {
            service.completeCommand({
              commandId: cmd.id,
              deviceId: cmd.deviceId,
              ok: false,
              message: "Silent install needs Shizuku.",
            });
          }
        }),
    });

    const res = await service.updateDeviceApp("phone", apk);
    expect(res.ok).toBe(false);
    expect(res.text).toContain("Shizuku");
  });

  it("streamed pull fails loudly when the device claims success without uploading", async () => {
    const service = await tempService();
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["upload_file"],
    });
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() => {
          // Lying device: ok without ever streaming the body.
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
          });
        }),
    });
    const dir = await mkdtemp(join(tmpdir(), "talon-stream-liar-"));
    const res = await service.pullFileFromDevice(
      "phone",
      "/sdcard/x.bin",
      join(dir, "x.bin"),
    );
    expect(res.ok).toBe(false);
    expect(res.text).toContain("no upload arrived");
  }, 20_000);

  it("refuses exec to an offline device without waiting", async () => {
    const service = await tempService({ commandTimeoutMs: 5_000 });
    await service.register(
      {
        id: "phone",
        name: "Pixel 9",
        platform: "android",
        appVersion: "1.0.0",
        capabilities: ["exec"],
      },
      Date.now() - 200_000,
    );
    service.registerTransport({ locate: () => {}, command: () => {} });
    const res = await service.execOnDevice("phone", "echo hi");
    expect(res.ok).toBe(false);
    expect(res.text).toContain("appears offline");
  });
});

describe("MeshService hardening", () => {
  /** Transport that answers read_file with device-capped chunks. */
  function chunkedReader(
    service: MeshService,
    content: string,
    deviceCap: number,
  ): void {
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() => {
          const offset = Number(cmd.params.offset) || 0;
          const want = Math.min(Number(cmd.params.len) || 0, deviceCap);
          const slice = Buffer.from(content).subarray(offset, offset + want);
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
            data: {
              base64: slice.toString("base64"),
              eof: offset + slice.length >= content.length,
            },
          });
        }),
    });
  }

  it("reassembles a read whose device caps chunks below the requested size", async () => {
    // The companion serves at most 256KB per read_file no matter what the
    // daemon asks for. A short chunk mid-file must NOT be treated as EOF —
    // that silently truncated every chunked read past the device's cap.
    const service = await tempService();
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["read_file"],
    });
    const content = "B".repeat(600 * 1024);
    chunkedReader(service, content, 256 * 1024);

    const res = await service.readFileBytes("phone", "/sdcard/big.txt");
    expect("data" in res && res.data.length).toBe(content.length);
  });

  it("fails a stalled read (empty chunk without eof) instead of looping", async () => {
    const service = await tempService();
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["read_file"],
    });
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() =>
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
            data: { base64: "", eof: false },
          }),
        ),
    });

    const res = await service.readFileBytes("phone", "/sdcard/stuck.txt");
    expect("error" in res && res.error).toContain("stalled");
  });

  it("drops a command result claimed by the wrong device", async () => {
    const service = await tempService();
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["exec"],
    });
    let forgedAccepted: boolean | undefined;
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() => {
          // An imposter answers first — must be ignored, so the command
          // times out instead of resolving with the forged payload.
          forgedAccepted = service.completeCommand({
            commandId: cmd.id,
            deviceId: "other-device",
            ok: true,
            data: { stdout: "forged", exitCode: 0 },
          });
        }),
    });

    const target = service.chooseDevice("phone")!;
    const result = await service.sendCommand(target, "exec", {}, 150);
    expect(forgedAccepted).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("did not answer");
  });

  it("drops a command result that names no device at all", async () => {
    const service = await tempService();
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["exec"],
    });
    let anonymousAccepted: boolean | undefined;
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() => {
          // Omitting deviceId used to SKIP the ownership check entirely, so
          // any client could answer for the target. Unattributable now means
          // unaccepted — the exec times out rather than returning this stdout.
          anonymousAccepted = service.completeCommand({
            commandId: cmd.id,
            ok: true,
            data: { stdout: "forged", exitCode: 0 },
          });
        }),
    });

    const target = service.chooseDevice("phone")!;
    const result = await service.sendCommand(target, "exec", {}, 150);
    expect(anonymousAccepted).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.message).toContain("did not answer");
  });

  it("refuses a transfer token redeemed under another device's name", async () => {
    const service = await tempService();
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["download_file"],
    });
    const dir = await mkdtemp(join(tmpdir(), "talon-token-bind-"));
    const src = join(dir, "src.bin");
    await fsWriteFile(src, Buffer.alloc(4096, 5));

    let stolen: unknown = "not tried";
    let served: string | undefined;
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(async () => {
          const token = String(cmd.params.token);
          // Another mesh member that got hold of the token cannot redeem it…
          stolen = await service.openFileDownload(token, "laptop");
          // …and the attempt must not burn it for the rightful device.
          const file = await service.openFileDownload(token, "phone");
          served = file?.path;
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: file !== null,
            data: { bytesWritten: file?.size ?? 0 },
          });
        }),
    });

    const res = await service.pushFileToDevice("phone", src, "/sdcard/in.bin");
    expect(stolen).toBeNull();
    expect(served).toBe(src);
    expect(res.ok).toBe(true);
  });

  it("refuses an upload streamed under another device's name", async () => {
    const service = await tempService();
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["upload_file"],
    });
    const dir = await mkdtemp(join(tmpdir(), "talon-token-bind-up-"));
    const dest = join(dir, "pulled.bin");
    const payload = Buffer.alloc(2048, 1);

    let stolen: { ok: boolean; error?: string } | undefined;
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(async () => {
          const token = String(cmd.params.token);
          // A peer cannot write the daemon-side destination with its own body…
          stolen = await service.acceptFileUpload(
            token,
            Readable.from(Buffer.alloc(2048, 9)),
            "laptop",
          );
          // …and the real device's upload still lands.
          const up = await service.acceptFileUpload(
            token,
            Readable.from(payload),
            "phone",
          );
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: up.ok,
            data: up.ok ? { bytes: up.bytes } : {},
          });
        }),
    });

    const res = await service.pullFileFromDevice(
      "phone",
      "/sdcard/x.bin",
      dest,
    );
    expect(stolen?.ok).toBe(false);
    expect(res.ok).toBe(true);
    expect((await fsReadFile(dest)).equals(payload)).toBe(true);
  });

  it("resolves device names separator-insensitively and prefers the online duplicate", async () => {
    const service = await tempService();
    // Stale registration from a reinstall — same phone, old id, offline.
    await service.register(
      {
        id: "phone-old",
        name: "Google Pixel 10",
        platform: "android",
        appVersion: "1.0.0",
      },
      Date.now() - 300_000,
    );
    await service.register({
      id: "phone-new",
      name: "Google Pixel 10",
      platform: "android",
      appVersion: "1.1.0",
    });

    // "Pixel 10" is a fragment of both entries; the online one must win.
    const byFragment = service.resolveDevice("Pixel 10");
    expect("target" in byFragment && byFragment.target.id).toBe("phone-new");
    // Separator/case-insensitive: "pixel10" and "PIXEL-10" also land.
    const folded = service.resolveDevice("pixel10");
    expect("target" in folded && folded.target.id).toBe("phone-new");
  });

  it("errors on an ambiguous fragment when several matches are online", async () => {
    const service = await tempService();
    await service.register({
      id: "a",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
    });
    await service.register({
      id: "b",
      name: "Pixel 9 Pro",
      platform: "android",
      appVersion: "1.0.0",
    });

    const res = service.resolveDevice("pixel");
    expect("error" in res && res.error).toContain("matches 2 devices");
    // Exact name still resolves cleanly.
    const exact = service.resolveDevice("Pixel 9");
    expect("target" in exact && exact.target.id).toBe("a");
  });

  it("resolves devices by id prefix when 6 or more characters match uniquely", async () => {
    const service = await tempService();
    await service.register({
      id: "d011287b-0a24-4a51-bffd-129855b85f39",
      name: "Fedora Linux",
      platform: "linux",
      appVersion: "5.12.0",
    });
    await service.register({
      id: "e98a1234-5678-9abc-def0-123456789abc",
      name: "Fedora Linux",
      platform: "linux",
      appVersion: "5.12.0",
    });

    const res = service.resolveDevice("d01128");
    expect("target" in res && res.target.id).toBe(
      "d011287b-0a24-4a51-bffd-129855b85f39",
    );

    const bothRes = service.resolveDevice("Fedora Linux");
    expect("error" in bothRes && bothRes.error).toContain("matches 2 devices");
    expect("error" in bothRes && bothRes.error).toContain("Use the device id.");
  });

  it("gateway meshHandlers accept deviceId as an alternative to device", async () => {
    const service = await tempService();
    setMeshService(service);
    await service.register({
      id: "device-uuid-123456",
      name: "Workstation",
      platform: "linux",
      appVersion: "5.12.0",
    });

    const res = await meshHandlers.get_device_status(
      { action: "get_device_status", deviceId: "device-uuid-123456" } as any,
      1,
      undefined,
      "1",
    );
    expect(res.ok).toBe(false);
    expect(res.text).toContain("Workstation");
  });

  it("clamps oversized exec output with an explicit truncation marker", async () => {
    const service = await tempService({ commandTimeoutMs: 2_000 });
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["exec"],
    });
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() =>
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
            data: { stdout: "x".repeat(200_000), stderr: "", exitCode: 0 },
          }),
        ),
    });

    const res = await service.execOnDevice("phone", "yes | head -c 200000");
    expect(res.ok).toBe(true);
    expect(res.text).toContain("chars truncated");
    expect(res.text.length).toBeLessThan(40_000);
  });

  it("rejects non-string write content instead of truncating the target", async () => {
    const service = await tempService();
    const res = await service.writeFileToDevice("phone", "/sdcard/a.txt", 42);
    expect(res.ok).toBe(false);
    expect(res.text).toContain("must be a string");
  });
});

describe("MeshService registry hygiene", () => {
  const mac = (id: string): Record<string, unknown> => ({
    id,
    name: "Ada's MacBook Pro",
    platform: "macos",
    appVersion: "1.0.0",
  });

  it("preserves offline same-name devices when another device registers", async () => {
    const service = await tempService();
    await service.storeLocation({
      deviceId: "mac-old",
      lat: 53.1,
      lon: -6.2,
      ts: Date.now() - 10 * 60_000,
    });
    await service.register(mac("mac-old"), Date.now() - 10 * 60_000);
    await service.register(mac("mac-new"));

    const { devices } = await service.list();
    expect(devices.map((d) => d.id).sort()).toEqual(["mac-new", "mac-old"]);
    // Both devices exist independently; offline device's location is preserved.
    expect(await service.getLocation("mac-old")).toBeDefined();
    expect((await service.getLocation("mac-old"))?.lat).toBe(53.1);
  });

  it("keeps an ONLINE same-name doppelganger (two live devices may share a name)", async () => {
    const service = await tempService();
    await service.register(mac("mac-a"));
    await service.register(mac("mac-b"));

    const { devices } = await service.list();
    expect(devices.map((d) => d.id).sort()).toEqual(["mac-a", "mac-b"]);
  });

  it("keeps an offline same-name device on a DIFFERENT platform", async () => {
    const service = await tempService();
    await service.register(
      { ...mac("named-phone"), platform: "android" },
      Date.now() - 10 * 60_000,
    );
    await service.register(mac("mac-new"));

    const { devices } = await service.list();
    expect(devices.map((d) => d.id).sort()).toEqual(["mac-new", "named-phone"]);
  });

  it("remove_device drops a stale entry with its location", async () => {
    const service = await tempService();
    setMeshService(service);
    await service.storeLocation({
      deviceId: "mac-old",
      lat: 53.1,
      lon: -6.2,
      ts: Date.now() - 10 * 60_000,
    });
    // Registered after the location — see the eviction test for why.
    await service.register(mac("mac-old"), Date.now() - 10 * 60_000);

    const res = await meshHandlers.remove_device(
      { action: "remove_device", device: "mac-old" },
      1,
      undefined,
      "1",
    );
    expect(res.ok).toBe(true);
    expect(res.text).toContain("Removed Ada's MacBook Pro [id: mac-old]");
    // Offline removal carries no re-register warning.
    expect(res.text).not.toContain("re-registers");

    const { devices } = await service.list();
    expect(devices).toEqual([]);
    expect(await service.getLocation("mac-old")).toBeUndefined();
  });

  it("remove_device warns when the target is still online", async () => {
    const service = await tempService();
    await service.register(mac("mac-live"));
    const res = await service.removeDevice("mac-live");
    expect(res.ok).toBe(true);
    expect(res.text).toContain("re-registers within ~60s");
  });

  it("remove_device refuses to run without an explicit target", async () => {
    const service = await tempService();
    await service.register(mac("mac-old"));
    for (const query of [undefined, "", "   "]) {
      const res = await service.removeDevice(query);
      expect(res.ok).toBe(false);
      expect(res.text).toContain("explicit device id or name");
    }
    // Nothing was removed.
    const { devices } = await service.list();
    expect(devices).toHaveLength(1);
  });

  it("remove_device surfaces an unknown device as a clean error", async () => {
    const service = await tempService();
    await service.register(mac("mac-old"));
    const res = await service.removeDevice("no-such-thing");
    expect(res.ok).toBe(false);
    expect(res.text).toContain('No mesh device matches "no-such-thing"');
  });
});

describe("MeshService registry bounds", () => {
  it("refuses an over-long device id and clamps the display fields", async () => {
    const service = await tempService();
    // The id is the identity key — a 200KB id is refused outright rather
    // than truncated onto (or over) some other device's entry.
    await expect(
      service.register({
        id: "x".repeat(200_000),
        name: "Huge",
        platform: "linux",
        appVersion: "1.0.0",
      }),
    ).rejects.toThrow(/Invalid device registration/);

    const stored = await service.register({
      id: "node-1",
      name: "N".repeat(5_000),
      platform: "linux",
      appVersion: "9".repeat(5_000),
    });
    expect(stored.name.length).toBe(128);
    expect(stored.appVersion.length).toBe(64);
    const { devices } = await service.list();
    expect(devices).toHaveLength(1);
  });

  // 130 sequential registrations each do a real, awaited fs write (mkdtemp +
  // write + rename) — comfortably fast normally, but this is the one test in
  // the file with enough of them that heavy disk/CPU contention from a
  // full-suite run can push it past the default 15s testTimeout even though
  // nothing is actually wrong. See the identical rationale in
  // vitest.config.ts for the global timeout bump.
  it("caps the registry, evicting the least-recently-seen device", async () => {
    const service = await tempService();
    // 130 registrations into a 128-device registry, oldest first: the two
    // stalest go, everything newer survives.
    const base = Date.now() - 200 * 60_000;
    for (let i = 0; i < 130; i++) {
      await service.register(
        {
          id: `node-${i}`,
          name: `Node ${i}`,
          platform: "linux",
          appVersion: "1.0.0",
        },
        base + i * 60_000,
      );
    }
    const { devices } = await service.list();
    expect(devices).toHaveLength(128);
    const ids = new Set(devices.map((d) => d.id));
    expect(ids.has("node-0")).toBe(false);
    expect(ids.has("node-1")).toBe(false);
    expect(ids.has("node-2")).toBe(true);
    expect(ids.has("node-129")).toBe(true);
  }, 30_000);

  it("breaks a last-seen tie deterministically instead of picking an arbitrary survivor", async () => {
    const service = await tempService();
    // Three devices registered with the EXACT same lastSeen (a real
    // possibility: a bulk backfill, or two heartbeats landing in the same
    // millisecond) followed by 127 devices with strictly newer timestamps —
    // 130 total against a 128 cap, so the tied group must supply both
    // evictions. Eviction breaks the tie by registration order (earlier
    // registration = staler), so node-0 and node-1 (registered first among
    // the tied trio) go and node-2 (registered last among them) survives —
    // deterministically, not by however `Array.prototype.sort` happens to
    // handle equal keys.
    const tiedTs = Date.now() - 200 * 60_000;
    for (const id of ["node-0", "node-1", "node-2"]) {
      await service.register(
        { id, name: id, platform: "linux", appVersion: "1.0.0" },
        tiedTs,
      );
    }
    for (let i = 3; i < 130; i++) {
      await service.register(
        {
          id: `node-${i}`,
          name: `Node ${i}`,
          platform: "linux",
          appVersion: "1.0.0",
        },
        tiedTs + (i - 2) * 60_000,
      );
    }
    const { devices } = await service.list();
    expect(devices).toHaveLength(128);
    const ids = new Set(devices.map((d) => d.id));
    expect(ids.has("node-0")).toBe(false);
    expect(ids.has("node-1")).toBe(false);
    expect(ids.has("node-2")).toBe(true);
    expect(ids.has("node-129")).toBe(true);
  }, 30_000);

  it("bounds locations reported by ids that never registered", async () => {
    const service = await tempService();
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
    });
    await service.storeLocation({
      deviceId: "phone",
      lat: 53.1,
      lon: -6.2,
      ts: 1_000,
    });
    // 40 fixes from ids that never registered: only the newest 16 orphans
    // are kept, and a registered device is never displaced by them.
    for (let i = 0; i < 40; i++) {
      await service.storeLocation({
        deviceId: `ghost-${i}`,
        lat: 1,
        lon: 1,
        ts: 10_000 + i,
      });
    }
    const { locations } = await service.list();
    expect(locations).toHaveLength(17);
    expect(locations.some((l) => l.deviceId === "phone")).toBe(true);
    expect(locations.some((l) => l.deviceId === "ghost-0")).toBe(false);
    expect(locations.some((l) => l.deviceId === "ghost-39")).toBe(true);
  });
});

describe("MeshService.pingAll", () => {
  it("probes an online device and reports its round-trip latency", async () => {
    const service = await tempService({ commandTimeoutMs: 500 });
    await registerPhone(service); // online (just registered)

    // Transport that answers the phone's status probe.
    service.registerTransport({
      locate: () => {},
      command: (cmd) => {
        if (cmd.deviceId === "phone" && cmd.name === "status") {
          service.completeCommand({
            commandId: cmd.id,
            deviceId: "phone",
            ok: true,
            data: { name: "Pixel 9" },
          });
        }
      },
    });

    const results = await service.pingAll();
    expect(results).toHaveLength(1);
    const phone = results[0];
    expect(phone.reachable).toBe(true);
    expect(typeof phone.latencyMs).toBe("number");
  });

  it("marks every device unreachable when no transport is attached", async () => {
    const service = await tempService({ commandTimeoutMs: 200 });
    await registerPhone(service);
    const results = await service.pingAll();
    expect(results).toHaveLength(1);
    expect(results[0].reachable).toBe(false);
    expect(results[0].error).toContain("transport");
  });

  it("returns an empty list when nothing has registered", async () => {
    const service = await tempService();
    expect(await service.pingAll()).toEqual([]);
  });
});

describe("MeshService node provisioning", () => {
  /** A resolver seam standing in for source-build/cache/release tiers. */
  async function stubResolver(): Promise<{
    resolver: NonNullable<
      ConstructorParameters<typeof MeshService>[1]
    >["nodeBinaryResolver"];
    binaryPath: string;
    calls: string[];
  }> {
    const dir = await mkdtemp(join(tmpdir(), "talon-node-resolve-"));
    const binaryPath = join(dir, "talon-node-linux-arm64");
    await fsWriteFile(binaryPath, "fake node binary");
    const calls: string[] = [];
    return {
      resolver: async (goos, goarch) => {
        calls.push(`${goos}/${goarch}`);
        return {
          path: binaryPath,
          version: "3.4.0",
          sha256: "ab".repeat(32),
          size: 16,
          source: "cache",
        };
      },
      binaryPath,
      calls,
    };
  }

  async function registerNode(
    service: MeshService,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await service.register({
      id: "srv",
      name: "Build Server",
      platform: "linux",
      arch: "arm64",
      appVersion: "3.3.0",
      capabilities: ["update_node", "write_file"],
      ...extra,
    });
  }

  it("registers and lists a node's arch alongside its platform", async () => {
    const service = await tempService();
    await registerNode(service);
    const listed = await service.describeDevices();
    expect(listed.text).toContain("(linux/arm64)");
  });

  it("auto-resolves the update binary from the node's platform/arch", async () => {
    const { resolver, calls } = await stubResolver();
    const service = await tempService({ nodeBinaryResolver: resolver });
    await registerNode(service);
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() =>
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
            ...(cmd.name === "update_node"
              ? { message: "Swapping and restarting." }
              : {}),
          }),
        ),
    });

    const result = await service.updateNodeBinary("srv");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("auto-resolved 3.4.0 for linux/arm64");
    expect(calls).toEqual(["linux/arm64"]);
  });

  it("asks for an explicit binary when the node never advertised arch", async () => {
    const service = await tempService();
    await registerNode(service, { arch: undefined });
    const result = await service.updateNodeBinary("srv");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("CPU architecture");
  });

  it("refuses update_node aimed at a mobile companion", async () => {
    const service = await tempService();
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["update_node"],
    });
    const result = await service.updateNodeBinary("phone");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("headless nodes only");
  });

  it("mints a single-use install link and serves both legs through the bridge routes", async () => {
    const { resolver, binaryPath } = await stubResolver();
    const service = await tempService({ nodeBinaryResolver: resolver });
    service.setBridgeInfo({
      scheme: "https",
      host: "100.64.0.7",
      port: 19880,
      token: "bearer-secret",
      fingerprint: "cd".repeat(32),
    });

    const minted = await service.makeNodeInstallLink("macos", "aarch64");
    expect(minted.ok).toBe(true);
    expect(minted.text).toContain(
      'curl -fsSk "https://100.64.0.7:19880/node/install?provision=',
    );

    const token = /provision=([A-Za-z0-9_-]+)/.exec(minted.text)![1]!;
    const install = service.openNodeInstall(token);
    expect(install?.filename).toBe("install-talon-node.sh");
    expect(install?.script).toContain("bearer-secret");
    expect(service.openNodeInstall(token)).toBeNull();
    expect(service.openNodeBinary(token)).toEqual({
      path: binaryPath,
      size: 16,
    });
    expect(service.openNodeBinary(token)).toBeNull();
  });

  it("refuses install links when the bridge is loopback-only or absent", async () => {
    const service = await tempService();
    const none = await service.makeNodeInstallLink("linux", "amd64");
    expect(none.ok).toBe(false);
    expect(none.text).toContain("bridge isn't running");

    service.setBridgeInfo({
      scheme: "http",
      host: "127.0.0.1",
      port: 19880,
      token: "tok",
    });
    const loopback = await service.makeNodeInstallLink("linux", "amd64");
    expect(loopback.ok).toBe(false);
    expect(loopback.text).toContain("loopback");
  });
});
