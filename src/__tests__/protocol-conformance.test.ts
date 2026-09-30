/**
 * Daemon-side leg of the tri-implementation Bridge Protocol conformance
 * suite (see protocol/README.md). The same fixtures are replayed by the
 * companion app (protocol_conformance_test.dart) and talon-node
 * (protocol_conformance_test.go), so a wire drift on any side fails that
 * side's CI instead of shipping a silent misrender or a device command that
 * times out.
 *
 * The daemon is the producer of `BridgeEvent`s and the consumer of device
 * registrations/locations/command results, so this leg asserts:
 *   - the events fixture covers EVERY BridgeEvent kind (compile-time
 *     exhaustiveness: adding a kind without a fixture sample fails here);
 *   - each sample carries that kind's required fields;
 *   - mesh fixtures pass the real MeshRegistry validation/normalization;
 *   - the capability lists and command samples stay in lockstep with the
 *     device implementations' advertised surfaces.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeEvent,
  type DeviceCommand,
  type DeviceCommandResult,
  type DeviceInfo,
  type DeviceLocation,
} from "../frontend/native/protocol.js";
import { MeshRegistry } from "../core/mesh/index.js";
import {
  DeviceFiles,
  type DeviceFilesHost,
} from "../core/mesh/transfers/device-files.js";
import {
  sanitizeCapabilities,
  toDeviceInfo,
  toDeviceLocation,
} from "../core/mesh/types.js";

const FIXTURES = join(__dirname, "../../protocol/fixtures");

const eventsFixture = JSON.parse(
  readFileSync(join(FIXTURES, "events_v1.json"), "utf-8"),
) as {
  protocol: number;
  events: BridgeEvent[];
  forwardCompat: Array<Record<string, unknown>>;
};

type CommandEntry = {
  run: boolean;
  nodeUnsupported?: boolean;
  /** A streamed transfer: runs against a fake /devices/file. */
  transfer?: boolean;
  expectOk: boolean;
  dataKeys: string[];
  command: DeviceCommand;
};

const meshFixture = JSON.parse(
  readFileSync(join(FIXTURES, "mesh_v1.json"), "utf-8"),
) as {
  protocol: number;
  nodeCapabilities: string[];
  companionCoreCapabilities: string[];
  companionDeviceControlCapabilities: string[];
  registration: Record<string, unknown>;
  companionRegistration: Record<string, unknown>;
  device: DeviceInfo;
  location: DeviceLocation;
  resultOk: DeviceCommandResult;
  resultError: DeviceCommandResult;
  sandboxFiles: Record<string, string>;
  /** The body the fake bridge serves for a push token. */
  transferBody: string;
  commands: CommandEntry[];
};

/**
 * Every BridgeEvent kind, spelled out. `satisfies` rejects typos; the
 * AssertNever below fails to compile when a NEW kind is added to the union
 * without being listed here — which forces a fixture sample too, because the
 * runtime test asserts fixture kinds === this list.
 */
const EVENT_KINDS = [
  "hello",
  "status",
  "chat_created",
  "chat_updated",
  "chat_deleted",
  "message",
  "message_edited",
  "message_deleted",
  "reaction",
  "turn_start",
  "reasoning",
  "delta",
  "tool",
  "typing",
  "turn_end",
  "locate",
  "device_command",
  "error",
] as const satisfies readonly BridgeEvent["kind"][];

type MissingKind = Exclude<BridgeEvent["kind"], (typeof EVENT_KINDS)[number]>;
type AssertNever<T extends never> = T;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _EveryKindListed = AssertNever<MissingKind>;

describe("events fixture (protocol/fixtures/events_v1.json)", () => {
  it("carries the daemon's protocol version", () => {
    expect(eventsFixture.protocol).toBe(BRIDGE_PROTOCOL_VERSION);
  });

  it("covers every BridgeEvent kind exactly", () => {
    const inFixture = new Set(eventsFixture.events.map((e) => e.kind));
    expect([...inFixture].sort()).toEqual([...EVENT_KINDS].sort());
  });

  it("every sample carries its kind's required fields", () => {
    for (const e of eventsFixture.events) {
      switch (e.kind) {
        case "hello":
          expect(e.status.app).toBe("talon-bridge");
          expect(e.status.protocol).toBe(BRIDGE_PROTOCOL_VERSION);
          expect(e.chats.length).toBeGreaterThan(0);
          expect(e.chats[0].id).toBeTypeOf("string");
          break;
        case "status":
          expect(e.status.botName).toBeTypeOf("string");
          expect(e.status.backend).toBeTypeOf("string");
          break;
        case "chat_created":
        case "chat_updated":
          expect(e.chat.id).toBeTypeOf("string");
          expect(e.chat.title).toBeTypeOf("string");
          expect(e.chat.createdAt).toBeTypeOf("number");
          expect(e.chat.lastActive).toBeTypeOf("number");
          expect(e.chat.preview).toBeTypeOf("string");
          break;
        case "chat_deleted":
          expect(e.chatId).toBeTypeOf("string");
          break;
        case "message":
          expect(e.chatId).toBe(e.message.chatId);
          expect(e.message.id).toBeTypeOf("string");
          expect(["user", "assistant", "system"]).toContain(e.message.role);
          expect(e.message.ts).toBeTypeOf("number");
          break;
        case "message_edited":
          expect(e.messageId).toBeTypeOf("string");
          expect(e.text).toBeTypeOf("string");
          break;
        case "message_deleted":
          expect(e.messageId).toBeTypeOf("string");
          break;
        case "reaction":
          expect(e.messageId).toBeTypeOf("string");
          expect(e.emoji.length).toBeGreaterThan(0);
          break;
        case "turn_start":
          expect(e.chatId).toBeTypeOf("string");
          break;
        case "reasoning":
        case "delta":
          expect(e.chatId).toBeTypeOf("string");
          expect(e.text).toBeTypeOf("string");
          break;
        case "tool":
          expect(e.id).toBeTypeOf("string");
          expect(e.name).toBeTypeOf("string");
          expect(["call", "result"]).toContain(e.phase);
          if (e.phase === "call") expect(e.input).toBeTypeOf("object");
          break;
        case "typing":
          expect(e.on).toBeTypeOf("boolean");
          break;
        case "turn_end":
          expect(e.delivered).toBeTypeOf("number");
          if (e.usage) {
            expect(e.usage.input).toBeTypeOf("number");
            expect(e.usage.output).toBeTypeOf("number");
          }
          break;
        case "locate":
          if (e.deviceId !== undefined) expect(e.deviceId).toBeTypeOf("string");
          break;
        case "device_command":
          expect(e.id).toBeTypeOf("string");
          expect(e.deviceId).toBeTypeOf("string");
          expect(e.name).toBeTypeOf("string");
          expect(e.params).toBeTypeOf("object");
          break;
        case "error":
          expect(e.message).toBeTypeOf("string");
          break;
        default: {
          const unreachable: never = e;
          throw new Error(`unhandled kind ${JSON.stringify(unreachable)}`);
        }
      }
    }
  });

  it("streamed tool phases agree with the persisted tool timeline", () => {
    // The assistant `message` sample persists the same tools the `tool`
    // events streamed — the two views of one turn must not drift.
    const streamed = eventsFixture.events.filter(
      (e): e is Extract<BridgeEvent, { kind: "tool" }> => e.kind === "tool",
    );
    const persisted = eventsFixture.events
      .filter(
        (e): e is Extract<BridgeEvent, { kind: "message" }> =>
          e.kind === "message",
      )
      .flatMap((e) => e.message.tools ?? []);
    for (const tool of persisted) {
      expect(
        streamed.some((s) => s.id === tool.id && s.name === tool.name),
      ).toBe(true);
    }
  });

  it("device_command samples use advertised capability names", () => {
    const known = new Set([
      ...meshFixture.nodeCapabilities,
      ...meshFixture.companionCoreCapabilities,
      ...meshFixture.companionDeviceControlCapabilities,
    ]);
    for (const e of eventsFixture.events) {
      if (e.kind === "device_command") expect(known).toContain(e.name);
    }
  });

  it("forward-compat frames stay parseable JSON objects with a kind", () => {
    expect(eventsFixture.forwardCompat.length).toBeGreaterThan(0);
    for (const frame of eventsFixture.forwardCompat) {
      expect(typeof frame.kind).toBe("string");
    }
  });
});

describe("mesh fixture (protocol/fixtures/mesh_v1.json)", () => {
  const freshRegistry = async () => {
    const dir = await mkdtemp(join(tmpdir(), "talon-conformance-"));
    return new MeshRegistry({
      devices: join(dir, "devices.json"),
      locations: join(dir, "locations.json"),
      history: join(dir, "history.json"),
    });
  };

  it("carries the daemon's protocol version", () => {
    expect(meshFixture.protocol).toBe(BRIDGE_PROTOCOL_VERSION);
  });

  it("node registration passes the real registry validation unchanged", async () => {
    const registry = await freshRegistry();
    const now = meshFixture.device.lastSeen;
    const device = await registry.register(meshFixture.registration, now);
    expect(device).toEqual(meshFixture.device);
  });

  it("companion registration passes the real registry validation", async () => {
    const registry = await freshRegistry();
    const device = await registry.register(
      meshFixture.companionRegistration,
      1767225600000,
    );
    expect(device.id).toBe("dev_pixel8");
    expect(device.platform).toBe("android");
    expect(device.battery).toBe(87);
    expect(device.charging).toBe(false);
    expect(device.capabilities).toEqual(meshFixture.companionCoreCapabilities);
  });

  it("location report passes the real registry validation unchanged", async () => {
    const registry = await freshRegistry();
    const stored = await registry.storeLocation(
      meshFixture.location as unknown as Record<string, unknown>,
      meshFixture.location.ts,
    );
    expect(stored).toEqual(meshFixture.location);
  });

  it("capability lists are canonical and within registry bounds", () => {
    for (const list of [
      meshFixture.nodeCapabilities,
      meshFixture.companionCoreCapabilities,
      meshFixture.companionDeviceControlCapabilities,
    ]) {
      // sanitizeCapabilities is what the daemon actually stores — canonical
      // lists must survive it byte-for-byte (lowercase, deduped, ≤16).
      expect(sanitizeCapabilities(list)).toEqual(list);
    }
  });

  it("node registration advertises exactly the canonical node capabilities", () => {
    expect(meshFixture.registration.capabilities).toEqual(
      meshFixture.nodeCapabilities,
    );
    expect(meshFixture.device.capabilities).toEqual(
      meshFixture.nodeCapabilities,
    );
  });

  it("every advertised capability has a canonical command sample", () => {
    const sampled = new Set(meshFixture.commands.map((c) => c.command.name));
    for (const name of [
      ...meshFixture.nodeCapabilities,
      ...meshFixture.companionCoreCapabilities,
      ...meshFixture.companionDeviceControlCapabilities,
    ]) {
      expect(
        sampled,
        `missing command sample for capability "${name}"`,
      ).toContain(name);
    }
    // And no sample invents a command outside the advertised surfaces.
    const known = new Set([
      ...meshFixture.nodeCapabilities,
      ...meshFixture.companionCoreCapabilities,
      ...meshFixture.companionDeviceControlCapabilities,
    ]);
    for (const name of sampled) expect(known).toContain(name);
  });

  it("commands marked node-unsupported are outside the node's surface", () => {
    for (const entry of meshFixture.commands) {
      const inNodeList = meshFixture.nodeCapabilities.includes(
        entry.command.name,
      );
      expect(inNodeList).toBe(!entry.nodeUnsupported);
    }
  });

  it("command samples carry correlation ids and JSON-object params", () => {
    for (const { command } of meshFixture.commands) {
      expect(command.id).toBeTypeOf("string");
      expect(command.id.length).toBeGreaterThan(0);
      expect(command.deviceId).toBeTypeOf("string");
      expect(command.params).toBeTypeOf("object");
    }
  });

  it("command-result samples match the wire contract", () => {
    const ok: DeviceCommandResult = meshFixture.resultOk;
    expect(ok.ok).toBe(true);
    expect(ok.commandId).toBeTypeOf("string");
    expect(ok.deviceId).toBeTypeOf("string");
    const err: DeviceCommandResult = meshFixture.resultError;
    expect(err.ok).toBe(false);
    expect(err.message).toBeTypeOf("string");
    expect(err.data).toBeUndefined();
  });

  it("normalizers are identity on the canonical device and location", () => {
    expect(
      toDeviceInfo(meshFixture.device, meshFixture.device.lastSeen),
    ).toEqual(meshFixture.device);
    expect(toDeviceLocation(meshFixture.location)).toEqual(
      meshFixture.location,
    );
  });
});

describe("streamed transfer commands (mesh_v1.json, transfer: true)", () => {
  const sample = (name: string) => {
    const entry = meshFixture.commands.find((c) => c.command.name === name);
    if (!entry?.transfer) throw new Error(`no transfer sample for ${name}`);
    return entry;
  };

  /** DeviceFiles whose "device" moves the bytes through the real transfer
   *  store and records the params the daemon sent. */
  function daemonSide(): {
    files: DeviceFiles;
    sent: Record<string, Record<string, unknown>>;
  } {
    const sent: Record<string, Record<string, unknown>> = {};
    const device = {
      id: "dev_node01",
      name: "rack-01",
      capabilities: ["upload_file", "download_file"],
    } as DeviceInfo;
    const body = Buffer.from(meshFixture.transferBody);
    const digest = createHash("sha256").update(body).digest("hex");
    let files!: DeviceFiles;
    const host: DeviceFilesHost = {
      load: async () => {},
      resolveDevice: () => ({ target: device }),
      dispatchCommand: async (_q, name, params) => {
        sent[name] = params;
        if (name === "upload_file") {
          await files.acceptFileUpload(
            String(params.token),
            Readable.from([body]),
          );
        }
        const data =
          name === "upload_file"
            ? { bytes: body.length, sha256: digest }
            : { bytesWritten: body.length, sha256: digest };
        return {
          target: device,
          result: { commandId: "c", deviceId: device.id, ok: true, data },
        };
      },
      commandTimeoutMs: 30_000,
      resolveNode: (async () => {
        throw new Error("unused");
      }) as unknown as DeviceFilesHost["resolveNode"],
    };
    files = new DeviceFiles(host);
    return { files, sent };
  }

  it("download_file carries the fixture's params, sha256 of the body included", async () => {
    const { files, sent } = daemonSide();
    const dir = await mkdtemp(join(tmpdir(), "talon-conf-xfer-"));
    const src = join(dir, "body.bin");
    await writeFile(src, meshFixture.transferBody);
    const res = await files.pushFileToDevice("dev_node01", src, "/tmp/x");
    expect(res.ok).toBe(true);
    const want = sample("download_file").command.params;
    expect(Object.keys(sent.download_file).sort()).toEqual(
      Object.keys(want).sort(),
    );
    expect(sent.download_file.sha256).toBe(want.sha256);
  });

  it("upload_file carries exactly the fixture's params", async () => {
    const { files, sent } = daemonSide();
    const dir = await mkdtemp(join(tmpdir(), "talon-conf-xfer-"));
    const res = await files.pullFileFromDevice(
      "dev_node01",
      "/tmp/read.txt",
      join(dir, "pulled.txt"),
    );
    expect(res.ok).toBe(true);
    expect(Object.keys(sent.upload_file).sort()).toEqual(
      Object.keys(sample("upload_file").command.params).sort(),
    );
  });

  it("both transfer results name the digest the daemon verifies", () => {
    expect(sample("upload_file").dataKeys).toContain("sha256");
    expect(sample("download_file").dataKeys).toContain("sha256");
  });
});
