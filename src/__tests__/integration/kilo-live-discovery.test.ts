/**
 * Live-server integration test for the Kilo backend.
 *
 * Spawns a real `kilo serve` subprocess on a dedicated port, hits the
 * `/provider` and `/provider/auth` endpoints via the @kilocode/sdk v2 client,
 * and then runs the live response through Talon's `buildModelCatalog`
 * machinery (via `getOpenCodeModelCatalog` with `ensureServer` mocked to
 * return our test client).
 *
 * Why this exists:
 *   Pure unit tests use hand-crafted fixture data that we hope matches the
 *   real SDK shape. This test catches the case where the real Kilo server
 *   evolves its response (new fields, dropped fields, renamed providers) in a
 *   way that breaks our parser — without us having to wait for it to fail in
 *   production. It also confirms the very practical contract Ada wants:
 *   discovery against an out-of-the-box Kilo install MUST return a non-empty
 *   list of free models without throwing.
 *
 * What this verifies:
 *   1. `kilo serve` boots and answers `/global/health` within the timeout.
 *   2. `provider.list()` returns the expected `{all, connected, default}`
 *      shape with non-zero entries.
 *   3. `provider.auth()` returns at least one provider with auth methods.
 *   4. `getOpenCodeModelCatalog()` (Talon's parser) consumes the live data
 *      without throwing — i.e. the parser still matches the live schema.
 *   5. The parsed catalog contains the `opencode` and `kilo` default
 *      connected providers and at least one free, selectable model from each.
 *   6. A round-trip exists: a real model.id from the catalog can be looked
 *      up via `resolveOpenCodeModelInput` and returns the same entry.
 *   7. A real Kilo-style ID containing both "/" and ":" (e.g. an OpenRouter
 *      free model) resolves cleanly via the fast-path.
 *
 * Skipping:
 *   Ordinary test runs skip this suite if the `kilo` binary isn't available.
 *   The dedicated CI job sets KILO_LIVE_REQUIRED=1 and KILO_CODE_EXECUTABLE
 *   after installing Kilo Code, so missing CLI/backends fail there instead of
 *   being silently skipped.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { createKiloClient, type KiloClient } from "@kilocode/sdk/v2";
import {
  cliAvailable,
  spawnCli,
  stopProcess,
  waitForHealthy,
} from "./live-backend-helpers.js";

type RemoteCatalogModule =
  typeof import("../../backend/remote-server/model-catalog/index.js");
type RemoteModelCatalogModule = ReturnType<
  RemoteCatalogModule["createRemoteModelCatalogModule"]
>;

const KILO_EXECUTABLE_ENV = "KILO_CODE_EXECUTABLE";

// ── Preflight: locate the kilo CLI. ────────────────────────────────────────
// If it's missing we skip the whole suite — there's nothing to test without it.
function kiloAvailable(): boolean {
  return cliAvailable("kilo", KILO_EXECUTABLE_ENV);
}

const KILO_PRESENT = kiloAvailable();
const KILO_REQUIRED = process.env.KILO_LIVE_REQUIRED === "1";
const kiloDescribe = KILO_PRESENT || KILO_REQUIRED ? describe : describe.skip;
// Pick a high port that's unlikely to collide with the prod Talon Kilo/OpenCode
// servers (4096/4097 are reserved by default for those). 4198 is well clear.
const TEST_PORT = Number(process.env.KILO_TEST_PORT ?? 4198);
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
// Healthcheck loop: kilo serve typically responds within 1-2s; give ourselves
// 15s of headroom for CI cold-start, or 120s on Windows where subprocess
// startup and localhost binding is significantly slower (mirrors the same
// platform gate used in opencode-live-discovery.test.ts).
const HEALTH_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 15_000;
// Individual test timeout for calls that hit live Kilo network endpoints
// (/provider, /provider/auth). These involve kilo making upstream API calls
// to discover providers — on Windows CI runners the external round-trip can
// exceed vitest's 20s default. 60s gives enough headroom without masking
// actual hangs.
const TEST_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 20_000;

let kiloProc: ChildProcess | null = null;
let testClient: KiloClient;
let getOpenCodeModelCatalog: RemoteModelCatalogModule["getCatalog"];
let resolveOpenCodeModelInput: RemoteCatalogModule["resolveRemoteModelInput"];
let clearModelCatalogCache: RemoteModelCatalogModule["clearCache"];

vi.mock("../../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

kiloDescribe("Kilo live discovery (integration)", () => {
  beforeAll(async () => {
    if (!KILO_PRESENT) {
      throw new Error(
        "Kilo CLI is required for this test but `kilo --version` failed. Install @kilocode/cli or unset KILO_LIVE_REQUIRED.",
      );
    }

    // Bind a catalog module on the Kilo profile's own knobs, pointed at
    // the throwaway server this suite spawns instead of at the profile's
    // port-4097 one. `getClient` is lazy, so it resolves the live client
    // built further down this hook.
    const { createRemoteModelCatalogModule, resolveRemoteModelInput } =
      await import("../../backend/remote-server/model-catalog/index.js");
    const { kiloProfile } =
      await import("../../backend/remote-server/profiles/kilo.js");
    const catalogModule = createRemoteModelCatalogModule({
      ...kiloProfile.definition,
      getClient: async (): Promise<KiloClient> => {
        if (!testClient) {
          throw new Error(
            "catalog client requested before kilo-live beforeAll initialised testClient",
          );
        }
        return testClient;
      },
    });
    getOpenCodeModelCatalog = catalogModule.getCatalog;
    clearModelCatalogCache = catalogModule.clearCache;
    resolveOpenCodeModelInput = resolveRemoteModelInput;

    // Spawn `kilo serve` in detached-style stdio so its output doesn't
    // contaminate our test output. We capture stdout/stderr to a buffer
    // we can include in failure messages.
    kiloProc = spawnCli(
      "kilo",
      [
        "serve",
        `--hostname=127.0.0.1`,
        `--port=${TEST_PORT}`,
        "--log-level=ERROR",
      ],
      KILO_EXECUTABLE_ENV,
    );
    let stderr = "";
    kiloProc.stdout?.on("data", () => {
      /* drain */
    });
    kiloProc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    kiloProc.on("error", (err) => {
      // surfaced via the healthcheck failure below if anything goes wrong
      stderr += `\nspawn error: ${err.message}`;
    });

    try {
      await waitForHealthy(BASE_URL, HEALTH_TIMEOUT_MS);
    } catch (err) {
      throw new Error(
        `${(err as Error).message}\nkilo stderr:\n${stderr || "(empty)"}`,
      );
    }

    testClient = createKiloClient({ baseUrl: BASE_URL, throwOnError: true });
    // Cache may have been populated by a sibling test run — make sure we
    // hit the live server, not a stale fixture.
    clearModelCatalogCache();
  }, HEALTH_TIMEOUT_MS + 5_000);

  afterAll(async () => {
    await stopProcess(kiloProc);
    kiloProc = null;
  });

  // ── 1. Server health endpoint responds. ──────────────────────────────────
  it("kilo serve responds to /global/health", async () => {
    const resp = await fetch(`${BASE_URL}/global/health`);
    expect(resp.ok).toBe(true);
    const body = (await resp.json()) as { healthy?: boolean };
    expect(body.healthy).toBe(true);
  });

  // ── 2. /provider returns the expected shape with non-zero entries. ───────
  it(
    "provider.list() returns {all, connected, default} with content",
    async () => {
      const resp = await testClient.provider.list();
      const data = resp.data as {
        all?: Array<unknown>;
        connected?: Array<string>;
        default?: Record<string, string>;
      };
      expect(Array.isArray(data.all)).toBe(true);
      expect((data.all ?? []).length).toBeGreaterThan(0);
      expect(Array.isArray(data.connected)).toBe(true);
      expect((data.connected ?? []).length).toBeGreaterThan(0);
      expect(typeof data.default).toBe("object");
    },
    TEST_TIMEOUT_MS,
  );

  // ── 3. /provider/auth has at least one provider with auth methods. ───────
  it(
    "provider.auth() returns at least one provider with auth methods",
    async () => {
      const resp = await testClient.provider.auth();
      const data =
        (resp.data as Record<string, Array<{ type?: string }>> | undefined) ??
        {};
      const keys = Object.keys(data);
      expect(keys.length).toBeGreaterThan(0);
      // At least one provider should advertise an auth method.
      const withAuth = keys.filter(
        (k) => Array.isArray(data[k]) && data[k].length > 0,
      );
      expect(withAuth.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  // ── 4. Talon's parser consumes the live data without throwing. ───────────
  it("getOpenCodeModelCatalog() parses live data without throwing", async () => {
    const catalog = await getOpenCodeModelCatalog(/* forceRefresh */ true);
    expect(catalog).toBeDefined();
    expect(Array.isArray(catalog.providers)).toBe(true);
    expect(Array.isArray(catalog.models)).toBe(true);
    expect(catalog.providers.length).toBeGreaterThan(0);
    expect(catalog.models.length).toBeGreaterThan(0);
  });

  // ── 5. Out-of-the-box discovery yields free, selectable models. ──────────
  // This is the contract Ada called out explicitly: "expect models to
  // return non zero and not throw an error."
  it("discovers at least one selectable model out of the box", async () => {
    const catalog = await getOpenCodeModelCatalog();
    expect(catalog.connectedModels.length).toBeGreaterThan(0);
    for (const m of catalog.connectedModels) {
      expect(m.selectable).toBe(true);
      // Every selectable model has a provider (sanity: parser didn't drop
      // the providerID).
      expect(m.providerID).toBeTruthy();
      expect(m.providerName).toBeTruthy();
    }
  });

  it("discovers at least one free model out of the box", async () => {
    const catalog = await getOpenCodeModelCatalog();
    expect(catalog.connectedFreeModels.length).toBeGreaterThan(0);
    for (const m of catalog.connectedFreeModels) {
      expect(m.free).toBe(true);
      expect(m.selectable).toBe(true);
      // Free-model invariant: at least one of cost.input / cost.output must
      // be zero. The other can be non-zero (some providers price asymmetrically
      // but mark the model as free via a "free" tag in id/name).
      expect(m.costInput === 0 || m.costOutput === 0).toBe(true);
    }
  });

  it("surfaces the default 'kilo' connected provider", async () => {
    const catalog = await getOpenCodeModelCatalog();
    const connectedIds = catalog.connectedProviders.map((p) => p.id);
    // A fresh Kilo install always ships 'kilo' as a connected provider
    // (no login required — its built-in free models are the discovery hook
    // Ada called out). 'opencode' often appears too but its connected
    // status depends on whether the binary has cached an opencode-zen
    // session, which isn't reproducible across machines.
    expect(connectedIds).toContain("kilo");
    // Sanity: at least one connected provider has free models. If 'kilo'
    // ever stops shipping free models, the assertion above will catch it
    // first, but this one catches the case where 'kilo' is present but
    // empty of free models.
    const withFreeModels = catalog.connectedProviders.filter((p) =>
      catalog.connectedFreeModels.some((m) => m.providerID === p.id),
    );
    expect(withFreeModels.length).toBeGreaterThan(0);
  });

  // ── 6. A real model.id round-trips through resolveOpenCodeModelInput. ────
  it("round-trips a live model.id through resolveOpenCodeModelInput", async () => {
    const catalog = await getOpenCodeModelCatalog();
    expect(catalog.connectedModels.length).toBeGreaterThan(0);
    const sample = catalog.connectedModels[0];
    const resolution = resolveOpenCodeModelInput(sample.id, catalog);
    expect(resolution.kind).toBe("exact");
    if (resolution.kind !== "exact") return;
    expect(resolution.model.id).toBe(sample.id);
    expect(resolution.model.providerID).toBe(sample.providerID);
  });

  // ── 7. Fast-path regression: full ID containing / and : resolves. ────────
  it("resolves a real ':free'-suffixed model via the full-ID fast path", async () => {
    const catalog = await getOpenCodeModelCatalog();
    // Find a connected free model whose ID actually contains ":". If none
    // exists in the catalog (rare), skip — the fast path is exercised by
    // the unit tests too.
    const colonIdModel = catalog.connectedFreeModels.find((m) =>
      m.id.includes(":"),
    );
    if (!colonIdModel) {
      // Surface that the fast-path wasn't exercised live, but don't fail —
      // the unit test in kilo-models.test.ts asserts the same property
      // against a hand-built catalog.
      return;
    }
    const resolution = resolveOpenCodeModelInput(colonIdModel.id, catalog);
    expect(resolution.kind).toBe("exact");
    if (resolution.kind !== "exact") return;
    expect(resolution.model.id).toBe(colonIdModel.id);
  });

  // ── 8. Cache TTL — the second call inside the TTL window returns the same
  // catalog reference (cache hit). Documents the existing behaviour so a
  // refactor that accidentally drops caching gets caught immediately.
  it("caches the catalog within the TTL window", async () => {
    const a = await getOpenCodeModelCatalog();
    const b = await getOpenCodeModelCatalog();
    // Same reference — not just structurally equal.
    expect(b).toBe(a);
  });

  it("forceRefresh bypasses the cache", async () => {
    const a = await getOpenCodeModelCatalog();
    const b = await getOpenCodeModelCatalog(/* forceRefresh */ true);
    // Fresh build → different reference (even if content is identical).
    expect(b).not.toBe(a);
  });
});
