/**
 * Kimi Code CLI model catalog tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

const {
  parseKimiModels,
  resolveModel,
  getModelInfo,
  getProviders,
  getProviderModels,
  formatModelError,
  listModels,
  resetModelCache,
  getDefaultModelId,
} = await import("../backend/kimi/models.js");
const { toKimiEffort } = await import("../backend/kimi/effort.js");

const FIXTURES = join(import.meta.dirname, "fixtures", "kimi");
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf-8");

beforeEach(() => {
  resetModelCache();
  execFileMock.mockReset();
});

describe("kimi models — JSON parsing", () => {
  it("parses the provider list fixture into unified model records", () => {
    const raw = fixture("provider-list.json");
    const models = parseKimiModels(raw);
    expect(models.length).toBeGreaterThan(10);

    const kimiK3 = models.find((m) => m.id === "openrouter/moonshotai/kimi-k3");
    expect(kimiK3).toBeDefined();
    expect(kimiK3?.displayName).toBe("Kimi K3");
    expect(kimiK3?.provider).toBe("openrouter");
    expect(kimiK3?.contextWindow).toBe(1048576);
    expect(kimiK3?.reasoning).toBe(true);

    const freeModel = models.find(
      (m) => m.id === "openrouter/liquid/lfm-2.5-2.6b:free",
    );
    expect(freeModel).toBeDefined();
    expect(freeModel?.free).toBe(true);
  });

  it("handles malformed JSON and empty models safely", () => {
    expect(parseKimiModels("not json")).toEqual([]);
    expect(parseKimiModels("{}")).toEqual([]);
    expect(parseKimiModels('{"models":{}}')).toEqual([]);
  });
});

describe("kimi models — resolution", () => {
  beforeEach(() => {
    const raw = fixture("provider-list.json");
    execFileMock.mockImplementation(
      (
        _c: string,
        _a: string[],
        _o: unknown,
        cb: (e: unknown, r: { stdout: string; stderr: string }) => void,
      ) => cb(null, { stdout: raw, stderr: "" }),
    );
  });

  it("resolves exact id match", async () => {
    const res = await resolveModel("openrouter/moonshotai/kimi-k3");
    expect(res.kind).toBe("exact");
    if (res.kind === "exact") {
      expect(res.model.id).toBe("openrouter/moonshotai/kimi-k3");
    }
  });

  it("resolves case-insensitive id match", async () => {
    const res = await resolveModel("OPENROUTER/MOONSHOTAI/KIMI-K3");
    expect(res.kind).toBe("exact");
    if (res.kind === "exact") {
      expect(res.model.id).toBe("openrouter/moonshotai/kimi-k3");
    }
  });

  it("resolves unique prefix match", async () => {
    const res = await resolveModel("openrouter/liquid/lfm-2.5-2.6b:free");
    expect(res.kind).toBe("exact");
  });

  it("reports ambiguous when multiple models match prefix", async () => {
    const res = await resolveModel("openrouter/qwen");
    expect(res.kind).toBe("ambiguous");
  });

  it("returns missing for unknown query", async () => {
    const res = await resolveModel("nonexistent/model:xyz");
    expect(res.kind).toBe("missing");
  });

  it("returns missing for blank query", async () => {
    expect((await resolveModel("")).kind).toBe("missing");
    expect((await resolveModel("   ")).kind).toBe("missing");
  });
});

describe("kimi models — catalog browsing", () => {
  beforeEach(() => {
    const raw = fixture("provider-list.json");
    execFileMock.mockImplementation(
      (
        _c: string,
        _a: string[],
        _o: unknown,
        cb: (e: unknown, r: { stdout: string; stderr: string }) => void,
      ) => cb(null, { stdout: raw, stderr: "" }),
    );
  });

  it("groups providers by provider id", async () => {
    const providers = await getProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("openrouter");
    expect(providers[0].modelCount).toBeGreaterThan(10);
  });

  it("filters free-tier models", async () => {
    const freeOnly = await listModels("free");
    expect(freeOnly.models.length).toBeGreaterThan(0);
    expect(freeOnly.models.every((m) => m.free)).toBe(true);

    const all = await listModels("all");
    expect(all.models.length).toBeGreaterThan(freeOnly.models.length);
  });

  it("paginates provider models", async () => {
    const page1 = await getProviderModels("openrouter", 1, 5);
    expect(page1.models).toHaveLength(5);
    expect(page1.total).toBeGreaterThan(5);
  });

  it("formats model error message", () => {
    expect(formatModelError("test-missing", { kind: "missing" })).toContain(
      "No Kimi model matches `test-missing`",
    );
    expect(
      formatModelError("test-ambig", {
        kind: "ambiguous",
        matches: [
          { id: "m1", displayName: "M1", provider: "p", providerName: "P", selectable: true },
          { id: "m2", displayName: "M2", provider: "p", providerName: "P", selectable: true },
        ],
      }),
    ).toContain("Multiple Kimi models match `test-ambig`");
  });

  it("synthesizes unknown model on getModelInfo", async () => {
    const info = await getModelInfo("unknown/custom:model");
    expect(info?.id).toBe("unknown/custom:model");
    expect(info?.selectable).toBe(true);
  });

  it("returns default model id", () => {
    expect(getDefaultModelId()).toBe("openrouter/moonshotai/kimi-k3");
  });
});

describe("kimi effort mapping", () => {
  it("explicitly returns undefined (no-op) for all effort levels", () => {
    expect(toKimiEffort("low")).toBeUndefined();
    expect(toKimiEffort("medium")).toBeUndefined();
    expect(toKimiEffort("high")).toBeUndefined();
    expect(toKimiEffort("xhigh")).toBeUndefined();
    expect(toKimiEffort("max")).toBeUndefined();
    expect(toKimiEffort(undefined)).toBeUndefined();
  });
});
