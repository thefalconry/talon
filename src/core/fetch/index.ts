/**
 * Build the fetch ladder from config (`fetch`, `fetchUrl`, `playwright`).
 * See ladder.ts for the climb and docs/fetch-ladder.md for the operator view.
 */

import { readFileSync } from "node:fs";
import type { TalonConfig } from "../config/index.js";
import {
  DEFAULT_TARGETS,
  curlImpersonateRung,
  resolveCurlImpersonate,
  type ImpersonationEngine,
  type ProxySpec,
} from "./curl-impersonate.js";
import { DailyByteBudget, FetchLadder } from "./ladder.js";
import {
  browserRung,
  egressRung,
  plainRung,
  playwrightEndpoint,
} from "./rungs.js";
import type { Rung } from "./types.js";

type FetchSettings = NonNullable<TalonConfig["fetch"]>;

/** Config slice the builder reads; everything optional so partial test configs work. */
export type LadderConfig = {
  fetch?: Partial<FetchSettings>;
  fetchUrl?: { allowPrivateNetworks?: boolean };
  playwright?: { endpoint?: string; endpointFile?: string };
};

/**
 * SOCKS credentials: TALON_FETCH_SOCKS_USER/TALON_FETCH_SOCKS_PASS, else
 * the first line of `fetch.socksCredentialsFile` ("user:pass"). Never
 * config.json — the schema refuses URLs with userinfo.
 */
export function socksCredentials(
  file: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { user: string; pass: string } | undefined {
  if (env.TALON_FETCH_SOCKS_USER) {
    return {
      user: env.TALON_FETCH_SOCKS_USER,
      pass: env.TALON_FETCH_SOCKS_PASS ?? "",
    };
  }
  if (!file) return undefined;
  try {
    const line = readFileSync(file, "utf8").split(/\r?\n/)[0]?.trim() ?? "";
    const idx = line.indexOf(":");
    if (idx <= 0) return undefined;
    return { user: line.slice(0, idx), pass: line.slice(idx + 1) };
  } catch {
    return undefined;
  }
}

export type BuildOptions = {
  maxBytes: number;
  engine?: ImpersonationEngine;
  env?: NodeJS.ProcessEnv;
};

/** The ordered rung list for a config. Exported for tests and diagnostics. */
export function buildRungs(
  config: LadderConfig | null | undefined,
  opts: BuildOptions,
): Rung[] {
  const f = config?.fetch ?? {};
  const guard = config?.fetchUrl?.allowPrivateNetworks === false;
  const engine = opts.engine ?? curlImpersonateRung;
  const targets = f.impersonateTargets?.length
    ? f.impersonateTargets
    : DEFAULT_TARGETS;
  const resolveExe = () => resolveCurlImpersonate(f.curlImpersonatePath);
  const rungs: Rung[] = [];

  if (f.impersonate !== false) {
    // (a) every profile direct — a site that rejects one often takes another.
    for (const target of targets) rungs.push(engine({ target, resolveExe }));
    // (b) the first profile through each exit: the IP was the problem.
    const creds = socksCredentials(f.socksCredentialsFile, opts.env);
    for (const exit of f.socksExits ?? []) {
      let label: string;
      try {
        label = new URL(exit).hostname;
      } catch {
        continue;
      }
      const proxy: ProxySpec = { url: exit, ...creds };
      rungs.push(
        engine({ target: targets[0], proxy, proxyLabel: label, resolveExe }),
      );
    }
  }
  // (c) plain fetch: some sites dislike impersonation, and it is the only
  // rung for local targets.
  rungs.push(plainRung());
  // (d) anti-detect browser for JS challenges.
  if (f.camoufox) {
    const endpoint =
      f.browserEndpoint ?? playwrightEndpoint(config?.playwright);
    if (endpoint) rungs.push(browserRung({ endpoint, guard }));
  }
  // (e) someone else's IP — last, and only when the operator named a device.
  if (f.egressDevice) rungs.push(egressRung(f.egressDevice));
  return rungs;
}

/** A ready ladder for the current config. Cheap: build one per call. */
export function buildFetchLadder(
  config: LadderConfig | null | undefined,
  opts: BuildOptions,
): FetchLadder {
  const cap = config?.fetch?.dailyByteCap ?? DEFAULT_DAILY_BYTE_CAP;
  return new FetchLadder({
    rungs: buildRungs(config, opts),
    allowPrivateNetworks: config?.fetchUrl?.allowPrivateNetworks !== false,
    maxBytes: opts.maxBytes,
    byteBudget: budgetFor(cap),
  });
}

const DEFAULT_DAILY_BYTE_CAP = 100 * 1024 * 1024;

/** One process-wide budget per cap value (a config reload with a new cap starts fresh). */
let sharedBudget: DailyByteBudget | undefined;
function budgetFor(cap: number): DailyByteBudget {
  if (!sharedBudget || sharedBudget.cap !== cap)
    sharedBudget = new DailyByteBudget(cap);
  return sharedBudget;
}
