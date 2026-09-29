/**
 * Weaver — the turn orchestrator. `runTurn` serializes each turn onto
 * its chat's Thread (per-chat FIFO, cross-chat parallel) and drives the
 * turn lifecycle by composing the weaver's single-purpose collaborators:
 *
 *   - `resolveWarp` (warp-resolver.ts) — model/backend binding + the
 *     null-model guard and per-run override fallback;
 *   - `startTypingLoop` (typing-loop.ts) — keeps the frontend's typing
 *     indicator alive for the duration of the turn;
 *   - `carryTurnEvents` (shuttle.ts) — pumps the backend's AgentEvent
 *     stream into the frontend sink, settles delivery acks, captures
 *     the result and rethrows error terminators.
 *
 * The Weaver itself only sequences those stages and brackets them with
 * the Thread's execution context — it holds no per-chat state (that's
 * the Thread's) and no policy of its own beyond ordering.
 */

import { randomBytes } from "node:crypto";
import type { Backend } from "../agent-runtime/capabilities.js";
import type { AgentResult } from "../agent-runtime/events.js";
import type { ModelRef } from "../agent-runtime/model-ref.js";
import type { ContextManager, ExecuteParams, ExecuteResult } from "../types.js";
import { bus } from "../bus/index.js";
import { taskTable, type TaskHandle } from "../tasks/index.js";
import { log, logDebug, logWarn } from "../../util/log.js";
import { recordHistogram } from "../../storage/metrics.js";
import { recordSessionTurnPhases } from "../../storage/sessions.js";
import type { TurnPhase } from "../../storage/session-record.js";
import { retrieveForTurn, type TurnMemory } from "../memory/turn-retrieval.js";
import { TalonError } from "../errors.js";
import { backendEnforcesGuestScope } from "../agent-runtime/backend-registry.js";
import {
  enterTurnScope,
  resolveTurnScope,
  scopePrompt,
} from "../mcp-hub/guest-scope.js";
import { Loom } from "./loom.js";
import { carryTurnEvents, startShuttleTiming } from "./shuttle.js";
import type { Thread, ThreadSnapshot } from "./thread.js";
import { startTurnCpu } from "./turn-cpu.js";
import { startTypingLoop } from "./typing-loop.js";
import { resolveWarp } from "./warp-resolver.js";
import {
  createTurnTrace,
  logTurnEnd,
  logTurnFailure,
  logTurnSettled,
  logTurnStart,
  type TurnTrace,
} from "./turn-log.js";
import {
  closeTurnScope,
  createTurnScope,
  runInTurnScope,
} from "../../util/logging/turn-scope.js";

export type WeaverDeps = {
  /**
   * Read fresh per call so backend swaps (chat-role rebinds or
   * per-chat overrides via the controller) take effect on the next
   * query without a dispatcher re-init.
   */
  getBackend: (chatId?: string) => Backend;
  resolveActiveModel: (chatId: string) => Promise<{
    model: string | null;
    ref: ModelRef | null;
    backendId: string;
  }>;
  resolveModelOverride?: (
    chatId: string,
    modelId: string,
  ) => Promise<ModelRef | null>;
  context: ContextManager;
  sendTyping: (chatId: number, stringId?: string) => Promise<void>;
};

export class Weaver {
  readonly loom: Loom;
  private readonly deps: WeaverDeps;
  private activeCount = 0;

  constructor(deps: WeaverDeps, loom = new Loom()) {
    this.deps = deps;
    this.loom = loom;
  }

  runTurn(params: ExecuteParams): Promise<ExecuteResult> {
    const thread = this.loom.thread(params.chatId);
    // A turn is killable when its backend can interrupt an in-flight
    // chat turn. The abort hook tracks lifecycle through this closure:
    // before the turn starts, a kill just marks it (run() then refuses to
    // start); once running, the kill signals the backend — which stops
    // the turn cleanly per the interruptChatTurn contract. The started
    // guard matters in a queue: killing a queued turn must never
    // interrupt the same chat's currently running one.
    const chat = this.deps.getBackend(params.chatId).chat;
    const interrupt = chat?.interruptChatTurn?.bind(chat);
    const lifecycle = { started: false, killed: false, enqueuedAt: Date.now() };
    // The turn id is minted at enqueue so a queued turn's wait is already
    // attributable; the log scope goes live when the turn starts running.
    const scope = createTurnScope(params.chatId, {
      sender: params.senderKeys?.[0] ?? (params.senderName || undefined),
      source: params.source,
    });
    const trace = createTurnTrace(scope.turnId, params, thread.inFlightCount);
    // Registered before enqueueing so a turn waiting in its chat's FIFO is
    // visible as `queued` in the task table, not invisible until it runs.
    const task = taskTable.enqueue({
      kind: "turn",
      label: params.source,
      chatId: params.chatId,
      ...(interrupt
        ? {
            abort: () => {
              lifecycle.killed = true;
              if (lifecycle.started) void interrupt(params.chatId);
            },
          }
        : {}),
    });
    return thread.enqueue(() =>
      runInTurnScope(scope, () =>
        this.run(thread, params, task, lifecycle, trace),
      ).finally(() => closeTurnScope(scope)),
    );
  }

  /** Number of turns currently running (not queued) across all chats. */
  getActiveCount(): number {
    return this.activeCount;
  }

  /**
   * A live view of every Thread the Loom is holding — the hub's
   * observability surface for `/status`, drift detection, and remote
   * frontends. Reading is side-effect free.
   */
  snapshot(): ThreadSnapshot[] {
    return this.loom.snapshot();
  }

  private async run(
    thread: Thread,
    params: ExecuteParams,
    task: TaskHandle,
    lifecycle: { started: boolean; killed: boolean; enqueuedAt: number },
    trace: TurnTrace,
  ): Promise<ExecuteResult> {
    if (lifecycle.killed) {
      // Killed while queued — the turn never reaches the backend. The
      // caller still gets a resolved (empty) result; nothing is delivered
      // to the chat, which is the point of the kill.
      task.fail(new Error("killed while queued"));
      logTurnEnd(trace, "aborted", { reason: "killed-while-queued" });
      return this.emptyResult("Turn killed before it started.", params);
    }
    lifecycle.started = true;
    trace.startedAt = Date.now();
    this.activeCount++;
    task.start();
    try {
      const result = await this.executeInner(
        thread,
        params,
        task,
        { queueWait: Date.now() - lifecycle.enqueuedAt },
        trace,
      );
      const usage = {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheRead: result.cacheRead,
        cacheWrite: result.cacheWrite,
      };
      if (lifecycle.killed) {
        // The interrupt landed and the backend closed the turn early but
        // cleanly — that IS the interrupt contract, so the stream ends as
        // a completion, not an error. The task still settles as killed
        // (the truthful outcome of `talon kill`), usage included; the
        // partial result flows back to the caller for normal handling.
        task.fail(new Error("interrupted by kill"), usage);
      } else {
        task.succeed(usage);
      }
      logTurnSettled(trace, lifecycle.killed, usage);
      return result;
    } catch (err) {
      task.fail(err);
      logTurnFailure(trace, err, lifecycle.killed);
      if (lifecycle.killed) {
        // The backend didn't manage a clean interrupt-completion (some
        // SDK versions surface an interrupted turn as an error result).
        // The user asked for this outcome — don't let it unwind as a
        // fault the frontend then reports to the chat.
        throw new TalonError("Turn stopped by user", {
          reason: "stopped",
          cause: err,
        });
      }
      throw err;
    } finally {
      this.activeCount--;
      trace.tools.close();
    }
  }

  private async executeInner(
    thread: Thread,
    params: ExecuteParams,
    task: TaskHandle,
    phases: Partial<Record<TurnPhase, number>>,
    trace: TurnTrace,
  ): Promise<ExecuteResult> {
    const { context } = this.deps;
    const backend = this.deps.getBackend(params.chatId);
    const reqId = randomBytes(4).toString("hex");

    const warpStartedAt = Date.now();
    const warp = await resolveWarp(this.deps, {
      chatId: params.chatId,
      modelOverride: params.modelOverride,
      source: params.source,
      reqId,
    });
    phases.warpResolve = Date.now() - warpStartedAt;
    logTurnStart(trace, {
      backendId: warp.backendId,
      model: warp.ok ? warp.ref.id : undefined,
    });
    if (!warp.ok) {
      trace.refused = "no-model";
      await deliverRefusal(params, warp.message, "no-model");
      return this.emptyResult(warp.message, params);
    }

    // Tool scope is decided per sender: a non-operator gets the guest
    // surface, and a backend that can't enforce it doesn't get the turn.
    const scope = resolveTurnScope(params);
    if (scope === "guest" && !backendEnforcesGuestScope(backend.id)) {
      logWarn(
        "dispatcher",
        `[${reqId}] guest-scoped turn refused chat=${params.chatId}: backend "${backend.id}" cannot enforce the guest tool scope`,
      );
      trace.refused = "guest-scope";
      await deliverRefusal(params, GUEST_BACKEND_REFUSAL, "guest-scope");
      return this.emptyResult(GUEST_BACKEND_REFUSAL, params);
    }

    // Bind the warp — record the model/backend actually resolved for this turn
    // on the Thread. `weaver.snapshot()` reports it, and a change since the
    // last turn (per-chat rebind, per-run override, or config drift) is logged
    // rather than passing silently.
    const { drifted, previous } = thread.bindWarp({
      model: warp.ref.id,
      backendId: warp.backendId,
      overridden: warp.overridden,
      boundAt: Date.now(),
    });
    task.bind({ model: warp.ref.id, backendId: warp.backendId });
    if (drifted && previous) {
      logDebug(
        "dispatcher",
        `[${reqId}] warp drift chat=${params.chatId}: ${previous.backendId}/${previous.model} → ${warp.backendId}/${warp.ref.id}`,
      );
    }

    // Turn-start signal — dream (and anything else the composition root
    // subscribes) keys off this. Fires only for turns that actually reach
    // the backend: the no-model refusal above returns before this point.
    bus.publish({
      type: "turn.started",
      chatId: params.chatId,
      source: params.source,
      model: warp.ref.id,
      backendId: warp.backendId,
    });

    logDebug(
      "dispatcher",
      `[${reqId}] ${params.source} chat=${params.chatId} started (active=${this.activeCount})`,
    );
    context.acquire(params.numericChatId, params.chatId);
    const releaseScope = enterTurnScope(params.chatId, scope);
    const stopTyping = startTypingLoop(
      this.deps.sendTyping,
      params.numericChatId,
      params.chatId,
    );
    try {
      if (!backend.chat) {
        throw new Error(
          `Backend "${backend.id}" has no chat capability — cannot run a turn.`,
        );
      }

      const memory = resolveTurnMemory(params, phases);
      const stream = backend.chat.runChatTurn({
        chatId: params.chatId,
        model: warp.ref,
        text: scopePrompt(scope, params.prompt),
        senderName: params.senderName,
        senderHandle: params.senderHandle,
        isGroup: params.isGroup,
        messageId: params.messageId,
        retrievedMemory: memory?.text,
      });
      const timing = startShuttleTiming();
      // CPU and wall clock over the same bracket, so `turn.cpu_ms` can be
      // divided by `turn.stream_ms` (see turn-cpu.ts). Recorded on the
      // same path `phases.stream` is, so both cover one population.
      const stopCpu = startTurnCpu();
      const streamStartedAt = Date.now();
      const agentResult = await carryTurnEvents(
        stream,
        params.onEvent,
        timing,
        trace.tools,
      );
      phases.stream = Date.now() - streamStartedAt;
      stopCpu();
      phases.delivery = timing.deliveryMs;
      if (timing.firstEventAt !== undefined) {
        phases.firstToken = timing.firstEventAt - streamStartedAt;
      }
      recordSessionTurnPhases(params.chatId, phases);

      // Completion signal — pulse (and any other liveness subscriber) keys
      // off this. Failures throw past it; refusals never get this far.
      bus.publish({
        type: "turn.completed",
        chatId: params.chatId,
        source: params.source,
        durationMs: agentResult?.durationMs ?? 0,
        inputTokens: agentResult?.usage.inputTokens ?? 0,
        outputTokens: agentResult?.usage.outputTokens ?? 0,
      });
      logDebug(
        "dispatcher",
        `[${reqId}] completed in ${agentResult?.durationMs ?? 0}ms ` +
          `(in=${agentResult?.usage.inputTokens ?? 0} out=${agentResult?.usage.outputTokens ?? 0}) ` +
          formatPhases(phases),
      );

      return this.toExecuteResult(agentResult, params);
    } finally {
      stopTyping();
      releaseScope();
      context.release(params.numericChatId, params.chatId);
    }
  }

  private toExecuteResult(
    result: AgentResult | undefined,
    params: ExecuteParams,
  ): ExecuteResult {
    return {
      text: result?.text ?? "",
      durationMs: result?.durationMs ?? 0,
      inputTokens: result?.usage.inputTokens ?? 0,
      outputTokens: result?.usage.outputTokens ?? 0,
      cacheRead: result?.usage.cacheRead ?? 0,
      cacheWrite: result?.usage.cacheWrite ?? 0,
      bridgeMessageCount: this.deps.context.getMessageCount(
        params.numericChatId,
        params.chatId,
      ),
    };
  }

  private emptyResult(text: string, params: ExecuteParams): ExecuteResult {
    return {
      text,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: this.deps.context.getMessageCount(
        params.numericChatId,
        params.chatId,
      ),
    };
  }
}

const GUEST_BACKEND_REFUSAL =
  "I can't answer this here: messages from anyone but the operator run with a " +
  "limited tool set, and this chat's current model backend can't enforce it. " +
  "The operator can switch this chat to a backend that does (Claude).";

/**
 * Refusals are delivered through the same event sink the backend would use
 * for output (as an `assistant_message` event, so the frontend delivers it
 * normally).
 */
async function deliverRefusal(
  params: ExecuteParams,
  text: string,
  kind: string,
): Promise<void> {
  try {
    await params.onEvent?.({ type: "assistant_message", text });
  } catch (err) {
    logWarn(
      "dispatcher",
      `onEvent(${kind}) threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * This turn's retrieved memory (`core/memory/turn-retrieval.ts`) — off
 * unless `TALON_MEMORY_STORE=1`, fail-closed, and a pure read: nothing
 * here may invalidate the frozen system prompt (plan §3.6), because the
 * block travels in the USER turn, after all cached history.
 *
 * The size goes out as `turn.memory_chars` on every turn, zero
 * included, so the flag's before/after populations are comparable next
 * to `prompt.memory_chars` (the static core-view tier from #943).
 */
function resolveTurnMemory(
  params: ExecuteParams,
  phases: Partial<Record<TurnPhase, number>>,
): TurnMemory | undefined {
  const startedAt = Date.now();
  const memory = retrieveForTurn({
    chatId: params.chatId,
    text: params.prompt,
    isGroup: params.isGroup ?? false,
  });
  phases.memory = Date.now() - startedAt;
  recordHistogram("turn.memory_chars", memory?.chars ?? 0);
  return memory;
}

/** `queue=12ms warp=3ms ttft=1840ms stream=6200ms delivery=310ms` */
function formatPhases(phases: Partial<Record<TurnPhase, number>>): string {
  const labels: Record<TurnPhase, string> = {
    queueWait: "queue",
    warpResolve: "warp",
    memory: "memory",
    firstToken: "ttft",
    stream: "stream",
    delivery: "delivery",
  };
  return (Object.keys(labels) as TurnPhase[])
    .filter((phase) => phases[phase] !== undefined)
    .map((phase) => `${labels[phase]}=${phases[phase]}ms`)
    .join(" ");
}

let weaver: Weaver | null = null;

export function initWeaver(deps: WeaverDeps): Weaver {
  weaver = new Weaver(deps);
  log("dispatcher", "Weaver initialized");
  return weaver;
}

/**
 * The active Weaver's Loom, or `null` before the dispatcher is wired. The
 * gateway delegates its per-chat context bookkeeping here so the Loom is the
 * single registry; a standalone gateway (e.g. in unit tests, or during the
 * pre-init startup window) falls back to its own Loom.
 */
export function getActiveLoom(): Loom | null {
  return weaver?.loom ?? null;
}
