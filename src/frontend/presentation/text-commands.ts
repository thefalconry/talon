/**
 * Markdown replies for the text-only command layers — `/model`, `/effort`,
 * `/settings`, `/status`.
 *
 * WhatsApp and the native bridge have no inline keyboards, so where
 * Telegram and Discord open a picker they print a listing and take a typed
 * argument instead: `/model` prints a numbered catalog, `/model 3` (or
 * `/model <id>`, `/model <backend>`) picks from it. The state changes come
 * from model-commands.ts and session-status.ts; this module renders them
 * as Markdown and routes the typed argument, so the two frontends share
 * one wording and one parser. Each frontend translates the Markdown into
 * its own dialect on the way out.
 */

import { getChatSettings } from "../../storage/chat-settings.js";
import { isPulseEnabled } from "../../core/background/pulse/pulse.js";
import {
  DEFAULT_PULSE_INTERVAL_MS,
  formatBytes,
  formatDuration,
  formatModelLabel,
  formatTokenCount,
  formatUsd,
} from "./format.js";
import {
  collectSessionStatus,
  type SessionStatusData,
} from "./session-status.js";
import { formatCacheTempLine, formatDaemonLine } from "./status-context.js";
import {
  describeChatEffort,
  describeChatModels,
  matchBackendArg,
  resetChatBackend,
  resetChatModel,
  resolveChatBackendPair,
  selectChatModel,
  setChatEffortLevel,
  switchChatBackend,
  type ModelCommandDeps,
  type ModelOverview,
} from "./model-commands.js";

/** How many catalog entries `/model` prints before pointing at `/model <id>`. */
const MAX_LISTED_MODELS = 40;

// ── Renderers ───────────────────────────────────────────────────────────────

function renderModelOverview(view: ModelOverview): string {
  const lines: string[] = [];
  lines.push(
    view.activeModel
      ? `**Model:** \`${view.activeModel}\`${
          view.activeDisplay && view.activeDisplay !== view.activeModel
            ? ` (${view.activeDisplay})`
            : ""
        }${view.hasModelOverride ? " — chat override" : ""}`
      : "**Model:** none selected — messages will be refused until you pick one",
  );
  lines.push(
    `**Backend:** ${view.backendLabel} (\`${view.backendId}\`)${view.hasBackendOverride ? " — chat override" : ""}`,
  );
  if (view.backends.length > 1) {
    lines.push(
      `Backends: ${view.backends.map((b) => `\`${b.id}\``).join(", ")} — \`/model <backend>\` switches (session restarts).`,
    );
  }
  if (view.choices.length === 0) {
    lines.push(
      "",
      "This backend has no browsable catalog; `/model <id>` sets one directly.",
    );
  } else {
    lines.push("", `**Models** (${view.choices.length}):`);
    for (const c of view.choices.slice(0, MAX_LISTED_MODELS)) {
      const marker = c.id === view.activeModel ? " ✓" : "";
      const free = c.free ? " · free" : "";
      lines.push(`${c.index}. ${c.displayName} — \`${c.id}\`${free}${marker}`);
    }
    if (view.choices.length > MAX_LISTED_MODELS) {
      lines.push(
        `… ${view.choices.length - MAX_LISTED_MODELS} more — \`/model <id>\` picks any of them.`,
      );
    }
  }
  lines.push(
    "",
    "`/model <number>` or `/model <id>` picks; `/model default` clears the chat's pick" +
      (view.hasBackendOverride
        ? "; `/model backend default` reverts the backend."
        : "."),
  );
  return lines.join("\n");
}

function renderSettings(
  view: ModelOverview,
  effort: { current: string; levels: string[] },
  pulseOn: boolean,
  pulseIntervalMs: number | undefined,
  freeOnly: boolean,
): string {
  const lines = [
    "**Settings**",
    `Model: \`${view.activeModel ?? "none selected"}\`${view.hasModelOverride ? " (chat override)" : ""}`,
    `Backend: ${view.backendLabel} (\`${view.backendId}\`)${view.hasBackendOverride ? " (chat override)" : ""}`,
    `Effort: ${effort.current}${effort.levels.length ? ` — levels: ${effort.levels.join(", ")}` : ""}`,
    `Pulse: ${pulseOn ? "on" : "off"} (every ${formatDuration(pulseIntervalMs ?? DEFAULT_PULSE_INTERVAL_MS)})`,
  ];
  if (freeOnly) lines.push("Free-only models: on");
  lines.push(
    "",
    "Change with `/model`, `/effort`; `/reset` starts a fresh session.",
  );
  return lines.join("\n");
}

function renderStatus(s: SessionStatusData): string {
  const used = s.context.known ? formatTokenCount(s.context.used) : "unknown";
  const max = s.context.max > 0 ? formatTokenCount(s.context.max) : "unknown";
  const pct = s.context.known ? `${s.context.pct}%` : "unknown";
  const lines = [
    `**Talon** · \`${formatModelLabel(s.activeModel)}\`${s.backendLabel ? ` · ${s.backendLabel}` : ""} · effort: ${s.effortName}${s.turnInProgress ? " · ⏳ turn running" : ""}`,
    "",
    `**Context** ${used} / ${max} (${pct})${s.context.warn ? " ⚠️ consider /reset" : ""}`,
    `\`${s.context.bar}\``,
    "",
    "**Session stats**",
    `Response: last ${s.lastResponseMs ? formatDuration(s.lastResponseMs) : "—"} · avg ${s.avgResponseMs ? formatDuration(s.avgResponseMs) : "—"} · best ${s.fastestMs ? formatDuration(s.fastestMs) : "—"}`,
    `Turns: ${s.turns}${s.turnsModelLabel ? ` (${formatModelLabel(s.turnsModelLabel)})` : ""}`,
    `Tokens: in ${formatTokenCount(s.inputTokens)} · out ${formatTokenCount(s.outputTokens)}${s.costUsd > 0 ? ` · cost ${formatUsd(s.costUsd)}` : ""}`,
  ];
  if (s.cache) {
    lines.push(
      `Cache: ${s.cache.hitPct}% hit · read ${formatTokenCount(s.cache.read)}${s.cache.showsWrite ? ` · write ${formatTokenCount(s.cache.write)}` : ""}`,
    );
  }
  if (s.cacheTemp) lines.push(formatCacheTempLine(s.cacheTemp));
  if (s.plan) {
    lines.push(
      "",
      `**Plan**${s.plan.plan ? ` ${s.plan.plan}` : ""}${s.plan.ageLabel ? ` (${s.plan.ageLabel})` : ""}`,
      ...s.plan.windows.map(
        (w) =>
          `\`${w.label.padEnd(6)}${w.bar} ${String(w.percent).padStart(3)}%\`${w.resetLabel ? ` reset ${w.resetLabel}` : ""}`,
      ),
    );
  }
  lines.push(
    "",
    `**Pulse** ${s.pulseOn ? "on" : "off"}`,
    `**Workspace** ${formatBytes(s.diskBytes)}`,
    `**Session** ${s.sessionName ? `"${s.sessionName}" ` : ""}${s.sessionId ? `\`${s.sessionId.slice(0, 8)}…\`` : "(new)"} · ${s.sessionAge} old`,
    `**Uptime** ${s.uptime} · ${s.activeSessionCount} active session${s.activeSessionCount === 1 ? "" : "s"}`,
    `**Runtime** ${s.runtime} · ${formatBytes(s.rssBytes)} RSS`,
    formatDaemonLine(s.daemon),
  );
  return lines.join("\n");
}

// ── Replies ─────────────────────────────────────────────────────────────────

/**
 * How a frontend changes backend. By default the shared switch runs, with
 * `keepHistory` deciding whether the local chat log survives it; a
 * frontend that owns more per-chat state than the shared stores (the
 * native bridge's turn meta and cached readouts) supplies its own.
 */
export type BackendSwitchHooks = {
  keepHistory?: boolean;
  switchBackend?: (target: { id: string; label: string }) => Promise<string>;
  resetBackend?: () => Promise<string>;
};

/** `/model [arg]`: the listing, or the pick the argument names. */
export async function modelCommandReply(
  chatId: string,
  arg: string,
  deps: ModelCommandDeps,
  hooks: BackendSwitchHooks = {},
): Promise<string> {
  if (!arg) return renderModelOverview(await describeChatModels(chatId, deps));
  const lower = arg.toLowerCase();
  const keepHistory = hooks.keepHistory === true;
  if (lower === "backend default" || lower === "backend reset") {
    if (hooks.resetBackend) return hooks.resetBackend();
    return (await resetChatBackend(chatId, deps, { keepHistory })).text;
  }
  if (lower === "reset" || lower === "default") {
    return (await resetChatModel(chatId, deps)).text;
  }
  const backend = matchBackendArg(arg, deps.config);
  if (backend) {
    if (hooks.switchBackend) return hooks.switchBackend(backend);
    return (await switchChatBackend(chatId, backend, deps, { keepHistory }))
      .text;
  }
  return (await selectChatModel(chatId, arg, deps)).text;
}

/** `/effort [level]`: the current level and the choices, or the change. */
export async function effortCommandReply(
  chatId: string,
  arg: string,
  deps: ModelCommandDeps,
): Promise<string> {
  if (arg) return (await setChatEffortLevel(chatId, arg, deps)).text;
  const effort = await describeChatEffort(chatId, deps);
  if (effort.levels.length === 0) {
    return `No reasoning levels available for ${effort.activeModel ?? "the active model"} on backend ${effort.backendId}.`;
  }
  return `**Effort:** ${effort.current}\nLevels: ${effort.levels.join(", ")}, or adaptive — \`/effort <level>\` sets one.`;
}

/** `/settings`: model, backend, effort and pulse in one listing. */
export async function settingsCommandReply(
  chatId: string,
  deps: ModelCommandDeps,
): Promise<string> {
  const [view, effort] = await Promise.all([
    describeChatModels(chatId, deps),
    describeChatEffort(chatId, deps),
  ]);
  const sets = getChatSettings(chatId);
  return renderSettings(
    view,
    effort,
    isPulseEnabled(chatId),
    sets.pulseIntervalMs,
    sets.freeOnly === true,
  );
}

/** `/status`: session, context, usage and daemon stats. */
export async function statusCommandReply(
  chatId: string,
  deps: ModelCommandDeps,
): Promise<string> {
  const { backend, backendId } = resolveChatBackendPair(chatId, deps);
  return renderStatus(
    await collectSessionStatus(chatId, deps.config, backend, backendId),
  );
}
