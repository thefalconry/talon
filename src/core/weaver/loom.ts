import { Thread, type ThreadSnapshot } from "./thread.js";

/**
 * The context-tracking face of the Loom — everything the gateway needs
 * to bracket turns and answer numeric-keyed queries, and nothing else.
 * The gateway depends on this interface (not the concrete Loom), so its
 * contract with the registry is explicit and a test can substitute a
 * stub without dragging in Thread creation or eviction.
 */
export interface ContextRegistry {
  /** Acquire the execution context for a turn. See `Loom.acquireContext`. */
  acquireContext(numericChatId: number, stringId?: string): Thread;
  /** Release one context hold, addressed by numeric or string id. */
  releaseContext(id: number | string): void;
  /** Count one bridge-sent message against the chat's current turn. */
  noteMessageSent(numericChatId: number): void;
  /** Messages the bridge has sent during the chat's current turn. */
  messageCount(numericChatId: number): number;
  /** Whether a turn is currently holding the chat's execution context. */
  hasActiveContext(numericChatId: number): boolean;
  /** Number of chats currently holding an execution context. */
  activeContextCount(): number;
  /** Resolve a string chat id to the numeric id of its active context. */
  numericForStringId(stringId: string): number | null;
  /** Resolve a numeric id to the string chat id of its active context. */
  stringIdForNumeric(numericChatId: number): string | null;
  /** The same, also answering after the chat's turn ended. Not for routing. */
  lastStringIdForNumeric(numericChatId: number): string | null;
  /** Number of live Threads in the registry. */
  size(): number;
}

/** Bound on remembered chat ids; the oldest is dropped first. */
const MAX_LAST_KEYS = 1024;

/**
 * Loom — the single registry of live chat Threads.
 *
 * Threads are keyed by the string chat id used throughout the engine. A
 * secondary numeric index mirrors the chats that currently hold an execution
 * context, so the gateway's HTTP bridge (which only sees numeric ids) can
 * route inbound tool calls and report active chats without owning any
 * per-chat state of its own.
 */
export class Loom implements ContextRegistry {
  private readonly threads = new Map<string, Thread>();
  private readonly byNumeric = new Map<number, Thread>();
  /** Numeric to string id of chats seen since start, kept after their turn. */
  private readonly lastKeys = new Map<number, string>();

  /** Get the Thread for a chat, creating it on first reference. */
  thread(chatId: string): Thread {
    let thread = this.threads.get(chatId);
    if (!thread) {
      thread = new Thread(chatId);
      this.threads.set(chatId, thread);
    }
    return thread;
  }

  get(chatId: string): Thread | undefined {
    return this.threads.get(chatId);
  }

  /** Evict a Thread only when it is fully idle (no queued turns, no context). */
  evict(chatId: string): boolean {
    const thread = this.threads.get(chatId);
    if (!thread || thread.busy) return false;
    if (thread.numericChatId !== undefined)
      this.byNumeric.delete(thread.numericChatId);
    return this.threads.delete(chatId);
  }

  size(): number {
    return this.threads.size;
  }

  chatIds(): string[] {
    return [...this.threads.keys()];
  }

  /** An immutable view of every live Thread. Reading is side-effect free. */
  snapshot(): ThreadSnapshot[] {
    return [...this.threads.values()].map((thread) => thread.describe());
  }

  // ── Execution context (gateway-facing; absorbed ChatContext) ────────────────

  /**
   * Acquire the execution context for a turn. Keyed by the frontend's numeric
   * chat id alongside the string id used everywhere else — for every frontend
   * `stringId ?? String(numericChatId)` equals the dispatcher's `chatId`, so a
   * first acquisition resolves to the very Thread the Weaver serializes the
   * turn on. The numeric id is indexed so the gateway can answer numeric-keyed
   * queries.
   *
   * The numeric id is the refcount identity (matching the gateway's old
   * `ChatContext`): a re-entrant acquire for a numeric that already holds a
   * context refs that same Thread, even if a later call omits or changes the
   * string id. In practice a chat's numeric↔string pairing is stable, so this
   * only matters for the re-entrant refcount.
   */
  acquireContext(numericChatId: number, stringId?: string): Thread {
    const active = this.byNumeric.get(numericChatId);
    if (active) {
      active.acquireContext(numericChatId);
      return active;
    }
    const key = stringId ?? String(numericChatId);
    const thread = this.thread(key);
    thread.acquireContext(numericChatId);
    this.byNumeric.set(numericChatId, thread);
    this.lastKeys.delete(numericChatId);
    this.lastKeys.set(numericChatId, key);
    if (this.lastKeys.size > MAX_LAST_KEYS) {
      const oldest = this.lastKeys.keys().next().value;
      if (oldest !== undefined) this.lastKeys.delete(oldest);
    }
    return thread;
  }

  /**
   * Release one context hold for a chat, addressed by numeric or string id.
   * When the last hold drops, the chat leaves the numeric index (mirroring the
   * gateway's old per-turn `ChatContext` teardown). The Thread object itself
   * stays in the registry — it still owns the serialization chain — and is
   * removed only by an explicit `evict()`.
   */
  releaseContext(id: number | string): void {
    const thread = this.resolve(id);
    if (!thread) return;
    thread.releaseContext();
    if (!thread.contextActive && thread.numericChatId !== undefined) {
      this.byNumeric.delete(thread.numericChatId);
    }
  }

  /** Count one bridge-sent message against the chat's current turn. */
  noteMessageSent(numericChatId: number): void {
    this.byNumeric.get(numericChatId)?.noteMessageSent();
  }

  /** Messages the bridge has sent during the chat's current turn. */
  messageCount(numericChatId: number): number {
    return this.byNumeric.get(numericChatId)?.messageCount ?? 0;
  }

  /** Whether a turn is currently holding the chat's execution context. */
  hasActiveContext(numericChatId: number): boolean {
    return this.byNumeric.has(numericChatId);
  }

  /** Number of chats currently holding an execution context. */
  activeContextCount(): number {
    return this.byNumeric.size;
  }

  /** Resolve a string chat id to the numeric id of its active context. */
  numericForStringId(stringId: string): number | null {
    const thread = this.threads.get(stringId);
    return thread?.contextActive ? (thread.numericChatId ?? null) : null;
  }

  /**
   * Resolve a numeric id to the string chat id of its active context — the
   * Thread key, which is the dispatcher's `chatId` (see `acquireContext`).
   * Null outside a turn: the numeric index only mirrors held contexts.
   */
  stringIdForNumeric(numericChatId: number): string | null {
    return this.byNumeric.get(numericChatId)?.chatId ?? null;
  }

  /**
   * Like `stringIdForNumeric`, but also answers after the turn ended, for
   * calls that outlive it. Not for routing: it says who a chat was, not that
   * it has a live context. Forgotten on restart.
   */
  lastStringIdForNumeric(numericChatId: number): string | null {
    return (
      this.stringIdForNumeric(numericChatId) ??
      this.lastKeys.get(numericChatId) ??
      null
    );
  }

  private resolve(id: number | string): Thread | undefined {
    if (typeof id === "number") return this.byNumeric.get(id);
    const direct = this.threads.get(id);
    if (direct) return direct;
    const asNumber = Number(id);
    return Number.isNaN(asNumber) ? undefined : this.byNumeric.get(asNumber);
  }
}
