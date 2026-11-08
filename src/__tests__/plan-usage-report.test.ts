import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TalonConfig } from "../core/config/index.js";

const listAvailableBackends = vi.hoisted(() => vi.fn());
const getPooledBackend = vi.hoisted(() => vi.fn());
const acquireBackendInstance = vi.hoisted(() => vi.fn());
vi.mock("../core/engine/backend-controller/index.js", () => ({
  listAvailableBackends,
  getPooledBackend,
  acquireBackendInstance,
}));

const { collectPlanUsage } =
  await import("../frontend/presentation/plan-usage-report.js");

const config = {} as TalonConfig;

function reporting(percent: number) {
  return {
    usage: {
      getPlanUsage: async () => ({
        plan: "max",
        fetchedAt: Date.now(),
        windows: [{ label: "7d", percent }],
      }),
    },
  };
}

describe("collectPlanUsage", () => {
  beforeEach(() => {
    listAvailableBackends.mockReset();
    getPooledBackend.mockReset();
    acquireBackendInstance.mockReset();
  });

  it("reports a backend that has plan limits", async () => {
    listAvailableBackends.mockReturnValue([
      { id: "claude", label: "Anthropic" },
    ]);
    getPooledBackend.mockReturnValue(reporting(12));

    const [entry] = await collectPlanUsage(config);
    expect(entry?.label).toBe("Anthropic");
    expect(entry?.plan?.windows[0]).toMatchObject({ label: "7d", percent: 12 });
    expect(entry?.note).toBeUndefined();
  });

  it("explains a backend with no plan concept rather than omitting it", async () => {
    listAvailableBackends.mockReturnValue([{ id: "kilo", label: "Kilo" }]);
    getPooledBackend.mockReturnValue({ usage: undefined });

    const [entry] = await collectPlanUsage(config);
    expect(entry?.plan).toBeNull();
    expect(entry?.note).toContain("no plan limits");
  });

  it("boots an idle backend to read its quota instead of calling it 'not running'", async () => {
    listAvailableBackends.mockReturnValue([
      { id: "agy", label: "Antigravity" },
    ]);
    getPooledBackend.mockReturnValue(null); // nothing routed to it right now
    const release = vi.fn(async () => {});
    acquireBackendInstance.mockResolvedValue({
      backend: reporting(42),
      release,
    });

    const [entry] = await collectPlanUsage(config);
    expect(entry?.plan?.windows[0]?.percent).toBe(42);
    expect(release).toHaveBeenCalledOnce();
  });

  it("stays quiet when an idle backend cannot be booted", async () => {
    listAvailableBackends.mockReturnValue([{ id: "codex", label: "Codex" }]);
    getPooledBackend.mockReturnValue(null);
    acquireBackendInstance.mockRejectedValue(new Error("no auth"));

    const [entry] = await collectPlanUsage(config);
    expect(entry?.plan).toBeNull();
    expect(entry?.note).toContain("no usage information");
  });

  it("treats a backend that answers nothing as unavailable, not broken", async () => {
    listAvailableBackends.mockReturnValue([{ id: "codex", label: "Codex" }]);
    getPooledBackend.mockReturnValue({
      usage: { getPlanUsage: async () => undefined },
    });

    const [entry] = await collectPlanUsage(config);
    expect(entry?.note).toBe("no usage information available");
  });

  it("survives a backend that throws", async () => {
    listAvailableBackends.mockReturnValue([{ id: "codex", label: "Codex" }]);
    getPooledBackend.mockReturnValue({
      usage: {
        getPlanUsage: async () => {
          throw new Error("network down");
        },
      },
    });

    const [entry] = await collectPlanUsage(config);
    expect(entry?.note).toBe("no usage information available");
  });

  it("keeps config order and reports every exposed backend", async () => {
    listAvailableBackends.mockReturnValue([
      { id: "claude", label: "Anthropic" },
      { id: "codex", label: "Codex" },
      { id: "kilo", label: "Kilo" },
    ]);
    getPooledBackend.mockImplementation((id: string) =>
      id === "claude" ? reporting(31) : id === "codex" ? reporting(26) : null,
    );
    acquireBackendInstance.mockRejectedValue(new Error("not configured"));

    const entries = await collectPlanUsage(config);
    expect(entries.map((e) => e.id)).toEqual(["claude", "codex", "kilo"]);
    expect(entries[0]?.plan?.windows[0]?.percent).toBe(31);
    expect(entries[1]?.plan?.windows[0]?.percent).toBe(26);
    expect(entries[2]?.note).toContain("no usage information");
  });
});
