/**
 * Claude SDK session compaction — the `compactChat` slot behind the
 * Weaver's idle compaction (core/weaver/idle-compact.ts,
 * docs/cache-economics.md PR C).
 *
 * Resumes the chat's SDK session — or, with `fork`, a fork of it
 * (`forkSession: true`: the CLI copies the transcript under a new session
 * id and the chat's own session is never written) — and runs the CLI's
 * own `/compact` slash command on it (registered with
 * `supportsNonInteractive: true`, so it runs under the SDK exactly as in a
 * terminal). The CLI summarizes the transcript and writes a
 * `compact_boundary` (`trigger: 'manual'`, `pre_tokens` / `post_tokens`);
 * every later resume of that session loads the compacted context.
 *
 * Same prefix as a chat turn, so the pass's request reads the chat's
 * cache instead of re-writing it: the same options builder
 * (`buildSdkOptions`, same system prompt via `prepareChatSystemPrompt`),
 * the model the last turn ran on, and the same wait for the frontend's
 * MCP server the turn handler does — a pass that raced ahead of it would
 * send a different tool list, and miss.
 *
 * Streaming-input mode, so the command list can be checked BEFORE the
 * command is sent: a CLI without `/compact` would otherwise receive the
 * text as an ordinary user message and answer it as a turn. Absent →
 * `unsupported`.
 *
 * Never throws: every failure comes back as a `failed` (or `aborted`)
 * result and the session is left as it was — the CLI only rewrites it
 * once the summary is in, which is the boundary. A fork pass that does
 * not end `compacted` (aborted — at any point, a fork is always
 * abortable — failed, timed out) deletes the fork it made. Writes nothing to
 * Talon's session store — the result carries what changed and the Weaver
 * records it (backend code adds no new store importers; see the
 * `backend-sessions-move-to-thread` boundary).
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { deleteSession, query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  SessionCompactOptions,
  SessionCompactResult,
} from "../../../core/agent-runtime/capabilities.js";
import { log, logWarn } from "../../../util/log.js";
import { frontendsForChat } from "../../runtime/frontends.js";
import { recordCompactBoundary } from "../../runtime/cache/cache-metrics.js";
import {
  buildSdkOptions,
  getActiveFrontends,
  prepareChatSystemPrompt,
} from "../options.js";
import { waitForMcpServersReady } from "../mcp-ready.js";
import { isCompactBoundary, isResult } from "../stream.js";
import { getConfig } from "../state.js";
import {
  DEFAULT_CLAUDE_ACCOUNT,
  type ClaudeRunAccount,
} from "../accounts/account.js";

/** The CLI's compaction slash command, without the slash. */
const COMPACT_COMMAND = "compact";

/** Default hard cap on one compaction pass. A big transcript is one long model call. */
const DEFAULT_COMPACT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * After the boundary lands, how long to wait for the closing `result`
 * before tearing the subprocess down anyway — the compaction is already on
 * disk by then.
 */
const POST_BOUNDARY_GRACE_MS = 10_000;

/**
 * A warm pass should read the transcript from cache, not write it. More
 * than this fraction of `pre_tokens` written = the prefix did not match
 * the chat's turns (a cache miss) — logged, because then the warm path is
 * paying a full cold write early instead of saving one.
 */
const CACHE_MISS_WRITE_FRACTION = 0.05;

/** What the stream said, folded as messages arrive. */
type CompactStreamState = {
  boundary?: { pre: number; post?: number };
  sessionId?: string;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd?: number;
  };
};

/**
 * Fold one SDK message into the pass state. Exported for tests: the
 * decisions (boundary → compacted, failed status → error, result usage →
 * billed) are the part worth pinning without a subprocess.
 */
export function foldCompactMessage(
  state: CompactStreamState,
  msg: SDKMessage,
): "continue" | "done" {
  const sid = (msg as { session_id?: unknown }).session_id;
  if (typeof sid === "string" && sid) state.sessionId = sid;
  if (isCompactBoundary(msg)) {
    const meta = msg.compact_metadata;
    state.boundary = {
      pre: Number.isFinite(meta.pre_tokens) ? meta.pre_tokens : 0,
      ...(typeof meta.post_tokens === "number" &&
      Number.isFinite(meta.post_tokens)
        ? { post: meta.post_tokens }
        : {}),
    };
    return "continue";
  }
  if (
    msg.type === "system" &&
    msg.subtype === "status" &&
    msg.compact_result === "failed"
  ) {
    state.error = msg.compact_error || "compaction failed";
    return "continue";
  }
  if (isResult(msg)) {
    const u = msg.usage;
    state.usage = {
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      cacheRead: u?.cache_read_input_tokens ?? 0,
      cacheWrite: u?.cache_creation_input_tokens ?? 0,
      ...(typeof msg.total_cost_usd === "number"
        ? { costUsd: msg.total_cost_usd }
        : {}),
    };
    if (msg.is_error && !state.boundary && !state.error) {
      state.error =
        ("errors" in msg && Array.isArray(msg.errors) && msg.errors[0]) ||
        `compaction ended with ${msg.subtype}`;
    }
    return "done";
  }
  return "continue";
}

/** A promise with its resolver on the outside; opening twice is a no-op. */
function gate<T>(): { promise: Promise<T>; open: (value: T) => void } {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** `promise`, or a rejection the moment `signal` aborts (the pass timer). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The `/compact` user message, in the SDK's streaming-input shape. */
function compactUserMessage(): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: `/${COMPACT_COMMAND}` },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

/**
 * Compact one chat's SDK session (or a fork of it). See the module
 * comment; the shape of the answer is `SessionCompactResult`.
 */
export async function compactChatSession(
  chatId: string,
  opts: SessionCompactOptions = {},
  account: ClaudeRunAccount = DEFAULT_CLAUDE_ACCOUNT,
): Promise<SessionCompactResult> {
  try {
    getConfig();
  } catch {
    return { status: "failed", error: "Claude backend not initialised" };
  }
  if (opts.signal?.aborted) return { status: "aborted" };
  const abort = new AbortController();
  const frontend = frontendsForChat(chatId, getActiveFrontends())[0];
  // `buildSdkOptions` sets `resume` from the chat's stored session — the
  // same handle, options and prompt the next turn resumes with.
  const { options } = buildSdkOptions(
    chatId,
    abort,
    opts.modelId,
    prepareChatSystemPrompt(chatId, frontend),
    account,
  );
  if (!options.resume) {
    return { status: "skipped", reason: "no session to resume" };
  }
  const sourceSessionId = options.resume;
  if (opts.fork) options.forkSession = true;

  // Streaming input, held open by two gates: `command` releases the one
  // user message (or nothing, when the pass is abandoned), `done` closes the
  // stream once the pass is over — closing it early would end the CLI's
  // read loop before the command has run. Both are created eagerly: the
  // SDK starts pulling from the iterable on its own schedule.
  const command = gate<SDKUserMessage | null>();
  const done = gate<void>();
  abort.signal.addEventListener("abort", () => {
    command.open(null);
    done.open();
  });
  const input = (async function* (): AsyncGenerator<SDKUserMessage> {
    const msg = await command.promise;
    if (msg) yield msg;
    await done.promise;
  })();

  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMPACT_TIMEOUT_MS;
  const stop = { timedOut: false, aborted: false };
  const timer = setTimeout(() => {
    stop.timedOut = true;
    abort.abort();
  }, timeoutMs);
  timer.unref?.();
  const state: CompactStreamState = {};
  /** The fork's id once the stream named one (not the chat's own session). */
  const forkId = (): string | undefined =>
    opts.fork && state.sessionId && state.sessionId !== sourceSessionId
      ? state.sessionId
      : undefined;
  // The caller's abort (a turn arrived): kills the subprocess. For an
  // in-place pass it is ignored once the boundary is in — the chat's own
  // session has been compacted, the pass only waits for its closing
  // `result`. A fork is always abortable: the turn would discard it.
  const onCallerAbort = () => {
    if (state.boundary && !forkId()) return;
    stop.aborted = true;
    abort.abort();
  };
  opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const startedAt = Date.now();
  let unsupported: SessionCompactResult | undefined;
  try {
    // Inside the try: a synchronous throw from `query()` still clears the
    // timer and the caller's listener below.
    const q = query({ prompt: input, options });
    unsupported = await runCompactCommand(q, state, abort, {
      frontend,
      send: () => command.open(compactUserMessage()),
      onBoundary: opts.onBoundary,
      onRequestSent: opts.onRequestSent,
    });
  } catch (err) {
    // An abort after the boundary is the grace timer closing a CLI that
    // never sent `result` — the compaction itself landed.
    if (!state.boundary && !stop.timedOut && !stop.aborted) {
      state.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
    abort.abort();
  }
  const out = finish(chatId, state, stop, {
    unsupported,
    fork: opts.fork === true,
    forked: forkId() !== undefined,
    timeoutMs,
    durationMs: Date.now() - startedAt,
  });
  // A fork nobody will resume: delete it on every exit but `compacted`.
  const orphan = forkId();
  if (orphan && out.status !== "compacted") {
    await discardCompactedSession(orphan, account);
  }
  return out;
}

/** The pass's answer, from the folded state and why it stopped. */
function finish(
  chatId: string,
  state: CompactStreamState,
  stop: { timedOut: boolean; aborted: boolean },
  ctx: {
    unsupported: SessionCompactResult | undefined;
    fork: boolean;
    forked: boolean;
    timeoutMs: number;
    durationMs: number;
  },
): SessionCompactResult {
  if (ctx.unsupported) return ctx.unsupported;
  if (stop.aborted && (!state.boundary || ctx.forked)) {
    log("agent", `[${chatId}] idle compaction aborted: a turn arrived`);
    return { status: "aborted" };
  }
  if (!state.boundary && stop.timedOut) {
    state.error = `timed out after ${ctx.timeoutMs}ms`;
  }
  if (ctx.fork && state.boundary && !ctx.forked) {
    // The CLI ignored `forkSession` and compacted the chat's own session:
    // report it without a fork id, so the caller records an in-place pass.
    logWarn("agent", `[${chatId}] idle compaction: fork not honoured`);
    delete state.sessionId;
  }
  return settle(chatId, state, ctx.durationMs, ctx.forked);
}

/**
 * Check `/compact` exists, wait for the frontend's MCP server like a turn
 * does, send the command and fold the reply. Returns an `unsupported`
 * result when the CLI has no `/compact`; throws what the stream throws.
 */
async function runCompactCommand(
  q: ReturnType<typeof query>,
  state: CompactStreamState,
  abort: AbortController,
  step: {
    frontend: string | undefined;
    /** Release the `/compact` user message into the input stream. */
    send: () => void;
    onBoundary?: () => void;
    /** The `/compact` message is out: the pass is in flight (billed). */
    onRequestSent?: () => void;
  },
): Promise<SessionCompactResult | undefined> {
  const { frontend } = step;
  const commands = await untilAborted(q.supportedCommands(), abort.signal);
  if (!commands.some((c) => c.name === COMPACT_COMMAND)) {
    return {
      status: "unsupported",
      reason: "the Claude CLI does not offer /compact",
    };
  }
  // Exactly the turn handler's gate: the tool list is part of the cached
  // prefix, so the pass must not run before the frontend's tools connect.
  if (frontend) {
    await waitForMcpServersReady(q, [`${frontend}-tools`], 5_000, 100);
  }
  if (abort.signal.aborted) throw new Error("aborted");
  step.send();
  step.onRequestSent?.();
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    for await (const msg of q) {
      if (foldCompactMessage(state, msg) === "done") break;
      if (state.boundary && !graceTimer) {
        step.onBoundary?.();
        // The compaction is on disk; give the CLI a moment to close the
        // turn with `result` (it carries the billed usage), then stop.
        graceTimer = setTimeout(() => abort.abort(), POST_BOUNDARY_GRACE_MS);
        graceTimer.unref?.();
      }
    }
  } finally {
    if (graceTimer) clearTimeout(graceTimer);
  }
  return undefined;
}

/**
 * Delete a forked session nobody resumed (a discarded precompute, or a
 * pass that ended without a compaction). Best-effort: a stray transcript
 * file is harmless.
 *
 * The default account goes through the SDK's `deleteSession`, which reads
 * the daemon's own config dir. An extra account's CLI ran with
 * `CLAUDE_CONFIG_DIR=<configDir>`, so its transcripts live under
 * `<configDir>/projects/<project>/` — the SDK's layout, removed the way
 * the SDK removes one (`<id>.jsonl` plus the `<id>/` sidecar directory).
 */
export async function discardCompactedSession(
  sessionId: string,
  account: ClaudeRunAccount = DEFAULT_CLAUDE_ACCOUNT,
): Promise<void> {
  try {
    if (account.configDir) {
      await deleteAccountSession(account.configDir, sessionId);
      return;
    }
    const cwd = getConfig().workspace;
    await deleteSession(sessionId, cwd ? { dir: cwd } : undefined);
  } catch (err) {
    logWarn(
      "agent",
      `idle compaction: could not delete forked session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** A session id is one path segment — never a path. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** `deleteSession` for a non-default `CLAUDE_CONFIG_DIR`. */
async function deleteAccountSession(
  configDir: string,
  sessionId: string,
): Promise<void> {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`invalid session id ${JSON.stringify(sessionId)}`);
  }
  const projects = join(configDir, "projects");
  let dirs: string[];
  try {
    dirs = await readdir(projects);
  } catch {
    return; // no transcripts at all
  }
  for (const dir of dirs) {
    const file = join(projects, dir, `${sessionId}.jsonl`);
    try {
      await stat(file);
    } catch {
      continue;
    }
    await rm(file, { force: true });
    await rm(join(projects, dir, sessionId), { recursive: true, force: true });
    return;
  }
}

/**
 * Turn the folded stream state into the result. Session-store writes (the
 * new context fill, the pass's billed usage, a changed session id) are the
 * caller's: the result carries them, the Weaver records them.
 */
function settle(
  chatId: string,
  state: CompactStreamState,
  durationMs: number,
  forked: boolean,
): SessionCompactResult {
  if (!state.boundary) {
    const error = state.error ?? "no compact boundary in the reply";
    logWarn("agent", `[${chatId}] idle compaction failed: ${error}`);
    return { status: "failed", error };
  }
  const { pre, post } = state.boundary;
  // Only a compaction of the chat's own session is one. A fork is a
  // precompute the next turn may still discard; the Weaver records it as a
  // compaction if and when it adopts the fork (idle-compact.ts beforeTurn).
  if (!forked) {
    recordCompactBoundary(chatId, {
      trigger: "manual",
      pre_tokens: pre,
      ...(post !== undefined ? { post_tokens: post } : {}),
    });
  }
  const cache = state.usage
    ? ` (cache read ${state.usage.cacheRead}, write ${state.usage.cacheWrite})`
    : "";
  log(
    "agent",
    `[${chatId}] idle compaction: ${pre} -> ${post ?? "?"} tokens in ${durationMs}ms${cache}`,
  );
  if (state.usage && state.usage.cacheWrite > pre * CACHE_MISS_WRITE_FRACTION) {
    logWarn(
      "agent",
      `[${chatId}] idle compaction missed the cache: wrote ${state.usage.cacheWrite} of ${pre} tokens ` +
        `(> ${CACHE_MISS_WRITE_FRACTION * 100}%) — the pass's prefix did not match the chat's last request`,
    );
  }
  return {
    status: "compacted",
    preTokens: pre,
    ...(post !== undefined ? { postTokens: post } : {}),
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    ...(state.usage ? { usage: state.usage } : {}),
  };
}
