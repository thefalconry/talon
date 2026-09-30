/**
 * Log context — which turn a log line belongs to, carried implicitly.
 *
 * A turn fans out across the weaver, the backend adapter, the event
 * shuttle and the gateway's tool actions; threading an id through every
 * call site would touch dozens of signatures. Instead the Weaver runs
 * each turn inside an AsyncLocalStorage scope and `log.ts` appends
 * `turn=<id>` to every line written while that scope is live. One
 * `grep turn=t-…` over talon.log then reconstructs the whole turn.
 *
 * Two traps shape the API:
 *
 *   - **Stale scopes.** Async resources created during a turn (a
 *     long-lived subprocess, a timer a tool left behind) keep that turn's
 *     scope forever. A scope is therefore closed when its turn settles,
 *     and a closed scope tags nothing: a late line goes untagged rather
 *     than blamed on a turn that already ended.
 *   - **Tool actions arrive out of band.** The MCP subprocess calls the
 *     gateway over HTTP, so a tool action starts a fresh async root with
 *     no scope. The chat → open-scope map lets the gateway re-enter the
 *     chat's running turn by chat id.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/** Who a turn acts for — recorded by audits of what the turn did. */
export type TurnIssuer = {
  /** The sender's operator key, else display name; absent when unknown. */
  readonly sender?: string;
  /** What started the turn: message, cron, trigger, pulse, agent. */
  readonly source?: string;
};

export type TurnLogScope = {
  readonly turnId: string;
  readonly chatId: string;
  readonly issuer: TurnIssuer;
  /** False once the turn has settled — the scope then tags nothing. */
  open: boolean;
};

const storage = new AsyncLocalStorage<TurnLogScope>();
/** The running turn per chat (queued turns are not registered). */
const runningByChat = new Map<string, TurnLogScope>();

/** A short, greppable turn id: `t-` + 7 base36 chars. */
function mintTurnId(): string {
  return `t-${randomBytes(4).readUInt32BE(0).toString(36).padStart(7, "0")}`;
}

/** A fresh scope for a turn that has been accepted but not yet started. */
export function createTurnScope(
  chatId: string,
  issuer: TurnIssuer = {},
): TurnLogScope {
  return { turnId: mintTurnId(), chatId, issuer, open: true };
}

/**
 * Run `fn` as the chat's running turn: every log line written from its
 * async chain carries `turn=<id>` until {@link closeTurnScope}.
 */
export function runInTurnScope<T>(scope: TurnLogScope, fn: () => T): T {
  runningByChat.set(scope.chatId, scope);
  return storage.run(scope, fn);
}

/** Mark the turn settled: its scope stops tagging lines. Idempotent. */
export function closeTurnScope(scope: TurnLogScope): void {
  scope.open = false;
  if (runningByChat.get(scope.chatId) === scope) {
    runningByChat.delete(scope.chatId);
  }
}

/**
 * Run `fn` inside the running turn of the first chat id in `chatIds`
 * that has one, or plainly when none does. Used by the gateway so a
 * tool action's lines join the turn that issued it.
 */
export function runInChatTurnScope<T>(
  chatIds: readonly (string | null | undefined)[],
  fn: () => T,
): T {
  for (const chatId of chatIds) {
    const scope = chatId ? runningByChat.get(chatId) : undefined;
    if (scope?.open) return storage.run(scope, fn);
  }
  return fn();
}

/** The live turn id for the current async chain, if any. */
export function currentTurnId(): string | undefined {
  const scope = storage.getStore();
  return scope?.open ? scope.turnId : undefined;
}

/** The live turn for the current async chain — who is acting — if any. */
export function currentTurn():
  { turnId: string; chatId: string; issuer: TurnIssuer } | undefined {
  const scope = storage.getStore();
  return scope?.open
    ? { turnId: scope.turnId, chatId: scope.chatId, issuer: scope.issuer }
    : undefined;
}
