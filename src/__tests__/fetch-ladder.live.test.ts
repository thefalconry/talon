/**
 * Live check of the fetch ladder's impersonation rung: downloads the pinned
 * curl-impersonate (verifying the sha256 pin for this platform), asks a TLS
 * fingerprint echo service what it saw, and optionally fetches a real
 * bot-walled page through the full ladder.
 *
 * Needs the network, so it only runs when asked:
 *   TALON_FETCH_LIVE=1 npx vitest run src/__tests__/fetch-ladder.live.test.ts
 *   TALON_FETCH_LIVE_URL=https://walled.example/ also runs the full ladder.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  curlImpersonateRung,
  installCurlImpersonate,
} from "../core/fetch/curl-impersonate.js";
import { buildFetchLadder } from "../core/fetch/index.js";

const live = !!process.env.TALON_FETCH_LIVE;

describe.skipIf(!live)("fetch ladder (live network)", () => {
  let root = "";
  let exe = "";

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("installs the pinned curl-impersonate for this platform", async () => {
    root = await mkdtemp(join(tmpdir(), "talon-ci-live-"));
    exe = await installCurlImpersonate({ root });
    expect(exe).toContain(root);
    // Second call hits the verified cache.
    expect(await installCurlImpersonate({ root })).toBe(exe);
  }, 120_000);

  it("presents a browser TLS/HTTP2 fingerprint", async () => {
    const rung = curlImpersonateRung({
      target: "safari184",
      resolveExe: async () => exe,
    });
    const res = await rung.request({
      url: new URL("https://tls.peet.ws/api/all"),
      headers: {},
      timeoutMs: 30_000,
      maxBytes: 1 << 20,
    });
    expect(res.status).toBe(200);
    const echo = JSON.parse(res.body.toString()) as {
      http_version: string;
      user_agent: string;
    };
    expect(echo.http_version).toBe("h2");
    expect(echo.user_agent).toContain("Safari");
  }, 60_000);

  it.skipIf(!process.env.TALON_FETCH_LIVE_URL)(
    "gets a walled page through the ladder",
    async () => {
      const ladder = buildFetchLadder(
        { fetch: { curlImpersonatePath: exe } },
        { maxBytes: 50 * 1024 * 1024 },
      );
      const result = await ladder.fetch(process.env.TALON_FETCH_LIVE_URL!);
      expect(result.ok, JSON.stringify(result.attempts)).toBe(true);
      if (result.ok) expect(result.via).toMatch(/^impersonate:/);
    },
    150_000,
  );
});
