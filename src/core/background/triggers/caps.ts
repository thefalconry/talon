/**
 * Per-chat trigger caps — how many watcher scripts one chat may keep active.
 *
 * Configured by `config.triggers` (see core/config) and wired in once via
 * initTriggers. The check is a pure function of the chat's active triggers so
 * the gateway handler and the tests share one rule.
 */

import { MAX_ACTIVE_PER_CHAT } from "../../../storage/triggers.js";

export type TriggerCaps = {
  /** Active triggers per chat — all of them, or only ad-hoc ones when
   *  `maxPersistentPerChat` is set. */
  readonly maxActivePerChat: number;
  /** Optional separate budget for persistent triggers. */
  readonly maxPersistentPerChat?: number;
};

export const DEFAULT_TRIGGER_CAPS: TriggerCaps = {
  maxActivePerChat: MAX_ACTIVE_PER_CHAT,
};

const capsHolder: { caps: TriggerCaps } = { caps: DEFAULT_TRIGGER_CAPS };

/** Replace the live caps. Missing fields fall back to the defaults. */
export function setTriggerCaps(caps?: Partial<TriggerCaps>): void {
  const next: TriggerCaps = {
    maxActivePerChat:
      caps?.maxActivePerChat ?? DEFAULT_TRIGGER_CAPS.maxActivePerChat,
    ...(caps?.maxPersistentPerChat !== undefined
      ? { maxPersistentPerChat: caps.maxPersistentPerChat }
      : {}),
  };
  capsHolder.caps = next;
}

export function getTriggerCaps(): TriggerCaps {
  return capsHolder.caps;
}

/**
 * Why a new trigger may not be created, or null when there is room.
 *
 * Without `maxPersistentPerChat`, every active trigger shares
 * `maxActivePerChat` (the historical behaviour). With it, persistent and
 * ad-hoc triggers draw from separate budgets.
 */
export function triggerCapError(
  active: ReadonlyArray<{ persistent?: boolean }>,
  persistent: boolean,
  caps: TriggerCaps = capsHolder.caps,
): string | null {
  const configPath = "~/.talon/config.json";
  if (caps.maxPersistentPerChat === undefined) {
    if (active.length < caps.maxActivePerChat) return null;
    return (
      `Per-chat trigger cap reached (${caps.maxActivePerChat} active). ` +
      `Cancel one before creating another, or raise ` +
      `triggers.maxActivePerChat in ${configPath}.`
    );
  }
  if (persistent) {
    const count = active.filter((t) => t.persistent === true).length;
    if (count < caps.maxPersistentPerChat) return null;
    return (
      `Per-chat persistent trigger cap reached ` +
      `(${caps.maxPersistentPerChat} persistent active). Cancel one before ` +
      `creating another, or raise triggers.maxPersistentPerChat in ${configPath}.`
    );
  }
  const count = active.filter((t) => t.persistent !== true).length;
  if (count < caps.maxActivePerChat) return null;
  return (
    `Per-chat ad-hoc trigger cap reached (${caps.maxActivePerChat} ` +
    `non-persistent active). Cancel one before creating another, or raise ` +
    `triggers.maxActivePerChat in ${configPath}.`
  );
}
