/**
 * Provision journal — what the provisioners changed, and the post-restart
 * report that documents it.
 *
 * Two small persisted pieces under ~/.talon/data/:
 *
 *  - provision-events.json — a capped rolling log of provisioning
 *    mutations ("upgraded mempalace 3.3.5 → 3.8.0", "palace wing-name
 *    migration: Migrated 3 drawer(s)."). Every action a provisioner
 *    reports lands here, whichever boot or background pass produced it.
 *
 *  - provision-report-pending.json — armed by a frontend's /update
 *    command just before the respawn. The successor process, once its
 *    frontends are serving, reads the marker and messages the chat that
 *    asked for the update with whatever provisioning changed during the
 *    new boot — closing the loop that the pre-restart reply can't see.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirs } from "../../util/paths.js";
import { log, logWarn } from "../../util/log.js";
import type { NativePluginId } from "./native-runtimes.js";

interface ProvisionEvent {
  at: string;
  plugin: NativePluginId;
  action: string;
}

interface PendingReport {
  frontend: string;
  target: string;
  since: string;
}

const EVENT_CAP = 50;
const eventsPath = (): string => join(dirs.data, "provision-events.json");
const pendingPath = (): string =>
  join(dirs.data, "provision-report-pending.json");

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

/** Append provisioning mutations to the rolling event log. */
export function recordProvisionEvents(
  plugin: NativePluginId,
  actions: readonly string[],
): void {
  if (actions.length === 0) return;
  const existing = readJson<ProvisionEvent[]>(eventsPath());
  const at = new Date().toISOString();
  const events = [
    ...(Array.isArray(existing) ? existing : []),
    ...actions.map((action) => ({ at, plugin, action })),
  ].slice(-EVENT_CAP);
  try {
    writeFileSync(eventsPath(), JSON.stringify(events, null, 2));
  } catch {
    /* the journal is reporting, never load-bearing */
  }
}

/** Events recorded at or after the given ISO timestamp. */
function provisionEventsSince(sinceIso: string): ProvisionEvent[] {
  const events = readJson<ProvisionEvent[]>(eventsPath());
  if (!Array.isArray(events)) return [];
  return events.filter((e) => e.at >= sinceIso);
}

/**
 * Arm the post-restart report. Called by a frontend's /update handler
 * right before the respawn, with the chat that asked for the update.
 */
export function armProvisionReport(frontend: string, target: string): void {
  try {
    writeFileSync(
      pendingPath(),
      JSON.stringify({
        frontend,
        target,
        since: new Date().toISOString(),
      } satisfies PendingReport),
    );
  } catch {
    /* losing the report loses a courtesy message, nothing more */
  }
}

const DELIVER_ATTEMPTS = 60;
const DELIVER_DELAY_MS = 15_000;

/**
 * Background reconcile tasks still running (a version upgrade, a docker
 * pull). The post-update report waits for them: their actions are the
 * changes worth reporting, and they settle minutes after boot.
 */
let backgroundInFlight = 0;

/** Track a background provisioning task until it settles (including its journaling). */
export function trackBackgroundProvision<T>(task: Promise<T>): Promise<T> {
  backgroundInFlight++;
  return task.finally(() => {
    backgroundInFlight--;
  });
}

/**
 * Background reconcile tasks still running. Read by tests through a
 * dynamic import, which knip cannot follow.
 * @public
 */
export function backgroundProvisionInFlight(): number {
  return backgroundInFlight;
}

/**
 * Deliver the pending report, if one is armed and this boot's
 * provisioning changed something. Waits for the boot's background
 * reconcile tasks to settle before reading the journal, so the report
 * covers what they did rather than a snapshot taken while pip was still
 * running, and retries the send because it races frontend registration
 * on the cross-send broker. Bounded (~15 minutes, matching the longest
 * provisioner timeout), then gives up quietly — this is a courtesy
 * message, not state. Returns immediately when nothing is pending and
 * nothing changed.
 */
export async function deliverPendingProvisionReport(
  send: (frontend: string, target: string, text: string) => Promise<boolean>,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms).unref?.()),
): Promise<void> {
  const pending = readJson<PendingReport>(pendingPath());
  if (!pending?.frontend || !pending.target || !pending.since) return;
  // Consume the marker up front so a crashy boot can't replay a stale
  // report later; the wait loop below keeps it alive in memory.
  try {
    rmSync(pendingPath(), { force: true });
  } catch {
    /* already gone is fine */
  }

  for (let attempt = 1; attempt <= DELIVER_ATTEMPTS; attempt++) {
    // Report only once the background work is done — or, on the last
    // attempt, whatever has landed so far rather than nothing.
    const settled = backgroundInFlight === 0 || attempt === DELIVER_ATTEMPTS;
    if (settled) {
      const events = provisionEventsSince(pending.since);
      if (events.length === 0 && backgroundInFlight === 0) return;
      if (events.length > 0) {
        const lines = events.map((e) => `• ${e.plugin}: ${e.action}`);
        const text = `♻️ Back online. Provisioning changes during the update:\n${lines.join("\n")}`;
        try {
          if (await send(pending.frontend, pending.target, text)) {
            log(
              "plugin",
              `Post-update provision report delivered (${events.length} change${events.length === 1 ? "" : "s"})`,
            );
            return;
          }
        } catch {
          /* fall through to retry */
        }
      }
    }
    if (attempt < DELIVER_ATTEMPTS) await sleep(DELIVER_DELAY_MS);
  }
  logWarn(
    "plugin",
    `Post-update provision report not delivered (${pending.frontend} unavailable or provisioning still running)`,
  );
}
