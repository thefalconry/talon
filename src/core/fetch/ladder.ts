/**
 * FetchLadder — fetch a URL through an ordered list of rungs so a bot wall
 * on one path doesn't end the job:
 *
 *   a. browser-TLS impersonation, direct   (impersonate:<profile>)
 *   b. the same through each SOCKS exit     (impersonate:<profile>@<exit>)
 *   c. plain runtime fetch                  (plain)
 *   d. anti-detect browser (Camoufox)       (camoufox)          opt-in
 *   e. curl on a mesh egress device         (egress:<device>)   opt-in
 *
 * The climb stops at the first usable answer AND at the first definitive
 * one: a 404 is a wrong URL, not a block, and is reported as such rather
 * than retried through every exit. Only 403/429/503/999, challenge pages
 * and network failures move on to the next rung.
 *
 * Redirects are followed here, hop by hop, for every rung that doesn't
 * follow them itself, so the SSRF guard (fetchUrl.allowPrivateNetworks:
 * false) sees each hop exactly as it does for the plain path.
 */

import { lookup } from "node:dns/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResponseTooLargeError } from "../../util/http-body.js";
import { logDebug } from "../../util/log.js";
import {
  assertPublicUrl,
  BlockedUrlError,
  isBlockedAddress,
  type Resolver,
} from "../engine/gateway-actions/fetch-url/guard.js";
import { classifyResponse, isDefinitive } from "./classify.js";
import type {
  LadderResult,
  RawResponse,
  Rung,
  RungOutcome,
  Verdict,
} from "./types.js";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_RUNG_TIMEOUT_MS = 20_000;
/** Whole-ladder budget; sits under the tool bridge's fetch_url timeout. */
const DEFAULT_BUDGET_MS = 150_000;
/** Don't start a rung with less than this left. */
const MIN_RUNG_MS = 3_000;

// ── daily byte budget for relayed rungs ─────────────────────────────────────

/** In-memory, per-UTC-day byte counter for relayed rungs. */
export class DailyByteBudget {
  private day = "";
  private used = 0;
  constructor(
    readonly cap: number,
    private readonly now: () => number = Date.now,
  ) {}
  private roll(): void {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
  }
  exhausted(): boolean {
    this.roll();
    return this.used >= this.cap;
  }
  add(bytes: number): void {
    this.roll();
    this.used += bytes;
  }
}

// ── target classification ───────────────────────────────────────────────────

const defaultResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
];

/**
 * True when the host is loopback/private/link-local (literal, by name, or
 * by resolution). Such targets only get the plain rung: they have no bot
 * wall, and an exit or a remote device can't reach them.
 */
export async function isPrivateTarget(
  url: URL,
  resolve: Resolver = defaultResolver,
): Promise<boolean> {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) return isBlockedAddress(host);
  if (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return true;
  }
  try {
    const addrs = await resolve(host);
    return addrs.some(isBlockedAddress);
  } catch {
    return false; // unresolvable here — maybe an exit can resolve it
  }
}

// ── the ladder ──────────────────────────────────────────────────────────────

export type FetchLadderOptions = {
  rungs: readonly Rung[];
  /** false = SSRF guard on every hop (fetchUrl.allowPrivateNetworks). */
  allowPrivateNetworks: boolean;
  /** Body cap per response. */
  maxBytes: number;
  /** Byte budget shared by relayed rungs; undefined = uncapped. */
  byteBudget?: DailyByteBudget;
  /** Extra request headers for every rung. */
  headers?: Record<string, string>;
  rungTimeoutMs?: number;
  budgetMs?: number;
  resolve?: Resolver;
  now?: () => number;
};

type Candidate = { rung: Rung; res: RawResponse };

function describe(o: RungOutcome): string {
  if (o.verdict === "skipped") return `${o.via} skipped (${o.detail})`;
  if (o.status) return `${o.via} HTTP ${o.status}`;
  return `${o.via} ${o.detail ?? o.verdict}`;
}

/** Mutable state of one climb. */
type Climb = {
  attempts: RungOutcome[];
  lastVerdict: Verdict | "skipped";
  /**
   * A 2xx page that only *looked* like a challenge: kept, so a false
   * positive in the marker scan costs extra rungs, never the content.
   */
  fallback?: Candidate;
};

/** The result once every rung has been tried without a definitive answer. */
function exhausted(run: Climb): LadderResult {
  const { attempts, fallback } = run;
  if (fallback) {
    const { rung, res } = fallback;
    return {
      ok: true,
      via: rung.name,
      status: res.status,
      headers: res.headers,
      body: res.body,
      url: res.url,
      attempts,
      note: "every rung got what looks like a bot-check page; this may be the challenge, not the content",
    };
  }
  const tried = attempts.map(describe).join(", ");
  const anyAnswer = attempts.some((a) => a.status);
  return {
    ok: false,
    verdict: run.lastVerdict,
    error: anyAnswer
      ? `Blocked on every rung (${tried}). This host is being refused as automated traffic — a bot wall, not a bad URL.`
      : `Could not reach the site on any rung (${tried}).`,
    attempts,
  };
}

export class FetchLadder {
  constructor(private readonly opts: FetchLadderOptions) {}

  /** Names of the configured rungs, in climb order. */
  get rungNames(): string[] {
    return this.opts.rungs.map((r) => r.name);
  }

  async fetch(input: string): Promise<LadderResult> {
    const now = this.opts.now ?? Date.now;
    const deadline = now() + (this.opts.budgetMs ?? DEFAULT_BUDGET_MS);
    const resolve = this.opts.resolve ?? defaultResolver;
    const start = new URL(input);
    const run: Climb = { attempts: [], lastVerdict: "skipped" };

    const rungs = await this.rungsFor(start, resolve);
    if (typeof rungs === "string") {
      return { ok: false, verdict: "http-error", error: rungs, attempts: [] };
    }

    let jarDir: string | undefined;
    try {
      for (const [index, rung] of rungs.entries()) {
        const remaining = deadline - now();
        const skip = await this.skipReason(rung, remaining);
        if (skip) {
          run.attempts.push({
            via: rung.name,
            ok: false,
            verdict: "skipped",
            detail: skip,
          });
          continue;
        }
        jarDir ??= await mkdtemp(join(tmpdir(), "talon-jar-"));
        const timeoutMs = Math.min(
          rung.timeoutMs ?? this.opts.rungTimeoutMs ?? DEFAULT_RUNG_TIMEOUT_MS,
          remaining,
        );
        const done = await this.attempt(run, rung, start, {
          timeoutMs,
          cookieJar: join(jarDir, `${index}.jar`),
          resolve,
        });
        if (done) return done;
      }
    } finally {
      if (jarDir)
        await rm(jarDir, { recursive: true, force: true }).catch(() => {});
    }
    return exhausted(run);
  }

  /**
   * The rungs worth trying for this target, or a refusal message when the
   * SSRF guard rejects it outright.
   */
  private async rungsFor(
    start: URL,
    resolve: Resolver,
  ): Promise<readonly Rung[] | string> {
    try {
      if (!this.opts.allowPrivateNetworks) {
        await assertPublicUrl(start, resolve);
      } else if (await isPrivateTarget(start, resolve)) {
        return this.opts.rungs.filter((r) => !r.publicOnly);
      }
      return this.opts.rungs;
    } catch (err) {
      if (err instanceof BlockedUrlError) return err.message;
      throw err;
    }
  }

  /** Why a rung can't run now, or undefined when it can. */
  private async skipReason(
    rung: Rung,
    remaining: number,
  ): Promise<string | undefined> {
    if (remaining < MIN_RUNG_MS) return "time budget used up";
    if (rung.relayed && this.opts.byteBudget?.exhausted())
      return "daily byte cap reached";
    const ready = await rung.available();
    return ready === true ? undefined : ready;
  }

  /**
   * Run one rung and record the outcome. Returns the ladder's result when
   * this rung ends the climb (content, a definitive answer, a refusal),
   * undefined to climb on.
   */
  private async attempt(
    run: Climb,
    rung: Rung,
    start: URL,
    hop: { timeoutMs: number; cookieJar: string; resolve: Resolver },
  ): Promise<LadderResult | undefined> {
    const { attempts } = run;
    let res: RawResponse;
    try {
      res = await this.climbOne(
        rung,
        start,
        hop.timeoutMs,
        hop.cookieJar,
        hop.resolve,
      );
    } catch (err) {
      const refusal =
        err instanceof BlockedUrlError
          ? err.message
          : err instanceof ResponseTooLargeError
            ? `Response too large (max ${Math.round(this.opts.maxBytes / 1024 / 1024)}MB)`
            : undefined;
      if (refusal) {
        attempts.push({
          via: rung.name,
          ok: false,
          verdict: "http-error",
          detail: refusal,
        });
        return {
          ok: false,
          verdict: "http-error",
          via: rung.name,
          error: refusal,
          attempts,
        };
      }
      const detail = err instanceof Error ? err.message : String(err);
      attempts.push({ via: rung.name, ok: false, verdict: "network", detail });
      run.lastVerdict = "network";
      logDebug("fetch", `fetch via ${rung.name} failed: ${detail}`);
      return undefined;
    }

    if (rung.relayed) this.opts.byteBudget?.add(res.body.length);
    const verdict = classifyResponse(res.status, res.body);
    run.lastVerdict = verdict;
    attempts.push({
      via: rung.name,
      ok: verdict === "ok",
      verdict,
      status: res.status,
      bytes: res.body.length,
    });
    logDebug(
      "fetch",
      `fetch via ${rung.name}: HTTP ${res.status} ${res.body.length}B → ${verdict} (${start.host})`,
    );

    if (verdict === "blocked" && res.status >= 200 && res.status < 300) {
      run.fallback ??= { rung, res };
    }
    if (!isDefinitive(verdict)) return undefined;
    if (verdict === "ok") {
      return {
        ok: true,
        via: rung.name,
        status: res.status,
        headers: res.headers,
        body: res.body,
        url: res.url,
        attempts,
      };
    }
    return {
      ok: false,
      verdict,
      status: res.status,
      via: rung.name,
      error:
        verdict === "not-found"
          ? `HTTP ${res.status} via ${rung.name} — the server says this page doesn't exist. That is a wrong URL, not a block; find the right address instead of retrying.`
          : `HTTP ${res.status} via ${rung.name}`,
      attempts,
    };
  }

  /** One rung, following redirects (guarded) unless the rung does. */
  private async climbOne(
    rung: Rung,
    start: URL,
    timeoutMs: number,
    cookieJar: string,
    resolve: Resolver,
  ): Promise<RawResponse> {
    const guard = !this.opts.allowPrivateNetworks;
    const headers = this.opts.headers ?? {};
    const maxBytes = this.opts.maxBytes;
    if (rung.followsRedirects) {
      return await rung.request({
        url: start,
        headers,
        timeoutMs,
        maxBytes,
        cookieJar,
      });
    }
    let url = start;
    for (let hop = 0; ; hop++) {
      const pinnedAddresses = guard
        ? await assertPublicUrl(url, resolve)
        : undefined;
      const res = await rung.request({
        url,
        headers,
        timeoutMs,
        maxBytes,
        cookieJar,
        pinnedAddresses,
      });
      const location = res.headers.get("location");
      if (!REDIRECT_STATUSES.has(res.status) || !location) return res;
      if (hop >= MAX_REDIRECTS) {
        throw new BlockedUrlError(`Too many redirects (max ${MAX_REDIRECTS})`);
      }
      url = new URL(location, url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new BlockedUrlError(`Refusing redirect to ${url.protocol} URL`);
      }
    }
  }
}
