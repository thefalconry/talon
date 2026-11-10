/**
 * Trigger CRUD — create / list / cancel / logs / delete long-running watcher
 * scripts for a chat.
 */

import {
  addTrigger,
  deleteTrigger,
  generateTriggerId,
  getActiveTriggersForChat,
  getTrigger,
  getTriggerByName,
  getTriggersForChat,
  readTriggerLogTail,
  triggerLogPath,
  validateLanguage,
  validateName,
  validateScript,
  validateTimeout,
  writeScriptFile,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_WAKE_TIMEOUT_MS,
  MAX_WAKE_TIMEOUT_MS,
  type Trigger,
  type TriggerLanguage,
} from "../../../storage/triggers.js";
import {
  cancelTrigger,
  spawnTrigger,
  triggerCapError,
} from "../../background/triggers/index.js";
import { log } from "../../../util/log.js";
import {
  validateIsolatedJobTarget,
  validateJobModelOverride,
} from "./validation.js";
import type { SharedActionHandlers } from "./types.js";

/** Longest accepted isolated-wake brief (mirrors cron `instructions`). */
const MAX_INSTRUCTIONS_CHARS = 4_000;

type WakeOptions = {
  isolated: boolean;
  instructions?: string;
  provider?: string;
  wakeTimeoutMs?: number;
};

/**
 * Parse the wake-routing params of trigger_create. `instructions`, `provider`
 * and `wake_timeout_seconds` only mean something for an isolated wake — passed
 * with the default chat mode they are an error rather than silently ignored.
 */
export function parseWakeOptions(
  body: Record<string, unknown>,
): { ok: true; value: WakeOptions } | { ok: false; error: string } {
  const mode = body.mode == null ? "chat" : String(body.mode);
  if (mode !== "chat" && mode !== "isolated") {
    return { ok: false, error: `mode must be "chat" or "isolated"` };
  }
  const instructions =
    body.instructions != null && String(body.instructions).trim()
      ? String(body.instructions).trim()
      : undefined;
  const provider =
    body.provider != null && String(body.provider).trim()
      ? String(body.provider).trim()
      : undefined;
  const timeoutRaw = body.wake_timeout_seconds;
  if (mode === "chat") {
    const stray = [
      instructions !== undefined ? "instructions" : null,
      provider !== undefined ? "provider" : null,
      timeoutRaw != null ? "wake_timeout_seconds" : null,
    ].filter(Boolean);
    if (stray.length > 0) {
      return {
        ok: false,
        error: `${stray.join(", ")} only apply to mode="isolated" — set mode="isolated" or drop them.`,
      };
    }
    return { ok: true, value: { isolated: false } };
  }
  if (instructions && instructions.length > MAX_INSTRUCTIONS_CHARS) {
    return {
      ok: false,
      error: `instructions too long (max ${MAX_INSTRUCTIONS_CHARS} chars)`,
    };
  }
  let wakeTimeoutMs: number | undefined;
  if (timeoutRaw != null) {
    const seconds = Number(timeoutRaw);
    const maxSeconds = MAX_WAKE_TIMEOUT_MS / 1000;
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > maxSeconds) {
      return {
        ok: false,
        error: `wake_timeout_seconds must be an integer between 30 and ${maxSeconds}`,
      };
    }
    wakeTimeoutMs = seconds * 1000;
  }
  return {
    ok: true,
    value: {
      isolated: true,
      ...(instructions ? { instructions } : {}),
      ...(provider ? { provider } : {}),
      ...(wakeTimeoutMs !== undefined ? { wakeTimeoutMs } : {}),
    },
  };
}

/**
 * A chat-mode wake resumes the session, so its model must stay on the chat's
 * backend; an isolated wake has no session to keep and follows the cron
 * `query` rules (any background-capable provider, which then needs a model).
 */
async function validateWakeTarget(
  chatKey: string,
  wake: WakeOptions,
  model: string | undefined,
): Promise<string | null> {
  if (wake.isolated) {
    return validateIsolatedJobTarget(chatKey, model, wake.provider);
  }
  return model ? validateJobModelOverride(chatKey, model) : null;
}

/** The trigger-row fields an isolated wake configuration sets. */
function wakeFields(wake: WakeOptions): Partial<Trigger> {
  if (!wake.isolated) return {};
  return {
    wakeMode: "isolated",
    ...(wake.instructions ? { instructions: wake.instructions } : {}),
    ...(wake.provider ? { provider: wake.provider } : {}),
    ...(wake.wakeTimeoutMs !== undefined
      ? { wakeTimeoutMs: wake.wakeTimeoutMs }
      : {}),
  };
}

function describeWake(t: Trigger): string {
  if (t.wakeMode !== "isolated") {
    return t.model ? `chat session (model ${t.model})` : "chat session";
  }
  const target = [t.provider, t.model].filter(Boolean).join("/");
  const seconds = Math.round(
    (t.wakeTimeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS) / 1000,
  );
  return (
    `isolated one-shot${target ? ` on ${target}` : ""}, timeout ${seconds}s` +
    (t.instructions ? ", with brief" : "")
  );
}

export const triggerHandlers: SharedActionHandlers = {
  trigger_create: async (body, chatId, _backend, chatKey) => {
    const name = String(body.name ?? "").trim();
    const language = body.language;
    const script = String(body.script ?? "");
    const timeoutSeconds =
      body.timeout_seconds != null
        ? Number(body.timeout_seconds)
        : DEFAULT_TIMEOUT_SECONDS;
    const description = body.description ? String(body.description) : undefined;
    const persistent = body.persistent === true;
    const model = body.model ? String(body.model) : undefined;
    const wake = parseWakeOptions(body);
    if (!wake.ok) return { ok: false, error: wake.error };

    const nameErr = validateName(name);
    if (nameErr) return { ok: false, error: nameErr };
    if (!validateLanguage(language))
      return {
        ok: false,
        error: `Unsupported language. Choose one of: bash, python, node, lua`,
      };
    const scriptErr = validateScript(script);
    if (scriptErr) return { ok: false, error: scriptErr };
    const timeoutErr = validateTimeout(timeoutSeconds);
    if (timeoutErr) return { ok: false, error: timeoutErr };

    if (getTriggerByName(chatKey, name)) {
      return {
        ok: false,
        error: `A trigger named "${name}" already exists in this chat. Cancel it first or pick a different name.`,
      };
    }
    const capErr = triggerCapError(
      getActiveTriggersForChat(chatKey),
      persistent,
    );
    if (capErr) return { ok: false, error: capErr };

    // Validate the model up front so a bad id is rejected here instead of
    // silently failing at fire time.
    const targetErr = await validateWakeTarget(chatKey, wake.value, model);
    if (targetErr) return { ok: false, error: targetErr };

    const id = generateTriggerId();
    const lang = language as TriggerLanguage;
    let scriptPath: string;
    try {
      scriptPath = writeScriptFile(chatKey, id, lang, script);
    } catch (err) {
      return {
        ok: false,
        error: `Failed to write script: ${err instanceof Error ? err.message : err}`,
      };
    }
    const logPath = triggerLogPath(chatKey, id);

    const trigger = {
      id,
      chatId: chatKey,
      numericChatId: chatId,
      name,
      language: lang,
      scriptPath,
      logPath,
      description,
      status: "pending" as const,
      createdAt: Date.now(),
      timeoutSeconds,
      fireCount: 0,
      persistent,
      ...(model ? { model } : {}),
      ...wakeFields(wake.value),
    };
    addTrigger(trigger);

    try {
      spawnTrigger(trigger);
    } catch (err) {
      return {
        ok: false,
        error: `Failed to spawn: ${err instanceof Error ? err.message : err}`,
      };
    }

    // spawnTrigger() can fail without throwing — e.g. an unsupported
    // language slips past the validateLanguage() check (defence in depth),
    // child.pid is undefined, or spawn() itself catches and routes through
    // failTrigger(). In all of those paths the trigger lands in `errored`
    // with `lastError` set. Re-read the store and surface the real status
    // so callers never get a false "running" response.
    const stored = getTrigger(id);
    if (!stored || stored.status === "errored") {
      return {
        ok: false,
        error: stored?.lastError ?? "Failed to spawn (unknown error)",
      };
    }

    log("gateway", `trigger_create: "${name}" [${id}] (${lang})`);
    return {
      ok: true,
      text:
        `Created trigger "${name}" (id: ${id})\n` +
        `Language: ${lang}\n` +
        `Timeout: ${timeoutSeconds}s\n` +
        `Persistent: ${persistent ? "yes (respawns on Talon restart)" : "no"}\n` +
        `Wake: ${describeWake(stored)}\n` +
        `Status: ${stored.status}`,
    };
  },

  trigger_list: (body, chatId, _backend, chatKey) => {
    const triggers = getTriggersForChat(chatKey);
    if (triggers.length === 0)
      return { ok: true, text: "No triggers in this chat." };
    const lines = triggers.map((t) => {
      const created = new Date(t.createdAt)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");
      const fireInfo =
        t.fireCount > 0
          ? `${t.fireCount} fire(s)${t.lastFireAt ? `, last ${new Date(t.lastFireAt).toISOString().slice(0, 19).replace("T", " ")}` : ""}`
          : "no fires yet";
      const detail = [
        `- ${t.name} [${t.status}]${t.persistent ? " (persistent)" : ""}`,
        `  ID: ${t.id}`,
        `  Language: ${t.language}`,
        `  Created: ${created} (timeout ${t.timeoutSeconds}s)`,
        `  ${fireInfo}`,
      ];
      detail.push(`  Wake: ${describeWake(t)}`);
      if (t.description) detail.push(`  Note: ${t.description}`);
      if (t.lastError) detail.push(`  Error: ${t.lastError}`);
      return detail.join("\n");
    });
    return {
      ok: true,
      text: `Triggers (${triggers.length}):\n\n${lines.join("\n\n")}`,
    };
  },

  trigger_cancel: (body, chatId, _backend, chatKey) => {
    const triggerId = String(body.trigger_id ?? "");
    if (!triggerId) return { ok: false, error: "Missing trigger_id" };
    const t = getTrigger(triggerId);
    if (!t) return { ok: false, error: `Trigger ${triggerId} not found` };
    if (t.chatId !== chatKey)
      return { ok: false, error: "Trigger belongs to a different chat" };
    const wasRunning = cancelTrigger(triggerId);
    if (!wasRunning) {
      return {
        ok: true,
        text: `Trigger "${t.name}" (${triggerId}) was already in status "${t.status}".`,
      };
    }
    return {
      ok: true,
      text: `Cancelled trigger "${t.name}" (${triggerId}). SIGTERM sent; SIGKILL after 5s grace.`,
    };
  },

  trigger_logs: (body, chatId, _backend, chatKey) => {
    const triggerId = String(body.trigger_id ?? "");
    if (!triggerId) return { ok: false, error: "Missing trigger_id" };
    const t = getTrigger(triggerId);
    if (!t) return { ok: false, error: `Trigger ${triggerId} not found` };
    if (t.chatId !== chatKey)
      return { ok: false, error: "Trigger belongs to a different chat" };
    const lines = Math.min(500, Math.max(1, Number(body.lines ?? 80)));
    const { tail, truncated } = readTriggerLogTail(t.logPath, lines);
    const preface =
      `Trigger "${t.name}" (${triggerId}) — status ${t.status}` +
      (truncated ? `, showing last ${lines} lines:` : `:`);
    return {
      ok: true,
      text: `${preface}\n\n${tail || "(empty)"}`,
    };
  },

  trigger_delete: (body, chatId, _backend, chatKey) => {
    const triggerId = String(body.trigger_id ?? "");
    if (!triggerId) return { ok: false, error: "Missing trigger_id" };
    const t = getTrigger(triggerId);
    if (!t) return { ok: false, error: `Trigger ${triggerId} not found` };
    if (t.chatId !== chatKey)
      return { ok: false, error: "Trigger belongs to a different chat" };
    // Cancel first if it's still running so we don't orphan a child
    cancelTrigger(triggerId);
    deleteTrigger(triggerId);
    return {
      ok: true,
      text: `Deleted trigger "${t.name}" (${triggerId}).`,
    };
  },
};
