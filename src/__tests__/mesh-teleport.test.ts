/**
 * Teleport state — the first read after a (re)start is shared, so a
 * teleport engaged while another chat's native tool is reading the state
 * is not silently dropped from memory.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getTeleport,
  resetTeleportCache,
  setTeleport,
} from "../core/mesh/devices/teleport.js";

const saved = process.env.TALON_TELEPORT_STATE_FILE;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "talon-teleport-"));
  process.env.TALON_TELEPORT_STATE_FILE = join(dir, "teleport-state.json");
  resetTeleportCache();
});

afterEach(() => {
  if (saved === undefined) delete process.env.TALON_TELEPORT_STATE_FILE;
  else process.env.TALON_TELEPORT_STATE_FILE = saved;
  resetTeleportCache();
});

describe("teleport state", () => {
  it("keeps a teleport engaged while another chat's cold read is in flight", async () => {
    await Promise.all([
      setTeleport("chat-a", "phone", "Pixel"),
      getTeleport("chat-b"),
    ]);
    expect(await getTeleport("chat-a")).toMatchObject({ deviceId: "phone" });
  });
});
