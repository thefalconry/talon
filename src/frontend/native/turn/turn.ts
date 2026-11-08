/**
 * A user turn — drive `dispatcher.execute()` and forward the canonical
 * `AgentEvent` stream to clients as Bridge events: reasoning + tool activity
 * stream live, while the persisted reply arrives via the gateway action
 * handler (tool-only backends) or the trailing-prose fallback (text-mode
 * backends) — mirroring the terminal renderer's delivery semantics.
 */

import type { ExecuteResult } from "../../../core/types.js";
import type { AgentEvent } from "../../../core/agent-runtime/events.js";
import { execute } from "../../../core/engine/dispatcher.js";
import { LOCAL_OPERATOR_SENDER } from "../../../core/mcp-hub/guest-scope.js";
import { toolInputToRecord } from "../../../core/agent-runtime/events.js";
import { getBackendForChat } from "../../../core/engine/backend-controller/index.js";
import { isDeliveryTool } from "../../../core/tools/index.js";
import { recordTurnMeta } from "./turn-meta.js";
import type { ChatEntry } from "../chats/chats.js";
import { refreshContext } from "./context.js";
import { emitAssistant, emitUser } from "./emit.js";
import type { BridgeEvent, ClientAttachment } from "../protocol.js";
import { takeQueued } from "./queue.js";
import type { LiveToolEntry, NativeRuntime } from "../runtime.js";
import { summarizeToolResult } from "./tool-result.js";

/** The tool calls of one running turn, in call order. */
type TurnTools = Map<string, LiveToolEntry>;

export type StartTurnOptions = { attachments?: ClientAttachment[] };

/** Human-readable size for the attachment lines handed to the model. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Point the model at the files the user attached. Each gets its own line with
 * an absolute path so the model can read it with its own tools; images keep
 * the `[Attached image: …]` wording backends already recognise.
 */
export function attachmentPrompt(
  text: string,
  attachments: ClientAttachment[],
): string {
  if (!attachments.length) return text;
  const lines = attachments.map((a) =>
    a.image
      ? `[Attached image: ${a.path}]`
      : `[Attached file: ${a.name} (${a.mimeType}, ${formatSize(a.size)}) at ${a.path}]`,
  );
  return `${text ? `${text}\n\n` : ""}${lines.join("\n")}`;
}

/** True when a turn is currently running for a chat (used to decide queue). */
export function isBusy(runtime: NativeRuntime, chatId: string): boolean {
  return runtime.liveTurns.has(chatId);
}

/**
 * Events that reconstruct every in-progress turn for a freshly-connected
 * client: a turn_start (so the live turn renders), a typing indicator, and
 * each tool's call — plus its result when it has already finished. Replayed
 * right after `hello` so a reconnect mid-turn shows the full tool timeline
 * immediately rather than only the tools that happen to fire afterwards.
 */
export function liveTurnEvents(runtime: NativeRuntime): BridgeEvent[] {
  const events: BridgeEvent[] = [];
  for (const [chatId, tools] of runtime.liveTurns) {
    events.push({ kind: "turn_start", chatId });
    events.push({ kind: "typing", chatId, on: true });
    for (const { call, done } of tools.values()) {
      events.push({
        kind: "tool",
        chatId,
        id: call.id,
        name: call.name,
        phase: "call",
        ...(call.input ? { input: call.input } : {}),
      });
      if (done) {
        events.push({
          kind: "tool",
          chatId,
          id: call.id,
          name: call.name,
          phase: "result",
          ...(call.error ? { error: call.error } : {}),
          ...(call.output ? { output: call.output } : {}),
        });
      }
    }
  }
  return events;
}

/**
 * Safety net: any tool the backend announced but never resolved (a crash can
 * eat a tool_result) gets a synthetic result at turn end — a spinner the app
 * opened on phase:"call" must always see a phase:"result".
 */
function flushOpenTools(
  runtime: NativeRuntime,
  entry: ChatEntry,
  turnTools: TurnTools,
): void {
  for (const [id, live] of turnTools) {
    if (live.done) continue;
    live.done = true;
    live.call.durationMs = Date.now() - live.startedAt;
    runtime.broadcast({
      kind: "tool",
      chatId: entry.id,
      id,
      name: live.call.name,
      phase: "result",
    });
  }
}

/** Forward one agent event to clients, recording tool activity as it goes. */
function forwardAgentEvent(
  runtime: NativeRuntime,
  entry: ChatEntry,
  turnTools: TurnTools,
  event: AgentEvent,
): void {
  switch (event.type) {
    case "reasoning":
      if (event.text)
        runtime.broadcast({
          kind: "reasoning",
          chatId: entry.id,
          text: event.text,
        });
      break;
    case "text_delta":
      runtime.broadcast({ kind: "delta", chatId: entry.id, text: event.text });
      break;
    case "tool_call": {
      // Delivery plumbing (end_turn / send_message / react) never
      // enters the tool timeline — its effect arrives as the
      // `message`/reaction itself. Skipping here keeps the live
      // stream, the mid-turn replay to late joiners, and the
      // persisted turn meta consistent from one choke point.
      if (isDeliveryTool(event.name)) break;
      const input = toolInputToRecord(event.name, event.input);
      turnTools.set(event.id, {
        call: { id: event.id, name: event.name, input },
        startedAt: Date.now(),
      });
      runtime.broadcast({
        kind: "tool",
        chatId: entry.id,
        id: event.id,
        name: event.name,
        phase: "call",
        input,
      });
      break;
    }
    case "tool_result": {
      if (isDeliveryTool(event.name)) break;
      const output = summarizeToolResult(event.result);
      const live = turnTools.get(event.id);
      if (live) {
        live.done = true;
        live.call.durationMs = Date.now() - live.startedAt;
        if (event.error) live.call.error = event.error;
        if (output) live.call.output = output;
      }
      runtime.broadcast({
        kind: "tool",
        chatId: entry.id,
        id: event.id,
        name: event.name,
        phase: "result",
        ...(event.error ? { error: event.error } : {}),
        ...(output ? { output } : {}),
      });
      break;
    }
    case "error":
      runtime.broadcast({
        kind: "error",
        chatId: entry.id,
        message: event.error.message,
      });
      break;
  }
}

/** Settle a completed turn: deliver trailing prose, persist meta, close it. */
function finishTurn(
  runtime: NativeRuntime,
  entry: ChatEntry,
  turnTools: TurnTools,
  result: ExecuteResult,
): void {
  // Trailing-prose fallback: text-mode backends (kilo/opencode/codex)
  // deliver the reply as plain text rather than a bridge send. When no
  // delivery tool fired this turn, surface result.text as the message —
  // exactly what the terminal renderer does.
  let delivered = result.bridgeMessageCount;
  if (delivered === 0 && result.text.trim()) {
    emitAssistant(runtime, entry, result.text.trim());
    delivered = 1;
  }

  // Resolve open tool spinners BEFORE persisting turn meta, so the
  // synthetic durations land in the recorded timeline too.
  flushOpenTools(runtime, entry, turnTools);

  // Persist what this turn did against its final assistant message, so
  // reloaded history keeps the tool timeline + stats footer. Only when
  // the turn actually delivered — otherwise the "last assistant id"
  // belongs to a previous turn and the meta would land on the wrong row.
  if (delivered > 0) {
    const msgId = runtime.lastAssistantId.get(entry.id);
    if (msgId) {
      const tools = [...turnTools.values()].map((t) => t.call);
      recordTurnMeta(entry.id, msgId, {
        durationMs: result.durationMs,
        tokensIn: result.inputTokens,
        tokensOut: result.outputTokens,
        ...(tools.length ? { tools } : {}),
      });
    }
  }

  runtime.broadcast({ kind: "typing", chatId: entry.id, on: false });
  runtime.broadcast({
    kind: "turn_end",
    chatId: entry.id,
    delivered,
    durationMs: result.durationMs,
    usage: { input: result.inputTokens, output: result.outputTokens },
  });

  // Refresh the live context-window readout now the turn's usage has
  // settled, and push it to clients via chat_updated. Best-effort — a
  // failure here must never surface as a turn error.
  void refreshContext(runtime, entry).catch(() => {});
}

/** Close a turn that threw: flush spinners, surface the error, end it. */
function failTurn(
  runtime: NativeRuntime,
  entry: ChatEntry,
  turnTools: TurnTools,
  err: unknown,
  start: number,
): void {
  flushOpenTools(runtime, entry, turnTools);
  runtime.broadcast({ kind: "typing", chatId: entry.id, on: false });
  runtime.broadcast({
    kind: "error",
    chatId: entry.id,
    message: err instanceof Error ? err.message : String(err),
  });
  runtime.broadcast({
    kind: "turn_end",
    chatId: entry.id,
    delivered: 0,
    durationMs: Date.now() - start,
  });
}

async function runTurn(
  runtime: NativeRuntime,
  entry: ChatEntry,
  text: string,
  messageId: number,
  attachments: ClientAttachment[],
): Promise<void> {
  const start = Date.now();
  // Tool calls observed during this turn, in call order — recorded into the
  // turn-meta sidecar at turn_end so history can replay the timeline. Also
  // registered in `liveTurns` so a client connecting mid-turn can be replayed
  // the activity so far (cleared in the `finally`).
  const turnTools: TurnTools = new Map();
  runtime.liveTurns.set(entry.id, turnTools);
  const prompt = attachmentPrompt(text, attachments);
  try {
    const result = await execute({
      chatId: entry.id,
      numericChatId: entry.numericId,
      prompt,
      senderName: "User",
      senderKeys: [LOCAL_OPERATOR_SENDER],
      isGroup: false,
      // Give the model the user message's id so `[msg_id:N]` is present and
      // react/reply/edit target the user's message — not the bot's.
      messageId,
      source: "message",
      onEvent: async (event) =>
        forwardAgentEvent(runtime, entry, turnTools, event),
    });
    finishTurn(runtime, entry, turnTools, result);
  } catch (err) {
    failTurn(runtime, entry, turnTools, err, start);
  } finally {
    // The turn is over (delivered or errored) — stop replaying it to new
    // clients. Any late tool spinner has already been flushed above.
    runtime.liveTurns.delete(entry.id);
    // Flush a queued follow-up as a fresh turn: "once it's done it will
    // send". Started synchronously so the chat never looks idle in between —
    // a /send landing in a deferred gap would start its own turn and run
    // ahead of the message that was queued first.
    const queued = takeQueued(runtime, entry);
    if (queued) {
      startTurn(runtime, entry, queued.text, {
        attachments: queued.attachments,
      });
    }
  }
}

/** Emit the user message, open the turn, and drive it. Shared by the /send
 *  handler and the queued-follow-up flush. */
export function startTurn(
  runtime: NativeRuntime,
  entry: ChatEntry,
  text: string,
  options?: StartTurnOptions,
): void {
  const attachments = options?.attachments ?? [];
  const messageId = emitUser(runtime, entry, text, attachments);
  runtime.broadcast({ kind: "turn_start", chatId: entry.id });
  runtime.broadcast({ kind: "typing", chatId: entry.id, on: true });
  void runTurn(runtime, entry, text, messageId, attachments);
}

/** Best-effort interrupt of a chat's in-flight turn. `true` if one was
 *  running and got signalled. */
export async function interruptTurn(
  runtime: NativeRuntime,
  chatId: string,
): Promise<boolean> {
  const entry = runtime.chats.get(chatId);
  if (!entry) return false;
  // Only meaningful while a turn is actually running.
  if (!isBusy(runtime, chatId)) return false;
  let backend = null;
  try {
    backend = getBackendForChat(chatId);
  } catch {
    return false;
  }
  const interrupt = backend?.chat?.interruptChatTurn;
  if (!interrupt) return false;
  try {
    return await interrupt(chatId);
  } catch {
    return false;
  }
}
