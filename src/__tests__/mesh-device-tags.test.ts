import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshRegistry } from "../core/mesh/devices/registry.js";
import { MeshService } from "../core/mesh/devices/service.js";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "talon-mesh-tags-"));
  const files = {
    devices: join(dir, "devices.json"),
    locations: join(dir, "locations.json"),
    history: join(dir, "history.json"),
  };
  const service = new MeshService(new MeshRegistry(files));
  return { service, files };
}

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  platform: "linux",
  appVersion: "1.0.0",
  ...extra,
});

const targetId = (res: ReturnType<MeshService["resolveDevice"]>) =>
  "target" in res ? res.target.id : res.error;

describe("device tags", () => {
  it("resolves tag:<name> and normalises case", async () => {
    const { service } = await setup();
    await service.register(node("mini"));
    await service.register(node("vps"));
    const set = await service.setDeviceTags("mini", ["GPU", "build", "gpu"]);
    expect(set.ok).toBe(true);
    expect(targetId(service.resolveDevice("TAG:gpu"))).toBe("mini");
    expect((await service.describeDevices()).text).toContain(
      "tags: gpu, build",
    );
  });

  it("a device's registration cannot set or clear its tags", async () => {
    const { service } = await setup();
    await service.register(node("rogue", { tags: ["gpu"] }));
    expect(service.resolveDevice("tag:gpu")).toHaveProperty("error");

    await service.setDeviceTags("rogue", ["build"]);
    await service.register(node("rogue", { tags: [] }));
    expect(targetId(service.resolveDevice("tag:build"))).toBe("rogue");
  });

  it("survives a daemon restart", async () => {
    const { service, files } = await setup();
    await service.register(node("mini"));
    await service.setDeviceTags("mini", ["gpu"]);
    const reloaded = new MeshService(new MeshRegistry(files));
    await reloaded.list();
    expect(targetId(reloaded.resolveDevice("tag:gpu"))).toBe("mini");
  });

  it("errors when several online devices share a tag, and on an unknown tag", async () => {
    const { service } = await setup();
    await service.register(node("a"));
    await service.register(node("b"));
    await service.setDeviceTags("a", ["gpu"]);
    await service.setDeviceTags("b", ["gpu"]);
    expect(targetId(service.resolveDevice("tag:gpu"))).toContain("matches 2");
    expect(targetId(service.resolveDevice("tag:nope"))).toContain("No device");
  });

  it("prefers the one online device with the tag", async () => {
    const { service } = await setup();
    await service.register(node("old"), Date.now() - 300_000);
    await service.register(node("new"));
    await service.setDeviceTags("old", ["gpu"]);
    await service.setDeviceTags("new", ["gpu"]);
    expect(targetId(service.resolveDevice("tag:gpu"))).toBe("new");
  });

  it("rejects invalid tags, and an empty list clears", async () => {
    const { service } = await setup();
    await service.register(node("mini"));
    expect((await service.setDeviceTags("mini", ["a b"])).ok).toBe(false);
    expect((await service.setDeviceTags("mini", "gpu")).ok).toBe(false);
    await service.setDeviceTags("mini", ["gpu"]);
    await service.setDeviceTags("mini", []);
    expect(service.resolveDevice("tag:gpu")).toHaveProperty("error");
  });
});
