/**
 * `/usage` data gathering — plan limits across every backend the config
 * exposes, not just the one serving this chat.
 *
 * Most backends have no plan to report: a gateway (Kilo, OpenCode) bills
 * through whichever provider it fronts, and an API-key install pays per
 * token with no window to be near the end of. Those are listed with a
 * reason rather than omitted, so the answer to "am I close to a limit?" is
 * never silence — and since the plan-aware router landed they carry a
 * headroom figure too, derived from a local token budget where one is
 * configured, so "which backend has room?" is answerable for all of them.
 *
 * The gathering itself lives in core (`engine/backend-router/usage.ts`),
 * because the gateway tools need the same data and core cannot import a
 * frontend. This module is the rendering adapter over it.
 */

import type { TalonConfig } from "../../core/config/index.js";
import {
  collectBackendUsage,
  formatHeadroom,
  type BackendHeadroom,
} from "../../core/engine/backend-router/index.js";
import { buildPlanDisplay, type PlanDisplay } from "./status-context.js";

/** Short enough that a row fits a phone held upright. */
const USAGE_BAR_LENGTH = 12;

export interface BackendUsageEntry {
  id: string;
  label: string;
  /** Rendered windows, or null when this backend reported nothing. */
  plan: PlanDisplay | null;
  /** Why there is nothing to show. Absent when `plan` is set. */
  note?: string;
  /** Comparable "how much is left", present for every backend. */
  headroom: BackendHeadroom;
  /** One-line rendering of `headroom`, ready to print. */
  headroomLabel: string;
}

/**
 * One entry per exposed backend, in config order.
 *
 * Only backends already running are queried — booting one to read a
 * number would spawn a subprocess or a server per idle provider, which is
 * far more than a status command should cost.
 */
export async function collectPlanUsage(
  config: TalonConfig,
): Promise<BackendUsageEntry[]> {
  const snapshots = await collectBackendUsage(config, { force: true });
  return snapshots.map((snapshot) => {
    const plan = buildPlanDisplay(snapshot.plan, USAGE_BAR_LENGTH);
    return {
      id: snapshot.id,
      label: snapshot.label,
      plan,
      headroom: snapshot.headroom,
      headroomLabel: formatHeadroom(snapshot.headroom),
      ...(plan
        ? {}
        : { note: snapshot.note ?? "no usage information available" }),
    };
  });
}
