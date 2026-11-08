/**
 * One usage snapshot per backend — what `/usage`, the `plan_usage` tool and
 * `list_backends` all read.
 *
 * It lives in core rather than in the frontend presentation layer because
 * the gateway tools need it too, and core cannot import a frontend. The
 * split is: this module *gathers* (plan windows, headroom, and the reason
 * there is nothing to show), renderers *format*.
 *
 * Nothing here boots a backend. Reading a number should never cost a
 * subprocess per idle provider, so a backend that isn't running is listed
 * with a reason instead of being woken or omitted.
 */

import type { PlanUsage } from "../../agent-runtime/capabilities.js";
import type { TalonConfig } from "../../config/index.js";
import {
  getPooledBackend,
  listAvailableBackends,
} from "../backend-controller/index.js";
import { getBackendHeadroom, type BackendHeadroom } from "./headroom.js";

export interface BackendUsageSnapshot {
  readonly id: string;
  readonly label: string;
  /** Raw plan windows, when this backend reported any. */
  readonly plan?: PlanUsage;
  /** Always present — every backend gets a comparable headroom figure. */
  readonly headroom: BackendHeadroom;
  /** Why there is no `plan`. Absent when there is one. */
  readonly note?: string;
}

/** The reason a backend has no plan windows to show. */
function noteFor(id: string, headroom: BackendHeadroom): string {
  const backend = getPooledBackend(id);
  // An idle backend is booted transiently for the plan read (see
  // headroom.ts), so reaching here without windows means it really has none
  // to report — not that it is "not running".
  if (backend && !backend.usage?.getPlanUsage)
    return "no plan limits on this backend";
  if (headroom.source === "ledger") return "tracked against a local budget";
  if (headroom.source === "none") return "no usage information available";
  return "no usage information available";
}

/**
 * Every exposed backend, in config order, with its plan (where it has one)
 * and its headroom (always).
 *
 * `force` skips the 60s headroom cache — a person looking at `/usage` wants
 * the number now, where a routing decision a second after another one does
 * not.
 */
export async function collectBackendUsage(
  config: TalonConfig | undefined,
  options?: { force?: boolean },
): Promise<BackendUsageSnapshot[]> {
  const backends = listAvailableBackends(config);
  return Promise.all(
    backends.map(async ({ id, label }) => {
      const headroom = await getBackendHeadroom(id, label, config, options);
      if (headroom.plan && headroom.plan.windows.length > 0) {
        return { id, label, headroom, plan: headroom.plan };
      }
      return { id, label, headroom, note: noteFor(id, headroom) };
    }),
  );
}

/**
 * Reorder a snapshot list so one backend comes first, everything else
 * keeping config order. The `plan_usage` tool leads with the chat's own
 * backend so callers that only read the first entry see what they used to.
 */
export function leadWith(
  entries: BackendUsageSnapshot[],
  id: string,
): BackendUsageSnapshot[] {
  const index = entries.findIndex((e) => e.id === id);
  if (index <= 0) return entries;
  const lead = entries[index] as BackendUsageSnapshot;
  return [lead, ...entries.filter((_, i) => i !== index)];
}
