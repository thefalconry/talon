/**
 * Kimi Code stream-json event model.
 *
 * The CLI in prompt mode (`kimi -p ... --output-format stream-json`) emits
 * newline-delimited JSON on stdout.
 *
 * Each line is a JSON object with a `role` discriminator:
 *   - `meta`: system metadata (`system.version`, `session.resume_hint`, `turn.step.retrying`)
 *   - `assistant`: text content and/or tool_calls array
 *   - `tool`: result of a tool call with `tool_call_id` and `content`
 *
 * Tool call arguments are delivered as a JSON string (e.g. `call.function.arguments`),
 * which must be parsed into an object for Talon's runtime.
 */

import { log, logWarn } from "../../util/log.js";
import { isTurnTerminator } from "../../core/tools/index.js";
import {
  appendText,
  recordToolUse,
  recordToolCall,
  type StreamState,
} from "../runtime/index.js";

// ── Wire types ──────────────────────────────────────────────────────────────

export interface KimiToolCallFunction {
  name: string;
  arguments: string; // JSON string!
}

export interface KimiToolCall {
  type: "function";
  id: string;
  function: KimiToolCallFunction;
}

export interface KimiMetaEvent {
  role: "meta";
  type: string;
  version?: string;
  session_id?: string;
  command?: string;
  content?: string;
  failed_attempt?: number;
  next_attempt?: number;
  max_attempts?: number;
  delay_ms?: number;
  error_name?: string;
  error_message?: string;
  status_code?: number;
  [key: string]: unknown;
}

export interface KimiAssistantEvent {
  role: "assistant";
  content?: string;
  tool_calls?: KimiToolCall[];
}

export interface KimiToolEvent {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type KimiEvent = KimiMetaEvent | KimiAssistantEvent | KimiToolEvent;

// ── Parsing ─────────────────────────────────────────────────────────────────

export function parseKimiLine(line: string): KimiEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const role = (parsed as { role?: unknown }).role;
  if (role !== "meta" && role !== "assistant" && role !== "tool") {
    return null;
  }
  return parsed as KimiEvent;
}

export function parseKimiStream(text: string): KimiEvent[] {
  const events: KimiEvent[] = [];
  for (const line of text.split("\n")) {
    const event = parseKimiLine(line);
    if (event) events.push(event);
  }
  return events;
}

// ── Tool identity ───────────────────────────────────────────────────────────

export interface KimiToolShape {
  name: string;
  input: Record<string, unknown>;
}

export function describeKimiTool(call: KimiToolCall): KimiToolShape {
  const name = call.function?.name || "unknown";
  let input: Record<string, unknown> = {};
  if (typeof call.function?.arguments === "string") {
    try {
      const parsed = JSON.parse(call.function.arguments);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      input = { raw: call.function.arguments };
    }
  }
  return { name, input };
}

// ── Stream-state translation ────────────────────────────────────────────────

export interface KimiEventContext {
  state: StreamState;
  chatId: string;
  startedToolIds: Set<string>;
  settledToolIds: Set<string>;
  toolCallsById: Map<string, KimiToolShape>;
  toolMetrics: { count: number };
  onStreamDelta?: (accumulated: string, phase?: "thinking" | "text") => void;
  onToolUse?: (
    toolName: string,
    input: Record<string, unknown>,
    meta?: { failed?: boolean },
  ) => void;
  onToolStart?: (
    callId: string,
    toolName: string,
    input: Record<string, unknown>,
  ) => void;
  onToolEnd?: (
    callId: string,
    toolName: string,
    meta?: { failed?: boolean },
  ) => void;
}

export function createKimiEventContext(
  state: StreamState,
  chatId: string,
  callbacks: Pick<
    KimiEventContext,
    "onStreamDelta" | "onToolUse" | "onToolStart" | "onToolEnd"
  > = {},
): KimiEventContext {
  return {
    state,
    chatId,
    startedToolIds: new Set<string>(),
    settledToolIds: new Set<string>(),
    toolCallsById: new Map<string, KimiToolShape>(),
    toolMetrics: { count: 0 },
    ...callbacks,
  };
}

export function applyKimiEvent(event: KimiEvent, ctx: KimiEventContext): void {
  if (event.role === "assistant") {
    applyAssistantEvent(event, ctx);
    return;
  }
  if (event.role === "tool") {
    applyToolEvent(event, ctx);
    return;
  }
}

function applyAssistantEvent(
  event: KimiAssistantEvent,
  ctx: KimiEventContext,
): void {
  if (event.content) {
    appendText(ctx.state, event.content);
    if (ctx.onStreamDelta) {
      try {
        ctx.onStreamDelta(
          ctx.state.allResponseText + ctx.state.currentBlockText,
          "text",
        );
      } catch {
        /* non-fatal */
      }
    }
  }

  if (event.tool_calls && Array.isArray(event.tool_calls)) {
    for (const call of event.tool_calls) {
      const shape = describeKimiTool(call);
      ctx.toolCallsById.set(call.id, shape);
      openToolCall(ctx, call.id, shape);
    }
  }
}

function openToolCall(
  ctx: KimiEventContext,
  id: string,
  shape: KimiToolShape,
): void {
  if (ctx.startedToolIds.has(id)) return;
  ctx.startedToolIds.add(id);
  if (!ctx.onToolStart) return;
  try {
    ctx.onToolStart(id, shape.name, shape.input);
  } catch {
    /* non-fatal */
  }
}

function applyToolEvent(event: KimiToolEvent, ctx: KimiEventContext): void {
  const id = event.tool_call_id;
  if (ctx.settledToolIds.has(id)) return;
  ctx.settledToolIds.add(id);

  const shape = ctx.toolCallsById.get(id) ?? {
    name: "tool",
    input: {},
  };
  settleToolCall(ctx, id, shape, event.content);
}

function settleToolCall(
  ctx: KimiEventContext,
  id: string,
  shape: KimiToolShape,
  content: string,
): void {
  const failed =
    content.startsWith('Tool "') && content.includes('" not found');

  recordToolCall(ctx.chatId, shape.name, "kimi");
  ctx.toolMetrics.count += 1;

  if (failed) {
    logWarn(
      "agent",
      `[${ctx.chatId}] kimi tool ${shape.name} failed: ${content.slice(0, 200)}`,
    );
    reportToolTerminal(ctx, id, shape, { failed: true });
    return;
  }

  recordToolUse(ctx.state, shape.name, shape.input);
  reportToolTerminal(ctx, id, shape);
  if (isTurnTerminator(shape.name, shape.input)) {
    log("agent", `[${ctx.chatId}] kimi terminator fired: ${shape.name}`);
  }
}

function reportToolTerminal(
  ctx: KimiEventContext,
  id: string,
  shape: KimiToolShape,
  meta?: { failed?: boolean },
): void {
  if (ctx.startedToolIds.delete(id) && ctx.onToolEnd) {
    try {
      ctx.onToolEnd(id, shape.name, meta);
    } catch {
      /* non-fatal */
    }
    return;
  }
  if (!ctx.onToolUse) return;
  try {
    ctx.onToolUse(shape.name, shape.input, meta);
  } catch {
    /* non-fatal */
  }
}

// ── Usage ───────────────────────────────────────────────────────────────────

export interface KimiTurnTokens {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

export function kimiUsageToTokens(
  usage:
    | {
        inputOther?: number;
        output?: number;
        inputCacheRead?: number;
        inputCacheCreation?: number;
      }
    | undefined,
): KimiTurnTokens {
  const nonNegative = (n: number | undefined): number => Math.max(0, n ?? 0);
  return {
    inputTokens: nonNegative(usage?.inputOther),
    outputTokens: nonNegative(usage?.output),
    cacheRead: nonNegative(usage?.inputCacheRead),
    cacheWrite: nonNegative(usage?.inputCacheCreation),
  };
}
