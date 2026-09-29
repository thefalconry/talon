/**
 * fetch_url reaches local services by default; the SSRF guard is an opt-in
 * (`fetchUrl.allowPrivateNetworks: false`).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const pool = vi.hoisted(() => ({ config: null as unknown }));

vi.mock("../core/engine/backend-controller/index.js", () => ({
  getPoolConfig: () => pool.config,
}));

const { fetchUrlHandlers } =
  await import("../core/engine/gateway-actions/fetch-url/index.js");

const LOCAL = "http://127.0.0.1:8080/status";

const fetchLocal = async () =>
  await fetchUrlHandlers.fetch_url({ url: LOCAL }, 1, null, "1");

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response('{"status":"ok"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  pool.config = null;
});

describe("fetch_url private networks", () => {
  it("fetches a loopback address with no config at all", async () => {
    const result = await fetchLocal();
    expect(result).toMatchObject({ ok: true, text: '{"status":"ok"}' });
  });

  it("fetches a loopback address when fetchUrl is present but unset", async () => {
    pool.config = { fetchUrl: {} };
    const result = await fetchLocal();
    expect(result).toMatchObject({ ok: true });
  });

  it("refuses it once the operator opts into the guard", async () => {
    pool.config = { fetchUrl: { allowPrivateNetworks: false } };
    const result = await fetchLocal();
    expect(result).toMatchObject({ ok: false });
    expect(String((result as { error?: string }).error)).toMatch(
      /Refusing to fetch 127\.0\.0\.1/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
