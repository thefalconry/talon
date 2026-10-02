/**
 * Shared bootstrap logic used by both the main entry point (index.ts)
 * and the CLI chat command (cli.ts).
 *
 * Handles: config loading, env vars, plugin loading, workspace init,
 * storage loading, backend + dispatcher initialization.
 *
 * Frontend creation and lifecycle remain with the callers since they
 * differ (index.ts selects dynamically, cli.ts always uses terminal).
 */

import { loadConfig, rebuildSystemPrompt } from "./core/config/index.js";
import { initWorkspace } from "./core/vfs/workspace.js";
import { loadSessions, resetSession } from "./storage/sessions.js";
import { loadChatSettings } from "./storage/chat-settings.js";
import { loadCronJobs } from "./storage/cron.js";
import { loadTriggers } from "./storage/triggers.js";
import { loadHistory } from "./storage/history.js";
import { loadMediaIndex } from "./storage/media-index.js";
import { cleanupOldLogs } from "./storage/daily-log.js";
import {
  initDispatcher,
  execute as dispatcherExecute,
} from "./core/engine/dispatcher.js";
import { bus } from "./core/bus/index.js";
import { appendToJournal } from "./storage/journal.js";
import { initPulse, resetPulseTimer } from "./core/background/pulse/pulse.js";
import { initCron } from "./core/background/cron/scheduler.js";
import { initPlanAlerts } from "./core/background/pulse/plan-alerts.js";
import { setAdminNotifier } from "./core/frontend-runtime/admin-notify.js";
import { configureAlerts } from "./core/frontend-runtime/alerts.js";
import { startAuthExpiryMonitor } from "./core/auth/expiry-monitor.js";
import {
  initTriggers,
  resumeAfterRestart as resumeTriggersAfterRestart,
} from "./core/background/triggers/index.js";
import { initAgents } from "./core/agents/index.js";
import { initDream, maybeStartDream } from "./core/background/dream/index.js";
import { initHeartbeat } from "./core/background/heartbeat/index.js";
import { log, logWarn, logDebug } from "./util/log.js";
import { bootPhase } from "./core/daemon/boot-timer.js";
import { mapConcurrent } from "./util/concurrency.js";
import type { TalonConfig } from "./core/config/index.js";
import { resolveFrontendIdAmong } from "./core/frontend-runtime/routing.js";
import type { Frontend } from "./core/frontend-runtime/index.js";
import type { ContextManager } from "./core/types.js";
import type { Backend } from "./core/agent-runtime/capabilities.js";

// ── Types ────────────────────────────────────────────────────────────────────

// The Frontend contract moved to core/frontend-runtime/capabilities.ts
// (the frontend counterpart of agent-runtime). Re-exported so existing
// importers keep working.
export type { Frontend } from "./core/frontend-runtime/index.js";

type FrontendSelection = Frontend | Frontend[];

function normalizeFrontends(frontend: FrontendSelection): Frontend[] {
  const list = Array.isArray(frontend) ? frontend : [frontend];
  const byName = new Map<string, Frontend>();
  for (const item of list) byName.set(item.name, item);
  return [...byName.values()];
}

function resolveFrontend(
  chatId: string | undefined,
  frontends: Frontend[],
): Frontend {
  // Chat-id ownership and fallback order live in the frontend registry
  // (one source of truth shared with gateway routing and MCP scoping).
  const name = resolveFrontendIdAmong(
    chatId,
    frontends.map((f) => f.name),
  );
  const resolved = frontends.find((frontend) => frontend.name === name);
  if (!resolved) {
    throw new Error(`No frontend available for ${chatId ?? "unknown chat"}`);
  }
  return resolved;
}

function resolveFrontendByNumericId(
  chatId: number,
  stringId: string | undefined,
  frontends: Frontend[],
): Frontend {
  return resolveFrontend(stringId ?? String(chatId), frontends);
}

export type BootstrapOptions = {
  /** Override frontend names for plugin loading (e.g. ["terminal"]). */
  frontendNames?: string[];
  /**
   * Skip the boot steps that delete data (expired daily logs and memory
   * notes, expired media). Set when the pre-upgrade checkpoint failed:
   * with no snapshot to fall back on, this boot deletes nothing.
   */
  skipDestructiveSteps?: boolean;
};

export type BootstrapResult = {
  config: TalonConfig;
};

export type BackendAndDispatcherResult = {
  backend: Backend;
};

// ── Bootstrap: config, env, plugins, workspace, storage ──────────────────────

/**
 * Load config, set env vars, load plugins, init workspace, load all storage.
 * Returns the loaded config for further use by the caller.
 */
export async function bootstrap(
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const config = loadConfig();

  // Load plugins (external tool packages + built-in GitHub, MemPalace, mem0, Playwright)
  const hasPlugins =
    config.plugins.length > 0 ||
    config.github?.enabled === true ||
    config.mempalace?.enabled === true ||
    config.mem0?.enabled === true ||
    config.playwright?.enabled === true;
  if (hasPlugins) {
    const { loadPlugins, loadBuiltinPlugins, getPluginPromptAdditions } =
      await import("./core/plugin/index.js");

    // External plugins
    if (config.plugins.length > 0) {
      const frontends =
        options.frontendNames ??
        (Array.isArray(config.frontend) ? config.frontend : [config.frontend]);
      await bootPhase("plugins", () => loadPlugins(config.plugins, frontends));
    }

    // Built-in plugins (GitHub, MemPalace, mem0, Playwright) — shared with hot-reload
    await bootPhase("builtin plugins", () => loadBuiltinPlugins(config));

    rebuildSystemPrompt(config, getPluginPromptAdditions());
  }

  // MCP hub — daemon-hosted MCP-over-HTTP for every backend (tool
  // trimming + brave key come from config; endpoints mount on the
  // gateway HTTP server).
  const { initHub } = await import("./core/mcp-hub/index.js");
  const { setNativeToolsEnabled } =
    await import("./core/engine/gateway-actions/native/index.js");
  // The native shell/fs actions only answer when the tool set is on.
  setNativeToolsEnabled(config.nativeTools);
  initHub({
    disabledTools: config.disabledTools,
    disabledToolTags: config.disabledToolTags,
    braveApiKey: config.braveApiKey,
    nativeTools: config.nativeTools,
    guestDmScope: config.guestDmScope,
    adminUserId: config.adminUserId,
    operatorIds: [
      ...(config.operatorIds ?? []),
      ...(config.discord?.adminUserIds ?? []).map((id) => `discord:${id}`),
    ],
    guardChildren: true,
  });

  initWorkspace(config.workspace);
  await bootPhase("stores", () => {
    loadSessions();
    loadChatSettings();
    loadCronJobs();
    loadTriggers();
    loadHistory();
    loadMediaIndex({ purgeExpired: !options.skipDestructiveSteps });
  });
  if (options.skipDestructiveSteps) {
    logWarn(
      "bot",
      "Skipping boot-time cleanup (old daily logs, expired media): no pre-upgrade checkpoint to fall back on",
    );
  } else {
    cleanupOldLogs();
  }

  return { config };
}

// ── Backend + dispatcher wiring ──────────────────────────────────────────────

/**
 * Create the AI backend and wire the dispatcher.
 * Call this after creating the frontend.
 *
 * The backend controller (`core/engine/backend-controller.ts`) is the single
 * source of truth for the active backend. Dispatcher / dream /
 * heartbeat all read through `getActiveBackend()` so a runtime swap
 * via `switchBackend(id, config)` propagates without any re-init.
 */
/** The backend-controller surface `reconcileChatBindings` needs. */
type ChatBindingDeps = {
  isBackendAvailable: (id: string, config: TalonConfig) => boolean;
  releaseChat: (chatId: string) => Promise<void>;
  rebindChat: (
    chatId: string,
    backendId: string,
    config: TalonConfig,
  ) => Promise<{ ok: boolean; error?: string }>;
  getBackendIdForChat: (chatId: string) => string;
  getBackendForChat: (chatId: string) => Backend;
  isModelValidForBackend: (backend: Backend, model: string) => Promise<boolean>;
  /**
   * Tell the operator what the reconcile changed — once per boot, one
   * message for every chat. Defaults to an operator alert.
   */
  notify?: (text: string) => void;
};

const CHAT_BINDING_CONCURRENCY = 8;
const REBIND_RETRY_DELAY_MS = 1_500;
const ONE_MILLION_SUFFIX = /\s*\[1m\]$/i;

/**
 * Re-establish every chat's stored backend/model override against the
 * backends this boot actually has. Chats are independent, so they are
 * reconciled `CHAT_BINDING_CONCURRENCY` at a time; a shared backend that
 * two chats need at once is initialised exactly once by the pool.
 *
 * Never deletes chat history. A stale override is corrected (remapped to
 * the closest valid id, or cleared so the backend default serves) and the
 * operator is told once, naming every chat that changed. Only a chat whose
 * backend is gone gets a fresh backend session — its old session id is
 * archived by `resetSession`, and its history rows stay.
 */
export async function reconcileChatBindings(
  config: TalonConfig,
  deps: ChatBindingDeps,
): Promise<void> {
  const { getAllChatSettings } = await import("./storage/chat-settings.js");
  const changes: string[] = [];
  await mapConcurrent(
    Object.entries(getAllChatSettings()),
    CHAT_BINDING_CONCURRENCY,
    async ([cid, settings]) => {
      const change = await reconcileChatBinding(cid, settings, config, deps);
      if (change) changes.push(`• ${cid}: ${change}`);
    },
  );
  if (changes.length === 0) return;
  const text =
    `Boot reconcile adjusted ${changes.length} chat(s) whose pinned backend/model ` +
    `is no longer available (chat history kept):\n${changes.sort().join("\n")}`;
  logWarn("bot", text);
  (deps.notify ?? defaultReconcileNotify)(text);
}

function defaultReconcileNotify(text: string): void {
  void import("./core/frontend-runtime/alerts.js").then(({ raiseAlert }) =>
    raiseAlert("chat-bindings.reconciled", text, { severity: "warn" }),
  );
}

/**
 * The closest valid id for a model the catalog no longer lists, or null.
 * Today: `<id>[1m]` → `<id>` (SDK catalogs stopped enumerating the 1M
 * context variants), so a chat keeps its model family instead of being
 * dropped to the backend default.
 */
async function remapModelAlias(
  backend: Backend,
  model: string,
  deps: ChatBindingDeps,
): Promise<string | null> {
  if (!ONE_MILLION_SUFFIX.test(model)) return null;
  const stem = model.replace(ONE_MILLION_SUFFIX, "").trim();
  if (!stem) return null;
  return (await deps.isModelValidForBackend(backend, stem)) ? stem : null;
}

/**
 * Reconcile one chat. Returns a short description of what changed, or
 * null when nothing did.
 */
async function reconcileChatBinding(
  cid: string,
  settings: { backend?: string; model?: string },
  config: TalonConfig,
  deps: ChatBindingDeps,
): Promise<string | null> {
  const changes: string[] = [];
  if (settings.backend) {
    const change = await reconcileChatBackend(
      cid,
      settings.backend,
      config,
      deps,
    );
    if (change) changes.push(change);
  }
  const bindingMatchesSetting =
    !settings.backend || deps.getBackendIdForChat(cid) === settings.backend;
  if (bindingMatchesSetting) {
    const change = await reconcileChatModel(cid, deps);
    if (change) changes.push(change);
  }
  return changes.length > 0 ? changes.join("; ") : null;
}

async function reconcileChatBackend(
  cid: string,
  backendId: string,
  config: TalonConfig,
  deps: ChatBindingDeps,
): Promise<string | null> {
  const { setChatBackend, clearLegacyChatModel } =
    await import("./storage/chat-settings.js");
  if (!deps.isBackendAvailable(backendId, config)) {
    logWarn(
      "bot",
      `Per-chat backend ${backendId} for ${cid} is no longer available — serving the chat on the default backend (history kept)`,
    );
    await deps.releaseChat(cid);
    setChatBackend(cid, undefined);
    // The per-backend model picks stay: they are keyed by backend, so the
    // default backend's pick (if any) still applies and the vanished
    // backend's comes back with it. Only the unkeyed legacy slot goes.
    clearLegacyChatModel(cid);
    // The stored session belongs to the vanished backend and cannot resume
    // on another one. resetSession archives its id; history is untouched.
    resetSession(cid, "backend-unavailable");
    return `backend ${backendId} unavailable → default backend`;
  }
  let result = await deps.rebindChat(cid, backendId, config);
  if (!result.ok) {
    await new Promise((r) => setTimeout(r, REBIND_RETRY_DELAY_MS));
    result = await deps.rebindChat(cid, backendId, config);
  }
  if (!result.ok) {
    log(
      "bot",
      `Per-chat backend rebind failed for ${cid} → ${backendId}: ${result.error} — keeping the setting; will serve on the default backend until re-selected`,
    );
  }
  return null;
}

/**
 * Check the chat's pinned model against the backend that serves it.
 * The unkeyed legacy slot is remapped or cleared when stale; a per-backend
 * pick is only ever remapped (the send-time resolver already falls back
 * past a stale one, and a catalog that failed to load must not erase it).
 * The backend session is kept either way: a resume under a different
 * model is fine, and the conversation is the point.
 */
async function reconcileChatModel(
  cid: string,
  deps: ChatBindingDeps,
): Promise<string | null> {
  const {
    getAllChatSettings,
    getChatModelForBackend,
    setChatModelForBackend,
    clearLegacyChatModel,
  } = await import("./storage/chat-settings.js");
  const backendId = deps.getBackendIdForChat(cid);
  const legacy = getAllChatSettings()[cid]?.model;
  const model = legacy ?? getChatModelForBackend(cid, backendId);
  if (!model) return null;
  const be = deps.getBackendForChat(cid);
  try {
    if (await deps.isModelValidForBackend(be, model)) return null;
    const remapped = await remapModelAlias(be, model, deps);
    if (remapped) {
      setChatModelForBackend(cid, backendId, remapped);
      if (legacy) clearLegacyChatModel(cid);
      logWarn(
        "bot",
        `Per-chat model ${model} for ${cid} is not in the ${backendId} catalog — remapped to ${remapped} (history and session kept)`,
      );
      return `model ${model} → ${remapped}`;
    }
    if (!legacy) return null;
    clearLegacyChatModel(cid);
    logWarn(
      "bot",
      `Per-chat model ${model} for ${cid} is not valid for its backend — falling back to the backend default (history and session kept)`,
    );
    return `model ${model} unavailable → backend default`;
  } catch (err) {
    log(
      "bot",
      `Per-chat model validation failed for ${cid} (${model}): ${
        err instanceof Error ? err.message : String(err)
      } — keeping stored model`,
    );
    return null;
  }
}

export async function initBackendAndDispatcher(
  config: TalonConfig,
  frontend: FrontendSelection,
): Promise<BackendAndDispatcherResult> {
  const frontends = normalizeFrontends(frontend);

  // Register all built-in backends. Adding a new backend is strictly
  // additive: drop a `factory.ts` under the new backend dir and list it in
  // backend/builtins.ts. No conditionals here change.
  const { loadBuiltinBackends } = await import("./backend/builtins.js");
  await loadBuiltinBackends(config);

  const {
    initBackendPool,
    getBackendForRole,
    getBackendIdForRole,
    getBackendForChat,
    getBackendIdForChat,
    rebindChat,
    releaseChat,
    isBackendAvailable,
    isModelValidForBackend,
  } = await import("./core/engine/backend-controller/index.js");

  // Boot the backend pool — binds the chat / heartbeat / dream roles
  // from `config.backend`, `config.heartbeatBackend`,
  // `config.dreamBackend`. When two roles point at the same id the
  // pool reuses one instance (refcounted) — a single-backend setup
  // still spins up exactly one instance.
  await initBackendPool(config, {
    getBridgePort: () => resolveFrontend(undefined, frontends).getBridgePort(),
    frontendName: resolveFrontend(undefined, frontends).name,
  });
  const backend = getBackendForRole("chat");

  // Model audit — verify the models pinned in config still exist on
  // their backends. A withdrawn model silently runs the backend
  // default; this is the one loud signal that the config is stale.
  // Fire-and-forget: never blocks or fails boot.
  void (async () => {
    try {
      const { auditConfiguredModels } =
        await import("./core/engine/model-audit.js");
      const findings = await auditConfiguredModels(config, (role) =>
        getBackendForRole(role),
      );
      for (const finding of findings) {
        logWarn("config", `[MODEL AUDIT] ${finding.message}`);
      }
    } catch (err) {
      logDebug("config", `Model audit skipped: ${String(err)}`);
    }
  })();

  const context: ContextManager = {
    acquire(chatId: number, stringId?: string, frontendName?: string): void {
      const frontendToUse =
        frontends.find((item) => item.name === frontendName) ??
        resolveFrontendByNumericId(chatId, stringId, frontends);
      frontendToUse.context.acquire(chatId, stringId, frontendToUse.name);
    },
    release(chatId: number, stringId?: string): void {
      resolveFrontendByNumericId(chatId, stringId, frontends).context.release(
        chatId,
        stringId,
      );
    },
    getMessageCount(chatId: number, stringId?: string): number {
      return resolveFrontendByNumericId(
        chatId,
        stringId,
        frontends,
      ).context.getMessageCount(chatId, stringId);
    },
  };

  // One-shot legacy migration: any chat-settings entry still holding
  // the old single-slot `model` field gets moved into
  // `modelByBackend[chatSettings.backend ?? config.backend]`. Idempotent;
  // safe to call on every boot. After this point the resolver no longer
  // needs the legacy-fallback branch — every active chat's model lives
  // in the per-backend map.
  const { migrateLegacyModelField } =
    await import("./storage/chat-settings.js");
  migrateLegacyModelField(config.backend, (id) =>
    isBackendAvailable(id, config),
  );

  // Re-acquire any persisted per-chat backend/model overrides so chats
  // resume exactly where they were before restart. A backend that has
  // since gone, or a stored model its backend no longer lists, is
  // corrected (remapped or cleared to the default) — never by deleting
  // the chat's history. See reconcileChatBindings.
  await bootPhase("chat bindings", () =>
    reconcileChatBindings(config, {
      isBackendAvailable,
      releaseChat,
      rebindChat,
      getBackendIdForChat,
      getBackendForChat,
      isModelValidForBackend,
    }),
  );

  initDispatcher({
    // Dispatcher reads the backend per query so per-chat overrides
    // and chat-role rebinds both propagate without re-init. The
    // chat id is always present from the dispatcher, but the type
    // is `chatId?: string` to keep test stubs simple — fall back to
    // the chat-role default if a caller ever passes `undefined`.
    getBackend: (chatId?: string) =>
      chatId ? getBackendForChat(chatId) : getBackendForRole("chat"),
    // Send-time guard: the dispatcher walks the active-model chain
    // before calling backend.query. When `model` is null (catalog-
    // driven backend with no per-chat pick and no operator default),
    // dispatcher refuses and replies with a /model prompt instead
    // of submitting an empty id to the backend.
    resolveActiveModel: async (chatId: string) => {
      const { resolveActiveModelForChat } =
        await import("./core/models/active-model.js");
      const { getBackendIdForChat, getBackendForChat: getBE } =
        await import("./core/engine/backend-controller/index.js");
      const beId = getBackendIdForChat(chatId);
      const be = getBE(chatId);
      const { model, ref } = await resolveActiveModelForChat(
        chatId,
        be,
        beId,
        config,
      );
      return { model, ref, backendId: beId };
    },
    // Per-run model override (triggers/cron): validate + materialise an
    // explicit model id against the chat's backend. Returns null when the id
    // isn't selectable, so the dispatcher falls back to the chat model.
    // Restricted to the chat's own backend so the session still resumes.
    resolveModelOverride: async (chatId: string, modelId: string) => {
      const { resolveExplicitModelRef } =
        await import("./core/models/active-model.js");
      const { getBackendIdForChat, getBackendForChat: getBE } =
        await import("./core/engine/backend-controller/index.js");
      return resolveExplicitModelRef(
        modelId,
        getBE(chatId),
        getBackendIdForChat(chatId),
      );
    },
    context,
    sendTyping: async (chatId: number, stringId?: string) =>
      resolveFrontendByNumericId(chatId, stringId, frontends).sendTyping(
        chatId,
      ),
  });

  // Cross-subsystem reactions ride the bus, so the Weaver stays ignorant of
  // dream and pulse: a bound turn kicks the fire-and-forget dream check, a
  // completed turn resets the pulse idle timer.
  bus.subscribe("turn.started", () => maybeStartDream());
  bus.subscribe("turn.completed", () => resetPulseTimer());
  // The journal is the bus's durable tail: every published event lands in
  // talon.db so history survives restarts (`talon events --history`,
  // `talon ps --all`). Append failures are logged and swallowed inside.
  bus.subscribeAll((event) => appendToJournal(event));

  initPulse();
  // Warm the plan-aware router's token ledger from disk so the first
  // routing decision after a restart sees what the last run spent.
  void import("./core/engine/backend-router/index.js").then(
    ({ loadBackendLedger }) => loadBackendLedger(),
  );
  initCron({
    sendMessage: async (chatId: number, text: string, stringId?: string) =>
      resolveFrontendByNumericId(chatId, stringId, frontends).sendMessage(
        chatId,
        text,
      ),
    // Isolated cron query jobs with no model override fall back to the chat's
    // active model + backend.
    resolveChatModel: async (chatId: string) => {
      const { resolveActiveModelForChat } =
        await import("./core/models/active-model.js");
      const { getBackendIdForChat, getBackendForChat: getBE } =
        await import("./core/engine/backend-controller/index.js");
      const beId = getBackendIdForChat(chatId);
      const { model } = await resolveActiveModelForChat(
        chatId,
        getBE(chatId),
        beId,
        config,
      );
      return { model, backendId: beId };
    },
    // ...and when that ambient backend turns out to be one that can't host an
    // isolated run (e.g. the chat was switched to a provider with no background
    // capability), the job reruns on the heartbeat role backend instead of
    // being skipped.
    resolveJobFallback: () => ({
      backendId: config.heartbeatBackend ?? config.backend,
      model: config.heartbeatModel ?? config.model ?? null,
    }),
  });
  initWakeSubsystems(config);
  resumeTriggersAfterRestart().catch((err) =>
    log("triggers", `resumeAfterRestart failed: ${err}`),
  );

  initPlanAlerts({
    sendMessage: async (chatId: number, text: string, stringId?: string) =>
      resolveFrontendByNumericId(chatId, stringId, frontends).sendMessage(
        chatId,
        text,
      ),
    enabled: config.planAlerts,
    threshold: config.planAlertThreshold,
    chatId:
      config.planAlertChatId ??
      (config.adminUserId ? String(config.adminUserId) : undefined),
  });

  // Admin notification seam (core/notify.ts) — how a subsystem reaches
  // the operator when its own channel is the thing that is broken (the
  // first consumer is WhatsApp pairing: codes must travel over a LIVE
  // frontend, not the dead one's log). Same delivery route as the plan
  // alerts above.
  wireAdminNotifier(config, frontends);

  // Only enable mempalace dream integration if the plugin actually registered
  let mempalaceCfg: { pythonPath: string; palacePath: string } | undefined;
  if (config.mempalace?.enabled) {
    const { getPlugin } = await import("./core/plugin/index.js");
    if (getPlugin("mempalace")) {
      const { resolveMempalacePaths } =
        await import("./plugins/mempalace/provision.js");
      mempalaceCfg = resolveMempalacePaths(config.mempalace);
    } else {
      log(
        "mempalace",
        "Enabled in config but plugin not registered — skipping dream integration",
      );
    }
  }

  // Configure the Claude SDK one-shot runner once we know mempalace state.
  // Loaded unconditionally because dream/heartbeat may target the Claude SDK
  // backend even when the chat backend is Kilo/OpenCode in some setups.
  // For Kilo/OpenCode chat backends this is dead state — harmless.
  const { initClaudeOneShot } =
    await import("./backend/claude-sdk/one-shot.js");
  initClaudeOneShot({
    claudeBinary: config.claudeBinary,
    mempalace: mempalaceCfg,
  });

  initRecurringAgents(config, frontends, Boolean(mempalaceCfg), {
    getBackendForRole,
    getBackendIdForRole,
  });

  // Post-/update provisioning report — if the previous process armed one
  // before respawning, tell the chat that asked for the update what the
  // provisioners changed during this boot. Fire-and-forget; the delivery
  // helper retries while frontends finish registering on the cross-send
  // broker and gives up quietly.
  {
    const { deliverPendingProvisionReport } =
      await import("./core/plugin/provision-journal.js");
    const { crossSendHandlers } =
      await import("./core/engine/gateway-actions/cross-send.js");
    void deliverPendingProvisionReport(async (frontend, target, text) => {
      // Chat-free: the same "no chat" sentinels handleChatFreeAction passes.
      const result = await crossSendHandlers.send_via(
        { frontend, target, text },
        0,
        undefined,
        "0",
      );
      return Boolean(result && (result as { ok?: unknown }).ok === true);
    });
  }

  return { backend };
}

/**
 * Wire the dream and heartbeat agents — the two that run on their own
 * cadence rather than in reply to anything.
 *
 * Both bind late (`getBackend` is an accessor, not an instance) so a
 * `/model` rebind takes effect on the next run rather than needing a
 * restart. The heartbeat also declares whether the operator pinned its
 * backend, because the plan-aware router may only move an unpinned one.
 */
function initRecurringAgents(
  config: TalonConfig,
  frontends: { name: string }[],
  mempalace: boolean,
  roles: {
    getBackendForRole: (role: "heartbeat" | "dream") => Backend;
    getBackendIdForRole: (role: "heartbeat" | "dream") => string;
  },
): void {
  initDream({
    model: config.model,
    dreamModel: config.dreamModel,
    dreamEffort: config.dreamEffort,
    workspace: config.workspace,
    enabled: config.dream,
    getBackend: () => roles.getBackendForRole("dream"),
  });
  // The heartbeat names the `${frontend}-tools` MCP servers it actually
  // has, so it needs the non-terminal frontend list; a terminal-only
  // deployment gets a prompt with no outbound section at all.
  initHeartbeat({
    model: config.model,
    heartbeatModel: config.heartbeatModel,
    heartbeatEffort: config.heartbeatEffort,
    workspace: config.workspace,
    getBackend: () => roles.getBackendForRole("heartbeat"),
    getBackendId: () => roles.getBackendIdForRole("heartbeat"),
    ...(config.heartbeatBackend
      ? { pinnedBackendId: config.heartbeatBackend }
      : {}),
    frontends: frontends
      .filter((f) => f.name !== "terminal")
      .map((f) => f.name),
    mempalace,
  });
}

/**
 * Wire the two subsystems that wake a chat with a synthetic turn: trigger
 * scripts firing, and sub-agents reporting. Same dependency (the dispatcher),
 * same delivery shape, so they are wired together.
 */
function initWakeSubsystems(config: TalonConfig): void {
  initTriggers({
    execute: dispatcherExecute,
    ...(config.triggers ? { caps: config.triggers } : {}),
  });
  initAgents({
    execute: dispatcherExecute,
    ...(config.agents ? { caps: config.agents } : {}),
  });
}

/**
 * Wire the admin notification seam to the admin's frontend, and start the
 * login-expiry monitor that rides it: the CLIs' "N days to log in again"
 * banner, delivered to the admin instead of a terminal nobody is watching
 * (/auth then completes the sign-in from the chat). Operator alerts ride
 * the same seam, so their settings are applied here too.
 */
function wireAdminNotifier(
  config: TalonConfig,
  frontends: Parameters<typeof resolveFrontendByNumericId>[2],
): void {
  if (config.alerts) {
    configureAlerts({
      enabled: config.alerts.enabled,
      cooldownMs: config.alerts.cooldownMinutes * 60_000,
    });
  }
  if (!config.adminUserId) return;
  const adminChatId = config.adminUserId;
  setAdminNotifier(async (text: string) =>
    resolveFrontendByNumericId(
      adminChatId,
      String(adminChatId),
      frontends,
    ).sendMessage(adminChatId, text),
  );
  startAuthExpiryMonitor();
}
