/**
 * Shared command state + helpers.
 *
 * The admin user id (set from talon.json / TALON_ADMIN_USER_ID via
 * `setAdminUserId`) is shared across the command groups, so it lives on a
 * holder object here. `RegisterDeps` is the bundle every group's register
 * function receives.
 */

import type { Context } from "grammy";
import type { Backend } from "../../../core/agent-runtime/capabilities.js";

/** Primary admin plus explicitly configured Telegram operator IDs. */
const adminState = { adminUserIds: new Set<number>() };

/** Set the primary admin and any additional Telegram operator IDs. */
export function setAdminUserId(
  id: number | undefined,
  operatorIds: readonly string[] = [],
): void {
  if (!id) {
    adminState.adminUserIds = new Set();
    return;
  }
  adminState.adminUserIds = new Set([
    id,
    ...operatorIds.filter((value) => /^\d+$/.test(value)).map(Number),
  ]);
}

/**
 * True when the sender may run admin commands: an admin ID is configured and
 * the sender is that admin or an explicitly configured Telegram operator.
 * "No admin configured" means nobody is admin —
 * never everyone (the Telegram frontend also refuses to start without one).
 */
export function isAuthorizedAdmin(ctx: Context): boolean {
  return ctx.from !== undefined && adminState.adminUserIds.has(ctx.from.id);
}

/**
 * Same rule as `isAuthorizedAdmin`; kept as the name the irreversible
 * account actions check, so their intent stays explicit at the call site.
 */
export function isConfiguredAdmin(ctx: Context): boolean {
  return isAuthorizedAdmin(ctx);
}

export type RegisterDeps = {
  config: import("../../../core/config/index.js").TalonConfig;
  gateway?: { backend: Backend | null };
};
