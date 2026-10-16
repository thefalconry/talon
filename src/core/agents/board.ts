/**
 * Sub-agent blackboard and advisory leases.
 *
 * A per-chat-tree, append-only log the agents working for one chat share:
 * findings, claims, corrections and questions, plus leases — a TTL'd,
 * advisory "I am working on this resource" marker. Visibility is the same
 * boundary `message_peer` uses: the chat an agent's ancestry roots in. An
 * agent can neither read nor write another chat's board, because it never
 * names a chat — the scope is derived from its identity.
 *
 * Leases are advisory: nothing is enforced except that a second `acquire` of
 * a held resource is refused with the holder named. They are released when
 * the holder settles (registry `onSettled`) or when their TTL lapses.
 */

import type { BoardEntry, BoardKind } from "../../storage/agents/board-repo.js";
import * as boardRepo from "../../storage/agents/board-repo.js";

export type { BoardEntry };

const BOARD_POST_KINDS = [
  "finding",
  "claim",
  "correction",
  "question",
] as const;
/** Live entries kept per chat; the oldest non-lease entries drop first. */
const BOARD_CAP = 200;
/** Max bytes of one entry's text. */
const BOARD_TEXT_MAX_BYTES = 4096;
/** Posts (and lease acquires) one agent may make per window. */
const BOARD_RATE_LIMIT = 20;
export const BOARD_RATE_WINDOW_MS = 10 * 60 * 1000;
const LEASE_TTL_MAX_S = 1800;

export type BoardResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const recent = new Map<string, number[]>();

/** Charge one write against the agent's rate budget. False = over budget. */
function takeRateSlot(agentId: string, now: number): boolean {
  const stamps = (recent.get(agentId) ?? []).filter(
    (at) => now - at < BOARD_RATE_WINDOW_MS,
  );
  if (stamps.length >= BOARD_RATE_LIMIT) {
    recent.set(agentId, stamps);
    return false;
  }
  stamps.push(now);
  recent.set(agentId, stamps);
  return true;
}

/**
 * Who is writing, resolved by the caller from the registry (never from model
 * parameters): the agent, its label, and the chat key its tree roots in —
 * `null` when that chain is gone, in which case there is no board to share.
 */
export interface BoardCaller {
  readonly id: string;
  readonly label: string;
  readonly chatId: string | null;
}

const NO_TREE = {
  ok: false,
  error: "Your agent tree has no live chat to share a board with.",
} as const;

function scopeOf(who: BoardCaller): { chatId: string; label: string } | null {
  return who.chatId === null ? null : { chatId: who.chatId, label: who.label };
}

function rateError(): { readonly ok: false; readonly error: string } {
  return {
    ok: false,
    error:
      `Rate limit: at most ${BOARD_RATE_LIMIT} board writes per ` +
      `${BOARD_RATE_WINDOW_MS / 60000} minutes per agent. Batch your notes.`,
  };
}

export function post(
  who: BoardCaller,
  topic: string,
  kind: string,
  text: string,
  now: number = Date.now(),
): BoardResult<BoardEntry> {
  if (!(BOARD_POST_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      error: `Unknown kind "${kind}". Use ${BOARD_POST_KINDS.join(", ")} (leases go through the lease tool).`,
    };
  }
  const cleanTopic = topic.trim();
  if (!cleanTopic) return { ok: false, error: "Missing topic" };
  if (!text.trim()) return { ok: false, error: "Missing text" };
  if (Buffer.byteLength(text, "utf8") > BOARD_TEXT_MAX_BYTES) {
    return {
      ok: false,
      error: `Text is over ${BOARD_TEXT_MAX_BYTES} bytes. Post a summary and keep the detail in a file.`,
    };
  }
  const scope = scopeOf(who);
  if (!scope) return NO_TREE;
  if (!takeRateSlot(who.id, now)) return rateError();
  const entry: Omit<BoardEntry, "id"> = {
    chatId: scope.chatId,
    author: who.id,
    authorLabel: scope.label,
    topic: cleanTopic,
    kind: kind as BoardKind,
    text,
    createdAt: now,
  };
  const id = boardRepo.insert(entry);
  boardRepo.enforceCap(scope.chatId, now, BOARD_CAP);
  return { ok: true, value: { ...entry, id } };
}

export function read(
  who: BoardCaller,
  opts: { topic?: string; sinceId?: number } = {},
  now: number = Date.now(),
): BoardResult<BoardEntry[]> {
  const scope = scopeOf(who);
  if (!scope) return NO_TREE;
  return {
    ok: true,
    value: boardRepo.listLive(scope.chatId, now, opts.sinceId ?? 0, opts.topic),
  };
}

export type LeaseOutcome =
  | {
      readonly ok: true;
      readonly renewed?: boolean;
      readonly expiresIn: number;
    }
  | {
      readonly ok: false;
      readonly heldBy: string;
      readonly heldById: string;
      readonly expiresIn: number;
    }
  | { readonly ok: false; readonly error: string };

export function acquireLease(
  who: BoardCaller,
  resource: string,
  ttlS: number,
  now: number = Date.now(),
): LeaseOutcome {
  const name = resource.trim();
  if (!name) return { ok: false, error: "Missing resource" };
  if (!Number.isFinite(ttlS) || ttlS <= 0) {
    return { ok: false, error: "ttl_s must be a positive number of seconds" };
  }
  const ttl = Math.min(Math.floor(ttlS), LEASE_TTL_MAX_S);
  const scope = scopeOf(who);
  if (!scope) return NO_TREE;
  const held = boardRepo.findLiveLease(scope.chatId, name, now);
  if (held && held.author !== who.id) {
    return {
      ok: false,
      heldBy: held.authorLabel,
      heldById: held.author,
      expiresIn: Math.ceil(((held.expiresAt ?? now) - now) / 1000),
    };
  }
  if (!takeRateSlot(who.id, now)) return rateError();
  const expiresAt = now + ttl * 1000;
  const text = `${scope.label} holds ${name}`;
  if (held) {
    boardRepo.renewLease(held.id, expiresAt, text);
    return { ok: true, renewed: true, expiresIn: ttl };
  }
  boardRepo.insert({
    chatId: scope.chatId,
    author: who.id,
    authorLabel: scope.label,
    topic: name,
    kind: "lease",
    text,
    createdAt: now,
    expiresAt,
  });
  boardRepo.enforceCap(scope.chatId, now, BOARD_CAP);
  return { ok: true, expiresIn: ttl };
}

/** Release the caller's lease on a resource. False = it held none. */
export function releaseLease(
  who: BoardCaller,
  resource: string,
  now: number = Date.now(),
): BoardResult<boolean> {
  const scope = scopeOf(who);
  if (!scope) return NO_TREE;
  return {
    ok: true,
    value: boardRepo.releaseLease(scope.chatId, resource.trim(), who.id, now),
  };
}

export function listLeases(
  who: BoardCaller,
  now: number = Date.now(),
): BoardResult<BoardEntry[]> {
  const read_ = read(who, {}, now);
  if (!read_.ok) return read_;
  return { ok: true, value: read_.value.filter((e) => e.kind === "lease") };
}

/** Settle hook: release every lease the agent still holds. */
export function releaseLeases(
  agentId: string,
  now: number = Date.now(),
): number {
  recent.delete(agentId);
  return boardRepo.releaseAllFor(agentId, now);
}

/** Test-only. */
export function resetBoardForTest(): void {
  recent.clear();
  boardRepo.removeAll();
}
