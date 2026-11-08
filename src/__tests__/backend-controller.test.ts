/**
 * Tests for the backend controller — hot-swap, listener notification,
 * cleanup ordering, error tolerance.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Backend } from "../core/agent-runtime/capabilities.js";
import { stubBackend } from "./helpers/stub-backend.js";
import type { TalonConfig } from "../core/config/index.js";
import {
  registerBackend,
  clearBackends,
  type BackendFactory,
} from "../core/agent-runtime/backend-registry.js";
import {
  getBackendForRole,
  getBackendIdForRole,
  getBackendLabelForRole,
  hasBackendPool,
  rebindRole,
  roleHolder,
  listAvailableBackends,
  isBackendAvailable,
  isModelValidForBackend,
  onBackendChange,
  cleanupBackendPool,
  resetBackendPoolForTest,
  clearBackendChangeListenersForTest,
  acquireBackendInstance,
} from "../core/engine/backend-controller/index.js";
import {
  bindings,
  ctx,
  ensurePoolEntry,
} from "../core/engine/backend-controller/state.js";

function makeStubBackend(label: string): Backend {
  return stubBackend({
    label,
    query: vi.fn(async () => ({
      text: `[${label}] reply`,
      durationMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })),
  });
}

function makeFactory(
  id: string,
  label: string,
  opts: {
    failInit?: boolean;
    cleanupSpy?: (id: string) => void;
    initSpy?: (id: string) => void;
    backend?: Backend;
  } = {},
): BackendFactory {
  return {
    id,
    label,
    async init() {
      opts.initSpy?.(id);
      if (opts.failInit) {
        throw new Error(`init failed for ${id}`);
      }
      const backend = opts.backend ?? makeStubBackend(label);
      return {
        backend,
        cleanup: () => {
          opts.cleanupSpy?.(id);
        },
      };
    },
  };
}

const STUB_CONFIG = { backend: "alpha" } as unknown as TalonConfig;
const STUB_CTX = {
  getBridgePort: () => 0,
  frontendName: "terminal" as const,
};

/**
 * Bind only the chat role (initBackendPool binds every role, which would
 * keep the old backend pinned by heartbeat/dream across a chat swap).
 */
async function initChatRole(id: string): Promise<Backend> {
  ctx.initCtx = STUB_CTX;
  ctx.poolConfig = STUB_CONFIG;
  const entry = await ensurePoolEntry(id, STUB_CONFIG);
  const holder = roleHolder("chat");
  entry.holders.add(holder);
  bindings.set(holder, id);
  return entry.backend;
}

const switchChat = (id: string) => rebindRole("chat", id, STUB_CONFIG);

beforeEach(async () => {
  await cleanupBackendPool();
  resetBackendPoolForTest();
  clearBackendChangeListenersForTest();
  clearBackends();
});

describe("backend-controller", () => {
  it("initialises with a registered backend", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    expect(hasBackendPool()).toBe(false);

    const backend = await initChatRole("alpha");
    expect(hasBackendPool()).toBe(true);
    expect(getBackendIdForRole("chat")).toBe("alpha");
    expect(getBackendLabelForRole("chat")).toBe("Alpha");
    expect(getBackendForRole("chat")).toBe(backend);
  });

  it("throws when initialising an unknown backend", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    await expect(initChatRole("ghost")).rejects.toThrow(/Unknown backend/);
  });

  it("role accessors throw if the chat role is not bound", () => {
    expect(() => getBackendForRole("chat")).toThrow(/not bound/);
    expect(() => getBackendIdForRole("chat")).toThrow(/not bound/);
    expect(() => getBackendLabelForRole("chat")).toThrow(/not bound/);
  });

  it("hot-swaps to a different backend", async () => {
    const cleanups: string[] = [];
    registerBackend(
      makeFactory("alpha", "Alpha", {
        cleanupSpy: (id) => cleanups.push(`cleanup:${id}`),
      }),
    );
    registerBackend(makeFactory("beta", "Beta"));

    const alpha = await initChatRole("alpha");
    expect(getBackendForRole("chat")).toBe(alpha);

    const result = await switchChat("beta");
    expect(result).toMatchObject({ ok: true, from: "alpha", to: "beta" });
    expect(getBackendIdForRole("chat")).toBe("beta");
    expect(getBackendForRole("chat")).not.toBe(alpha);
    expect(cleanups).toEqual(["cleanup:alpha"]);
  });

  it("rejects same-id swap", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    await initChatRole("alpha");

    const result = await switchChat("alpha");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already bound/);
  });

  it("rejects swap to unknown backend with helpful error", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("beta", "Beta"));
    await initChatRole("alpha");

    const result = await switchChat("gamma");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown backend "gamma"/);
    expect(result.error).toMatch(/"alpha"/);
    expect(result.error).toMatch(/"beta"/);
  });

  it("keeps previous backend active when new backend init fails", async () => {
    const cleanups: string[] = [];
    registerBackend(
      makeFactory("alpha", "Alpha", {
        cleanupSpy: (id) => cleanups.push(`cleanup:${id}`),
      }),
    );
    registerBackend(makeFactory("beta", "Beta", { failInit: true }));

    const alpha = await initChatRole("alpha");
    const result = await switchChat("beta");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Failed to init Beta/);
    expect(getBackendForRole("chat")).toBe(alpha);
    expect(getBackendIdForRole("chat")).toBe("alpha");
    expect(cleanups).toEqual([]); // previous cleanup must not have fired
  });

  it("survives cleanup failure on previous backend", async () => {
    registerBackend({
      id: "alpha",
      label: "Alpha",
      async init() {
        return {
          backend: makeStubBackend("Alpha"),
          cleanup: () => {
            throw new Error("cleanup boom");
          },
        };
      },
    });
    registerBackend(makeFactory("beta", "Beta"));

    await initChatRole("alpha");
    const result = await switchChat("beta");
    expect(result.ok).toBe(true);
    expect(getBackendIdForRole("chat")).toBe("beta");
  });

  it("notifies listeners after a successful swap", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("beta", "Beta"));
    await initChatRole("alpha");

    const calls: Array<{ id: string; label: string }> = [];
    onBackendChange((_role, _b, info) => {
      calls.push(info);
    });

    await switchChat("beta");
    expect(calls).toEqual([{ id: "beta", label: "Beta" }]);
  });

  it("does not notify listeners on failed swap (init error)", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("beta", "Beta", { failInit: true }));
    await initChatRole("alpha");

    const calls: Array<{ id: string }> = [];
    onBackendChange((_role, _b, info) => calls.push({ id: info.id }));

    await switchChat("beta");
    expect(calls).toEqual([]);
  });

  it("listener errors do not block subsequent listeners", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("beta", "Beta"));
    await initChatRole("alpha");

    const second = vi.fn();
    onBackendChange(() => {
      throw new Error("first listener boom");
    });
    onBackendChange(second);

    await switchChat("beta");
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("listener unsubscribe stops future notifications", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("beta", "Beta"));
    registerBackend(makeFactory("gamma", "Gamma"));
    await initChatRole("alpha");

    const calls: string[] = [];
    const unsubscribe = onBackendChange((_role, _b, info) =>
      calls.push(info.id),
    );

    await switchChat("beta");
    unsubscribe();
    await switchChat("gamma");

    expect(calls).toEqual(["beta"]);
  });

  it("listAvailableBackends sorts by id and reports labels", async () => {
    registerBackend(makeFactory("kilo", "Kilo"));
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("codex", "Codex"));
    await initChatRole("alpha");

    expect(listAvailableBackends()).toEqual([
      { id: "alpha", label: "Alpha" },
      { id: "codex", label: "Codex" },
      { id: "kilo", label: "Kilo" },
    ]);
  });

  it("isBackendAvailable respects enabledBackends", () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("beta", "Beta"));

    expect(isBackendAvailable("alpha")).toBe(true);
    expect(
      isBackendAvailable("alpha", {
        enabledBackends: ["beta"],
      } as unknown as TalonConfig),
    ).toBe(false);
    expect(
      isBackendAvailable("beta", {
        enabledBackends: ["beta"],
      } as unknown as TalonConfig),
    ).toBe(true);
    expect(isBackendAvailable("ghost")).toBe(false);
  });

  it("isModelValidForBackend trusts an exact selectable resolveModelInfo result", async () => {
    const backend = stubBackend({
      label: "Alpha",
      resolveModel: vi.fn(async (query: string) => {
        if (query === "good") {
          return {
            kind: "exact" as const,
            storedValue: "good",
            model: {
              id: "good",
              displayName: "Good",
              provider: "test",
              providerName: "Test",
              selectable: true,
            },
          };
        }
        if (query === "hidden") {
          return {
            kind: "exact" as const,
            storedValue: "hidden",
            model: {
              id: "hidden",
              displayName: "Hidden",
              provider: "test",
              providerName: "Test",
              selectable: false,
            },
          };
        }
        return { kind: "missing" as const };
      }),
    });

    await expect(isModelValidForBackend(backend, "good")).resolves.toBe(true);
    await expect(isModelValidForBackend(backend, "hidden")).resolves.toBe(
      false,
    );
    await expect(isModelValidForBackend(backend, "missing")).resolves.toBe(
      false,
    );
  });

  it("round-trip swap reuses the registry factory each time", async () => {
    const inits: string[] = [];
    const cleanups: string[] = [];
    registerBackend(
      makeFactory("alpha", "Alpha", {
        initSpy: (id) => inits.push(id),
        cleanupSpy: (id) => cleanups.push(id),
      }),
    );
    registerBackend(
      makeFactory("beta", "Beta", {
        initSpy: (id) => inits.push(id),
        cleanupSpy: (id) => cleanups.push(id),
      }),
    );

    await initChatRole("alpha");
    await switchChat("beta");
    await switchChat("alpha");
    await switchChat("beta");

    // 4 inits: initial alpha, switch to beta, switch back to alpha,
    // switch to beta again. Each switch fully reinitialises the
    // target backend — no stale state cached across cycles.
    expect(inits).toEqual(["alpha", "beta", "alpha", "beta"]);
    // 3 cleanups: leaving alpha (1st), leaving beta (2nd), leaving
    // alpha (3rd). The final beta is still active.
    expect(cleanups).toEqual(["alpha", "beta", "alpha"]);
  });

  it("cleanupBackendPool invokes cleanup and clears state", async () => {
    const cleanups: string[] = [];
    registerBackend(
      makeFactory("alpha", "Alpha", {
        cleanupSpy: (id) => cleanups.push(id),
      }),
    );
    await initChatRole("alpha");

    await cleanupBackendPool();
    expect(cleanups).toEqual(["alpha"]);
    expect(hasBackendPool()).toBe(false);
  });

  it("cleanupBackendPool is idempotent", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    await initChatRole("alpha");
    await cleanupBackendPool();
    await expect(cleanupBackendPool()).resolves.toBeUndefined();
  });

  it("hot-swap accessor returns the new backend before cleanup completes", async () => {
    // Deliberately slow cleanup to verify reads see the new backend
    // before the previous one has finished tearing down.
    let cleanupResolve!: () => void;
    const cleanupPromise = new Promise<void>((resolve) => {
      cleanupResolve = resolve;
    });
    registerBackend({
      id: "alpha",
      label: "Alpha",
      async init() {
        return {
          backend: makeStubBackend("Alpha"),
          cleanup: async () => {
            await cleanupPromise;
          },
        };
      },
    });
    registerBackend(makeFactory("beta", "Beta"));

    await initChatRole("alpha");
    const swapPromise = switchChat("beta");

    // Give the swap a microtask to flip the active pointer.
    await new Promise((r) => setImmediate(r));
    expect(getBackendIdForRole("chat")).toBe("beta");

    // Now release the old cleanup and await the swap.
    cleanupResolve();
    const result = await swapPromise;
    expect(result.ok).toBe(true);
  });
});

describe("acquireBackendInstance — transient catalog reads", () => {
  it("boots a non-active backend on demand and cleans up on release", async () => {
    const cleanupSpy = vi.fn();
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("beta", "Beta", { cleanupSpy }));
    await initChatRole("alpha");

    const { backend, release } = await acquireBackendInstance("beta");
    expect(backend).toBeDefined();
    await release();
    expect(cleanupSpy).toHaveBeenCalledWith("beta"); // refcount hit zero
  });

  it("leaves an already-active backend running after release", async () => {
    const cleanupSpy = vi.fn();
    registerBackend(makeFactory("alpha", "Alpha", { cleanupSpy }));
    await initChatRole("alpha");

    const { release } = await acquireBackendInstance("alpha");
    await release();
    expect(cleanupSpy).not.toHaveBeenCalled(); // chat role still holds it
  });

  it("throws for an unknown backend id", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    await initChatRole("alpha");
    await expect(acquireBackendInstance("ghost")).rejects.toThrow(/ghost/);
  });

  it("is idempotent on release", async () => {
    const cleanupSpy = vi.fn();
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("beta", "Beta", { cleanupSpy }));
    await initChatRole("alpha");

    const { release } = await acquireBackendInstance("beta");
    await release();
    await release(); // second call is a no-op
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });
});
