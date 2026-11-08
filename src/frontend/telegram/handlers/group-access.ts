/**
 * Which Telegram groups the bot serves.
 *
 * `allowedGroups` lists them explicitly. The operator being a member of a
 * group is not, on its own, a reason to serve it: anyone can create a
 * group and add the operator and the bot to it. Installs that predate
 * `allowedGroups` keep the old membership rule so nothing goes dark on
 * upgrade, with a loud warning per group naming the id to list. Either
 * way only the operator's own messages get the full tool set — everyone
 * else in a group is guest-scoped (core/mcp-hub/guest-scope.ts).
 */

import { logWarn } from "../../../util/log.js";

/** null = `allowedGroups` not configured (legacy membership rule). */
let allowedGroupIds: ReadonlySet<number> | null = null;
const warnedLegacy = new Set<number>();

export function setAllowedGroups(ids: readonly number[] | undefined): void {
  allowedGroupIds = ids ? new Set(ids) : null;
  warnedLegacy.clear();
  if (!ids) {
    logWarn(
      "access",
      "allowedGroups is not set: Telegram groups are still admitted when the admin is a member (legacy). " +
        "List the groups the bot should serve in allowedGroups — membership alone will stop being enough. " +
        "Non-admin senders in any group only get the conversation tool set.",
    );
  }
}

/**
 * `listed` — serve it. `unlisted` — refuse it. `legacy` — no allowlist is
 * configured; the caller falls back to the admin-membership check.
 */
export function groupListing(chatId: number): "listed" | "unlisted" | "legacy" {
  if (allowedGroupIds === null) return "legacy";
  return allowedGroupIds.has(chatId) ? "listed" : "unlisted";
}

/** Once per group: it is only admitted by the legacy membership rule. */
export function warnLegacyGroup(chatId: number, title?: string): void {
  if (warnedLegacy.has(chatId)) return;
  warnedLegacy.add(chatId);
  logWarn(
    "access",
    `Group "${title ?? chatId}" [id:${chatId}] is admitted only because the admin is a member. ` +
      `Add ${chatId} to allowedGroups to keep serving it explicitly.`,
  );
}
