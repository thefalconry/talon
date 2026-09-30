/**
 * Model / backend discovery — `list_models` and `list_backends`.
 *
 * A non-active backend may be booted transiently to read its catalog, then
 * released immediately so `list_models backend=<id>` can inspect any
 * registered provider without switching the chat.
 */

import {
  getBackendForChat,
  getBackendIdForChat,
  getAvailableBackends,
  getPoolConfig,
  getPooledBackend,
  acquireBackendInstance,
} from "../backend-controller/index.js";
import {
  collectBackendUsage,
  formatHeadroom,
  leadWith,
  type BackendHeadroom,
  type BackendUsageSnapshot,
} from "../backend-router/index.js";
import type { SharedActionHandlers } from "./types.js";

/**
 * Headroom as agents see it, to 2dp. `null` for an unmeasured backend: the
 * router scores those 0 so they are never preferred, but telling an agent
 * "0" would read as "spent", which is not known either.
 */
function headroomFigure(entry: BackendHeadroom): number | null {
  if (entry.source === "none" && !entry.unavailable) return null;
  return Math.round(entry.headroom * 100) / 100;
}

/** One `plan_usage` block: the headroom line, then any plan windows. */
function usageLines(entry: BackendUsageSnapshot): string[] {
  const head = `- ${entry.label || entry.id}: ${formatHeadroom(entry.headroom)}`;
  if (!entry.plan) {
    return [`${head}${entry.note ? ` (${entry.note})` : ""}`];
  }
  return [
    `${head}${entry.plan.plan ? ` · ${entry.plan.plan}` : ""}`,
    ...entry.plan.windows.map(
      (w) =>
        `    ${w.label}: ${w.percent}% used${w.resetsAt ? `, resets ${w.resetsAt}` : ""}`,
    ),
  ];
}

export const modelHandlers: SharedActionHandlers = {
  list_models: async (body, chatId, _backend, chatKey) => {
    const chatIdStr = chatKey;
    const currentId = getBackendIdForChat(chatIdStr);
    const requested = body.backend ? String(body.backend).trim() : "";
    const targetId = requested || currentId;

    const avail = getAvailableBackends().map((b) => b.id);
    if (!avail.includes(targetId))
      return {
        ok: false,
        error: `Unknown backend "${targetId}". Available backends: ${avail.join(", ") || "(none)"}.`,
      };

    // Prefer a live instance (the chat's backend, or one already pooled).
    // For any other registered backend, boot it transiently to read its
    // catalog, then tear it back down so we never leak an instance.
    let instance =
      targetId === currentId
        ? getBackendForChat(chatIdStr)
        : getPooledBackend(targetId);
    let release: (() => Promise<void>) | null = null;
    if (!instance) {
      try {
        const acquired = await acquireBackendInstance(targetId);
        instance = acquired.backend;
        release = acquired.release;
      } catch (err) {
        return {
          ok: false,
          error: `Could not load backend "${targetId}" to read its models: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    try {
      const catalog = instance.models;
      if (!catalog?.listModels)
        return {
          ok: true,
          backend: targetId,
          models: [],
          text: `Backend "${targetId}" runs a fixed model (no selectable model catalog).`,
        };

      const { models } = await catalog.listModels("all");
      const selectable = models.filter((m) => m.selectable);
      const slim = selectable.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        reasoning: m.reasoning ?? false,
        contextWindow: m.contextWindow,
        free: m.free ?? false,
      }));
      if (slim.length === 0)
        return {
          ok: true,
          backend: targetId,
          models: [],
          text: `Backend "${targetId}" exposes no selectable models.`,
        };
      const note = targetId === currentId ? "" : " (not this chat's backend)";
      const lines = slim.map((m) => {
        const bits = [
          m.reasoning ? "reasoning" : null,
          m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx` : null,
          m.free ? "free" : null,
        ].filter(Boolean);
        const name =
          m.displayName && m.displayName !== m.id ? ` (${m.displayName})` : "";
        return `- ${m.id}${name}${bits.length ? ` — ${bits.join(", ")}` : ""}`;
      });
      return {
        ok: true,
        backend: targetId,
        models: slim,
        text: `Selectable models on "${targetId}"${note} (${slim.length}):\n${lines.join("\n")}`,
      };
    } finally {
      if (release) await release();
    }
  },

  // Account-level and fleet-wide: every exposed backend, with the headroom
  // figure the plan-aware router ranks on — a backend with no usage API
  // still answers, from its local budget ledger. The chat's own backend
  // leads so a caller reading only the first entry sees what it used to.
  plan_usage: async (_body, chatId, _backend, chatKey) => {
    const currentId = getBackendIdForChat(chatKey);
    const entries = leadWith(
      await collectBackendUsage(getPoolConfig() ?? undefined, { force: true }),
      currentId,
    );
    if (entries.length === 0)
      return { ok: false, error: "No backends are available." };

    const lead = entries[0] as BackendUsageSnapshot;
    return {
      ok: true,
      // Kept for callers written against the single-backend shape.
      plan: lead.plan?.plan ?? null,
      windows: lead.plan?.windows ?? [],
      backends: entries.map((entry) => ({
        id: entry.id,
        label: entry.label,
        current: entry.id === currentId,
        headroom: headroomFigure(entry.headroom),
        source: entry.headroom.source,
        limiting: entry.headroom.limiting ?? null,
        stale: entry.headroom.stale ?? false,
        ...(entry.headroom.unavailable
          ? { unavailable: entry.headroom.unavailable }
          : {}),
        plan: entry.plan?.plan ?? null,
        windows: entry.plan?.windows ?? [],
        ...(entry.note ? { note: entry.note } : {}),
      })),
      text: `Plan usage and headroom by backend:\n${entries.flatMap(usageLines).join("\n")}`,
    };
  },

  list_backends: async (body, chatId, _backend, chatKey) => {
    const currentId = getBackendIdForChat(chatKey);
    const available = getAvailableBackends();
    if (available.length === 0)
      return { ok: true, backends: [], text: "No backends are available." };
    // Headroom comes off the router's 60s cache, so listing backends is
    // cheap even though it now answers "which one has room?" as well.
    const usage = await collectBackendUsage(getPoolConfig() ?? undefined);
    const byId = new Map(usage.map((entry) => [entry.id, entry]));
    const backends = available.map((b) => {
      const entry = byId.get(b.id);
      return {
        id: b.id,
        label: b.label,
        current: b.id === currentId,
        headroom: entry ? headroomFigure(entry.headroom) : null,
        headroomSource: entry?.headroom.source ?? null,
        ...(entry?.headroom.unavailable
          ? { unavailable: entry.headroom.unavailable }
          : {}),
      };
    });
    const lines = backends.map((b) => {
      const entry = byId.get(b.id);
      const room = entry ? ` — ${formatHeadroom(entry.headroom)} free` : "";
      return `- ${b.id}${b.label && b.label !== b.id ? ` (${b.label})` : ""}${b.current ? " — current" : ""}${room}`;
    });
    return {
      ok: true,
      backends,
      text: `Available backends (${backends.length}):\n${lines.join("\n")}`,
    };
  },
};
