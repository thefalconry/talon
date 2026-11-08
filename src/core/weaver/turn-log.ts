/**
 * Turn log — the greppable lifecycle lines for one turn, so talon.log
 * alone can answer "what happened in that conversation":
 *
 *   turn.queued  turn=… chat=… trigger=… depth=…          (behind a running turn)
 *   turn.start   turn=… chat=… frontend=… backend=… model=… trigger=… queue=… wait_ms=…
 *   tool.start   turn=… chat=… name=… id=… args=<≤80>      (debug)
 *   tool.slow    turn=… chat=… name=… id=… running_ms=…    (still running at 60s)
 *   tool.call    turn=… chat=… name=… ms=… ok=… [bytes=…] [err=…]
 *   turn.error   turn=… chat=… class=auth|quota|timeout|tool|backend|unknown msg=…
 *   turn.end     turn=… chat=… … ms=… outcome=ok|error|aborted|timeout|refused tools=N in_tokens=…
 *
 * Every other line written during the turn carries `turn=<id>` too, via
 * the log context (util/logging/turn-scope.ts). Free text (`msg=`, `err=`) is
 * always the LAST field, collapsed to one line and capped, so the
 * key=value fields before it stay machine-parseable.
 */

import { AgentRunError, type AgentEvent } from "../agent-runtime/events.js";
import { classify, type TalonError } from "../errors.js";
import { resolveOwnerFrontendId } from "../frontend-runtime/routing.js";
import { log, logDebug, logWarn } from "../../util/log.js";

type TurnOutcome = "ok" | "error" | "aborted" | "timeout" | "refused";

type TurnErrorClass =
  "auth" | "quota" | "timeout" | "tool" | "backend" | "aborted" | "unknown";

/** A tool still running at this age gets a `tool.slow` line. */
const SLOW_TOOL_MS = 60_000;
/** Cap for free-text fields (error messages). */
const MAX_TEXT = 200;
/** Cap for the debug-level tool args preview. */
const MAX_ARGS_PREVIEW = 80;

/** One line, capped — safe to put at the end of a key=value log line. */
function oneLine(text: string, max = MAX_TEXT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function errorText(err: unknown): string {
  return oneLine(err instanceof Error ? err.message : String(err));
}

/** Serialized size of a tool result, or undefined when there is none. */
function resultBytes(result: unknown): number | undefined {
  if (result === undefined) return undefined;
  if (typeof result === "string") return Buffer.byteLength(result);
  try {
    return Buffer.byteLength(JSON.stringify(result) ?? "");
  } catch {
    return undefined;
  }
}

function argsPreview(input: unknown): string {
  try {
    return oneLine(JSON.stringify(input) ?? "", MAX_ARGS_PREVIEW);
  } catch {
    return "[unserializable]";
  }
}

type OpenToolCall = {
  name: string;
  startedAt: number;
  slowTimer: ReturnType<typeof setTimeout>;
};

/**
 * Per-turn tool-call ledger, fed by the Shuttle from the canonical
 * `tool_call` / `tool_result` events — the one place every backend's
 * tools (SDK built-ins and Talon's MCP tools alike) pass through.
 */
export class TurnToolLog {
  private readonly turnId: string;
  private readonly chatId: string;
  private readonly slowMs: number;
  private readonly open = new Map<string, OpenToolCall>();
  private calls = 0;

  constructor(turnId: string, chatId: string, slowMs = SLOW_TOOL_MS) {
    this.turnId = turnId;
    this.chatId = chatId;
    this.slowMs = slowMs;
  }

  /** Tool calls seen this turn. */
  get count(): number {
    return this.calls;
  }

  onCall(event: Extract<AgentEvent, { type: "tool_call" }>): void {
    this.calls++;
    const prefix = `turn=${this.turnId} chat=${this.chatId} name=${event.name} id=${event.id}`;
    logDebug(
      "dispatcher",
      `tool.start ${prefix} args=${argsPreview(event.input)}`,
    );
    const startedAt = Date.now();
    const slowTimer = setTimeout(() => {
      log(
        "dispatcher",
        `tool.slow ${prefix} running_ms=${Date.now() - startedAt}`,
      );
    }, this.slowMs);
    // A tool that outlives its turn must not hold the process open.
    slowTimer.unref?.();
    const previous = this.open.get(event.id);
    if (previous) clearTimeout(previous.slowTimer);
    this.open.set(event.id, { name: event.name, startedAt, slowTimer });
  }

  onResult(event: Extract<AgentEvent, { type: "tool_result" }>): void {
    const call = this.open.get(event.id);
    if (call) {
      clearTimeout(call.slowTimer);
      this.open.delete(event.id);
    }
    const ms = call ? Date.now() - call.startedAt : 0;
    const bytes = resultBytes(event.result);
    const line =
      `tool.call turn=${this.turnId} chat=${this.chatId} name=${event.name} ms=${ms} ` +
      `ok=${event.error === undefined}` +
      (bytes === undefined ? "" : ` bytes=${bytes}`);
    if (event.error === undefined) log("dispatcher", line);
    else logWarn("dispatcher", `${line} err=${oneLine(event.error)}`);
  }

  /** Turn settled: stop the slow-tool timers, note calls that never resolved. */
  close(): void {
    for (const [id, call] of this.open) {
      clearTimeout(call.slowTimer);
      logDebug(
        "dispatcher",
        `tool.unsettled turn=${this.turnId} chat=${this.chatId} name=${call.name} id=${id} ms=${Date.now() - call.startedAt}`,
      );
    }
    this.open.clear();
  }
}

/** What one turn's lifecycle lines report — filled in as the turn resolves. */
export type TurnTrace = {
  readonly turnId: string;
  readonly chatId: string;
  readonly trigger: string;
  readonly frontend: string;
  /** Turns queued or running ahead of this one when it was enqueued. */
  readonly queuedBehind: number;
  readonly enqueuedAt: number;
  readonly tools: TurnToolLog;
  startedAt?: number;
  backend?: string;
  model?: string;
  /** Why the turn was answered with a refusal instead of a backend run. */
  refused?: string;
};

function head(trace: TurnTrace): string {
  return `turn=${trace.turnId} chat=${trace.chatId}`;
}

/**
 * The trace for a turn being enqueued. `queuedBehind` is how many turns
 * the chat's FIFO already holds; when non-zero the turn has to wait, and
 * that is logged now — the wait is otherwise invisible until it starts.
 */
export function createTurnTrace(
  turnId: string,
  params: { chatId: string; source: string },
  queuedBehind: number,
): TurnTrace {
  const trace: TurnTrace = {
    turnId,
    chatId: params.chatId,
    trigger: params.source,
    frontend:
      resolveOwnerFrontendId(params.chatId, { includeNonMessaging: true }) ??
      "unknown",
    queuedBehind,
    enqueuedAt: Date.now(),
    tools: new TurnToolLog(turnId, params.chatId),
  };
  if (queuedBehind > 0) logTurnQueued(trace);
  return trace;
}

/** A turn is waiting behind others in its chat's FIFO. */
function logTurnQueued(trace: TurnTrace): void {
  log(
    "dispatcher",
    `turn.queued ${head(trace)} trigger=${trace.trigger} depth=${trace.queuedBehind}`,
  );
}

/**
 * The turn resolved its model and is about to reach the backend (or
 * refuse): bind the resolution onto the trace and write `turn.start`.
 */
export function logTurnStart(
  trace: TurnTrace,
  warp: { backendId: string; model?: string },
): void {
  trace.backend = warp.backendId;
  trace.model = warp.model;
  const waitMs = (trace.startedAt ?? trace.enqueuedAt) - trace.enqueuedAt;
  log(
    "dispatcher",
    `turn.start ${head(trace)} frontend=${trace.frontend} ` +
      `backend=${trace.backend ?? "?"} model=${trace.model ?? "none"} ` +
      `trigger=${trace.trigger} queue=${trace.queuedBehind} wait_ms=${waitMs}`,
  );
}

type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * The turn returned normally: `ok`, a refusal, or a kill the backend
 * honoured with a clean early completion.
 */
export function logTurnSettled(
  trace: TurnTrace,
  killed: boolean,
  usage: TurnUsage,
): void {
  if (killed) logTurnEnd(trace, "aborted", { usage, reason: "killed" });
  else if (trace.refused)
    logTurnEnd(trace, "refused", { usage, reason: trace.refused });
  else logTurnEnd(trace, "ok", { usage });
}

/** The single closing line of every turn, whatever its outcome. */
export function logTurnEnd(
  trace: TurnTrace,
  outcome: TurnOutcome,
  opts: { usage?: TurnUsage; reason?: string } = {},
): void {
  const ms = Date.now() - (trace.startedAt ?? trace.enqueuedAt);
  const usage = opts.usage;
  const line =
    `turn.end ${head(trace)} backend=${trace.backend ?? "?"} ` +
    `model=${trace.model ?? "none"} trigger=${trace.trigger} ms=${ms} ` +
    `outcome=${outcome} tools=${trace.tools.count}` +
    (usage
      ? ` in_tokens=${usage.inputTokens} out_tokens=${usage.outputTokens} ` +
        `cache_read=${usage.cacheRead} cache_write=${usage.cacheWrite}`
      : "") +
    (opts.reason ? ` reason=${opts.reason}` : "");
  log("dispatcher", line);
}

const AGENT_KIND_CLASS: Record<AgentRunError["kind"], TurnErrorClass> = {
  context_overflow: "backend",
  rate_limit: "quota",
  overload: "backend",
  session_expired: "backend",
  auth: "auth",
  model_unsupported: "backend",
  tool_failure: "tool",
  subprocess_exit: "backend",
  timeout: "timeout",
  aborted: "aborted",
  // Re-read through classify(): the message may still say more.
  unknown: "unknown",
};

const REASON_CLASS: Record<TalonError["reason"], TurnErrorClass> = {
  rate_limit: "quota",
  usage_limit: "quota",
  overloaded: "backend",
  network: "backend",
  auth: "auth",
  forbidden: "auth",
  context_length: "backend",
  session_expired: "backend",
  bad_request: "backend",
  telegram_api: "unknown",
  stopped: "aborted",
  unknown: "unknown",
};

/** Bucket a turn failure into the coarse class `turn.error` reports. */
export function classifyTurnError(err: unknown): TurnErrorClass {
  if (err instanceof AgentRunError && err.kind !== "unknown") {
    return AGENT_KIND_CLASS[err.kind];
  }
  if (err instanceof Error && err.name === "TimeoutError") return "timeout";
  return REASON_CLASS[classify(err).reason];
}

/**
 * A turn threw. A kill the user asked for closes as `aborted` with no
 * `turn.error` (nothing went wrong); anything else gets the classified
 * `turn.error` line, then `turn.end`.
 */
export function logTurnFailure(
  trace: TurnTrace,
  err: unknown,
  killed: boolean,
): void {
  if (killed) {
    logTurnEnd(trace, "aborted", { reason: "killed" });
    return;
  }
  const cls = classifyTurnError(err);
  logWarn(
    "dispatcher",
    `turn.error ${head(trace)} backend=${trace.backend ?? "?"} class=${cls} msg=${errorText(err)}`,
  );
  const outcome: TurnOutcome =
    cls === "timeout" ? "timeout" : cls === "aborted" ? "aborted" : "error";
  logTurnEnd(trace, outcome);
}
