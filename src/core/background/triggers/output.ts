/**
 * Trigger output handling — stdout/stderr line capture, the in-memory line
 * buffer, fire-payload truncation, and the wake-up dispatch into the chat.
 */

import {
  getTrigger,
  updateTrigger,
  type TriggerStatus,
  FIRE_PAYLOAD_MAX_BYTES,
} from "../../../storage/triggers.js";
import { logError } from "../../../util/log.js";
import { dispatchIsolatedWake, isIsolated } from "./isolated.js";
import {
  depsHolder,
  logStreams,
  lineBuffers,
  LINE_BUFFER_MAX,
  FIRE_PREFIX,
} from "./state.js";

// ── Stdout / stderr handling ─────────────────────────────────────────────────

export function handleStdoutLine(triggerId: string, line: string): void {
  const stream = logStreams.get(triggerId);
  stream?.write(line + "\n");
  pushBufferLine(triggerId, line);

  if (line.startsWith(FIRE_PREFIX)) {
    const payload = line.slice(FIRE_PREFIX.length).trim();
    fireWake(triggerId, "fired", payload, /* terminal */ false).catch((err) =>
      logError("triggers", `mid-run fire failed [${triggerId}]`, err),
    );
  }
}

/** Stderr lines are logged and buffered (tagged) but never fire wakes. */
export function handleStderrLine(triggerId: string, line: string): void {
  const stream = logStreams.get(triggerId);
  stream?.write(`[stderr] ${line}\n`);
  pushBufferLine(triggerId, `[stderr] ${line}`);
}

function pushBufferLine(triggerId: string, line: string): void {
  const buf = lineBuffers.get(triggerId);
  if (!buf) return;
  buf.push(line);
  if (buf.length > LINE_BUFFER_MAX) buf.splice(0, buf.length - LINE_BUFFER_MAX);
}

// ── Payload truncation ───────────────────────────────────────────────────────

/** Build a fire payload from the in-memory line buffer. */
export function bufferAsPayload(buffer: string[], exitCode?: number): string {
  const head = exitCode != null ? `exit ${exitCode}` : undefined;
  const lines = head ? [head, ...buffer] : buffer;
  const text = lines.join("\n");
  // Byte-correct truncation: keep the tail (most recent output) but never
  // exceed FIRE_PAYLOAD_MAX_BYTES *bytes* and never split a multi-byte char.
  return truncateUtf8Tail(text, FIRE_PAYLOAD_MAX_BYTES);
}

/**
 * Keep the tail of `text` so the resulting UTF-8 encoding is at most
 * `maxBytes` bytes. Never splits a multi-byte character.
 */
function truncateUtf8Tail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  // 10xxxxxx is a UTF-8 continuation byte — skip until we hit a lead byte.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.toString("utf-8", start);
}

/**
 * Keep the head of `text` so the resulting UTF-8 encoding is at most
 * `maxBytes` bytes. Never splits a multi-byte character.
 */
function truncateUtf8Head(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // Walk backwards past any continuation byte we'd split on.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.toString("utf-8", 0, end);
}

// ── Wake-up firing ───────────────────────────────────────────────────────────

export async function fireWake(
  triggerId: string,
  status: TriggerStatus,
  payload: string | undefined,
  terminal: boolean,
): Promise<void> {
  const deps = depsHolder.deps;
  if (!deps) return;
  const t = getTrigger(triggerId);
  if (!t) return;

  // Truncate payload — byte-correct so the cap matches FIRE_PAYLOAD_MAX_BYTES
  // and multi-byte characters don't get sliced mid-codepoint.
  const trimmed = truncateUtf8Head(payload ?? "", FIRE_PAYLOAD_MAX_BYTES);

  updateTrigger(triggerId, {
    fireCount: (t.fireCount ?? 0) + 1,
    lastFireAt: Date.now(),
    lastFirePayload: trimmed,
  });

  // Mid-run TALON_FIRE: signals reuse the "fired" enum value because there
  // isn't a distinct non-terminal status, but the prompt must not lie to the
  // model — show "signalled" so downstream handling can't mistake a mid-run
  // event for terminal completion.
  const promptStatus = terminal ? status : "signalled";

  // A terminal status other than "fired" is the watcher's own death
  // (errored, timed_out, cancelled, terminated by a restart), not an event.
  const lifecycleNotice = terminal && status !== "fired";

  // Isolated mode: hand the wake to a one-shot job instead of resuming the
  // chat session. The lane coalesces bursts; failures are noticed there.
  // Lifecycle notices still go to the chat: the one-shot has no history and
  // is told to message the user only when its brief says so, so the chat
  // would never learn its watcher is gone and never recreate it.
  const isolated = isIsolated(t);
  if (isolated && !lifecycleNotice) {
    await dispatchIsolatedWake(t, {
      status: promptStatus,
      payload: trimmed,
      at: Date.now(),
    });
    return;
  }

  const header = `[Trigger "${t.name}" (${t.id}) ${promptStatus}]`;
  const body = trimmed ? `${header}\n\n${trimmed}` : `${header}\n\n(no output)`;

  const prompt =
    `[System: TRIGGER FIRED. Status: ${promptStatus}. ` +
    `This is a wake-up message from a long-running script you started earlier. ` +
    (isolated
      ? `Its events were handled in isolated runs; this notice says the watcher itself has stopped. `
      : "") +
    `Decide whether to message the user, take an action, or do nothing.]` +
    `\n\n${body}`;

  try {
    await deps.execute({
      chatId: t.chatId,
      numericChatId: t.numericChatId,
      prompt,
      senderName: "Trigger",
      isGroup: false,
      source: "trigger",
      // Per-trigger model override (same backend) — runs the wake-up turn on a
      // cheaper model while still resuming the chat session. Falls back to the
      // chat model if the id no longer resolves. An isolated trigger's model
      // is for its one-shot runs (possibly another provider), not the chat.
      ...(t.model && !isolated ? { modelOverride: t.model } : {}),
    });
  } catch (err) {
    logError("triggers", `wake dispatch failed [${triggerId}]`, err);
  }
}
