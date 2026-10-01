/**
 * SDK options builder — constructs the configuration object for query() calls.
 *
 * Translates per-chat settings (model, effort) and global config (plugins,
 * MCP servers, system prompt) into the Options shape expected by the SDK.
 */

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  PostToolBatchHookInput,
  PostToolUseFailureHookInput,
  NotificationHookInput,
  StopFailureHookInput,
  HookCallback,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type { PreparedSystemPrompt } from "../runtime/prompt/system-prompt.js";
import { getSession } from "../../storage/sessions.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { resolveModelId } from "../../core/models/catalog.js";
import { isTurnTerminator } from "../../core/tools/index.js";
import {
  talonHubUrl,
  pluginHubUrl,
  hubPluginServerNames,
} from "../../core/mcp-hub/index.js";
import {
  nonTerminalFrontends,
  frontendsForChat,
} from "../runtime/frontends.js";
import { toolFingerprint } from "../runtime/cache/cache-telemetry.js";
import { reportToolFingerprint } from "../runtime/cache/cache-metrics.js";
import { log, logError } from "../../util/log.js";
import {
  GATEWAY_TOKEN_ENV,
  gatewayToken,
} from "../../core/engine/gateway-auth.js";
import { getConfig, getBridgePort } from "./state.js";
import {
  ALLOWED_TOOLS_CHAT,
  CLAUDE_RETENTION_SETTINGS,
  EFFORT_MAP,
} from "./constants.js";
import {
  isGuestTurn,
  isGuestPluginAllowed,
} from "../../core/mcp-hub/guest-scope.js";
import { VALID_TOOL_FRONTENDS } from "../../core/mcp-hub/talon-server.js";

/** `telegram-tools`, `whatsapp-tools`, ... — the hub's own frontend servers. */
function isFrontendToolServerName(name: string): boolean {
  return name.endsWith("-tools") && VALID_TOOL_FRONTENDS.has(name.slice(0, -6));
}

/**
 * Built-in SDK tools that Talon's native tool set replaces when
 * `config.nativeTools` is on. The shell/filesystem built-ins map 1:1 to
 * bash/read/write/edit/glob/search; `Agent` (sub-agent dispatch) is dropped
 * alongside them per the owner's preference for the native surface.
 */
const NATIVE_REPLACED_BUILTINS = new Set<string>([
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash",
  "Glob",
  "Grep",
  "Agent",
]);

// ── Types ────────────────────────────────────────────────────────────────────

export type BuildSdkOptionsResult = {
  options: Options;
  activeModel: string;
  session: ReturnType<typeof getSession>;
};

// ── MCP server construction ─────────────────────────────────────────────────

/**
 * Return the list of configured non-terminal frontends. Every entry here
 * corresponds to an MCP server spawned by `buildMcpServers` as
 * `${frontend}-tools` (e.g. `telegram-tools`, `teams-tools`).
 *
 * Returns an empty array when only `terminal` is configured (or when no
 * frontends are configured at all). Terminal mode has no outbound messaging
 * surface — the agent runs to stdout instead.
 *
 * Throws if the agent config hasn't been initialised (callers in test paths
 * should wrap in try/catch and treat as "no frontends available").
 */
export function getActiveFrontends(): readonly string[] {
  return nonTerminalFrontends(getConfig().frontend);
}

/** Hub-backed MCP server entry — the SDK's `type: "http"` config. */
export type HubMcpEntry = {
  type: "http";
  url: string;
  /** Gateway bearer token — see `hubAuthHeaders`. */
  headers: Record<string, string>;
  alwaysLoad?: boolean;
  /** Per-server tool-call timeout in ms (overrides MCP_TOOL_TIMEOUT). */
  timeout?: number;
};

/**
 * Tool-call timeout for the Talon frontend tool servers. Must sit ABOVE the
 * bridge's largest per-action budget (1h for uncapped device file transfers)
 * so the layer that times out is the bridge — whose error names the action,
 * the budget, and warns the operation may still be running — rather than the
 * SDK's generic MCP timeout, which tells the model nothing actionable.
 */
const FRONTEND_TOOL_CALL_TIMEOUT_MS = 3_900_000; // 65 min

/**
 * Hub auth header for the Claude CLI's MCP config. The SDK hands that config
 * to the CLI on its command line, which other local accounts can read — so
 * the header carries a `${TALON_GATEWAY_TOKEN}` reference the CLI expands
 * from its environment (inherited from the daemon), never the value itself.
 * `gatewayToken()` runs first so the variable is guaranteed to be exported.
 */
function hubAuthHeaders(): Record<string, string> {
  gatewayToken();
  return { Authorization: `Bearer \${${GATEWAY_TOKEN_ENV}}` };
}

/**
 * Build the MCP servers map for a chat query.
 * Includes frontend-specific tool servers and Brave Search, if configured.
 *
 * Every entry points at the daemon's MCP hub (`core/mcp-hub`) over
 * streamable HTTP: the Talon tool servers run in-process there (zero
 * subprocesses per chat — chat binding travels in the URL, not env),
 * and brave-search is a single hub-managed child shared by all chats.
 */
export function buildMcpServers(chatId: string): Record<string, HubMcpEntry> {
  const config = getConfig();
  const bridgeUrl = `http://127.0.0.1:${getBridgePort()}`;

  const servers: Record<string, HubMcpEntry> = {};

  // Scope to the chat's owning frontend: a native-app chat gets
  // native-tools only, not every configured frontend's server (stray
  // mcp__telegram-tools__* in a native chat is confusing UI and a
  // wrong-surface delivery hazard). Cross-surface contexts (heartbeat,
  // one-shots) keep the full set.
  for (const frontend of frontendsForChat(chatId, getActiveFrontends())) {
    servers[`${frontend}-tools`] = {
      type: "http",
      url: talonHubUrl(bridgeUrl, frontend, chatId),
      headers: hubAuthHeaders(),
      // Always include the frontend's tools in the turn-1 prompt instead of
      // deferring them behind the SDK's tool search. These are the bot's
      // primary surface — it needs `end_turn`/`send`/`react` on EVERY turn to
      // reply at all. When deferred, the SDK evicts their schemas between
      // turns, so a bare `end_turn` fails with "no such tool" and the user's
      // reply silently doesn't send (the model has to burn a round-trip
      // re-fetching the schema via tool_search first). `alwaysLoad` also
      // blocks startup until this server is connected (capped at the 5s MCP
      // connect timeout) so the tools are present when the first prompt is
      // built — fixing the post-restart race where turn-1 ran before the
      // server finished connecting. Per-tool `_meta['anthropic/alwaysLoad']`
      // does NOT add that blocking, which is why server-level is the correct
      // lever here. Cost: ~50 frontend tool schemas loaded every turn (~10k
      // tokens, cached, negligible on the 1M-context models Talon runs).
      alwaysLoad: true,
      // Outlast the bridge's 1h transfer budget — see the constant's doc.
      timeout: FRONTEND_TOOL_CALL_TIMEOUT_MS,
    };
  }

  // Brave Search MCP server (if configured)
  if (config.braveApiKey) {
    servers["brave-search"] = {
      type: "http",
      url: pluginHubUrl(bridgeUrl, "brave-search", chatId),
      headers: hubAuthHeaders(),
    };
  }

  return servers;
}

/**
 * Build the plugin MCP server map for a chat query — hub URLs for every
 * registry-provided plugin server, optionally filtered to `only` plugin
 * names (heartbeat/dream tiers restrict their tool surface this way).
 */
export function buildPluginMcpServers(
  chatId: string,
  only?: string[],
): Record<string, HubMcpEntry> {
  const bridgeUrl = `http://127.0.0.1:${getBridgePort()}`;
  const servers: Record<string, HubMcpEntry> = {};
  for (const name of hubPluginServerNames(only)) {
    servers[name] = {
      type: "http",
      url: pluginHubUrl(bridgeUrl, name, chatId),
      headers: hubAuthHeaders(),
    };
  }
  return servers;
}

// ── Hooks ───────────────────────────────────────────────────────────────────

/**
 * Build the turn-terminator hook pair (PostToolUseFailure + PostToolBatch).
 *
 * These two hooks coordinate through a per-session `Set<tool_use_id>` of
 * terminator tools whose `execute()` threw. The set is shared by closure —
 * one Set per `buildSdkOptions` call, so concurrent chat sessions never
 * leak failure flags into each other.
 *
 * Design choices:
 *
 * - **Why PostToolBatch for the terminate decision** (vs PostToolUse): batch
 *   fires exactly once after every tool in the batch has resolved, so there
 *   are no in-flight siblings to race with. PostToolUse fires per-tool and
 *   can race with sibling MCP tools whose AbortControllers haven't completed
 *   — the same race that killed the earlier `qi.interrupt()` approach (commit
 *   `d5ce30f`).
 *
 * - **Why also PostToolUseFailure**: when a terminator tool's `execute()`
 *   throws (e.g. `end_turn` throws because the bridge returned `{ok:false}`),
 *   the SDK fires PostToolUseFailure with `{tool_name, error, is_interrupt}`.
 *   That's a typed, content-free signal that the call failed — vastly more
 *   robust than sniffing `tool_response` bodies for `"ok":false` substrings.
 *   The hook records the failed `tool_use_id`; PostToolBatch consults the
 *   set when deciding whether to terminate.
 *
 * - **Why `is_interrupt: true` is ignored**: an interrupted tool isn't a
 *   delivery failure — it's the user (or the harness) cancelling the call
 *   mid-flight. Treating that as "preserve the loop" would leak interrupted
 *   sessions into zombie state.
 *
 * What this preserves:
 *
 * - Happy path: terminator succeeds → loop terminates → no phantom-typing
 *   round-trip (the ~2-3s perf win from PR #122).
 * - Failure path: terminator's execute() threw → loop stays alive → model
 *   sees the error in the next assistant turn and can retry / message the
 *   user. The bug fixed: prior to this hook pair, a failed terminator
 *   terminated the loop silently and the user saw nothing (canonical
 *   incident: 2026-05-13 13:11Z 4096-char overflow).
 */
function buildTurnTerminatorHooks(): {
  postToolUseFailureHook: HookCallback;
  postToolBatchHook: HookCallback;
} {
  const failedTerminatorIds = new Set<string>();

  const postToolUseFailureHook: HookCallback = async (
    input,
  ): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PostToolUseFailure") {
      return { continue: true };
    }
    const failure = input as PostToolUseFailureHookInput;
    // Interrupts are not delivery failures — don't treat them as recoverable.
    if (failure.is_interrupt) return { continue: true };

    // Pass tool_input so soft-terminator react (`end_turn: false`) doesn't
    // get tracked here. If the call wasn't acting as a terminator, the
    // PostToolBatch path would have continued the loop anyway.
    if (!isTurnTerminator(failure.tool_name, failure.tool_input)) {
      return { continue: true };
    }

    failedTerminatorIds.add(failure.tool_use_id);
    log(
      "agent",
      `PostToolUseFailure: ${failure.tool_name} (${failure.tool_use_id}) ` +
        `failed — flagging for loop preservation. error: ${failure.error}`,
    );
    return { continue: true };
  };

  const postToolBatchHook: HookCallback = async (
    input,
  ): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PostToolBatch") {
      return { continue: true };
    }
    const batch = input as PostToolBatchHookInput;
    const terminator = batch.tool_calls.find((tc) =>
      isTurnTerminator(tc.tool_name, tc.tool_input),
    );
    if (!terminator) {
      return { continue: true };
    }

    // If the terminator failed, the failure hook flagged its tool_use_id.
    // Preserve the loop so the model can react to the error.
    if (failedTerminatorIds.has(terminator.tool_use_id)) {
      failedTerminatorIds.delete(terminator.tool_use_id);
      log(
        "agent",
        `PostToolBatch: ${terminator.tool_name} failed — keeping SDK loop ` +
          `alive so the model can read the error and retry`,
      );
      return { continue: true };
    }

    log(
      "agent",
      `PostToolBatch: terminating SDK loop on ${terminator.tool_name} ` +
        `(batch size: ${batch.tool_calls.length})`,
    );
    return {
      continue: false,
      stopReason: "turn terminated by end_turn / send",
    };
  };

  return { postToolUseFailureHook, postToolBatchHook };
}

/**
 * Notification hook: log SDK-generated notifications (e.g. context compaction,
 * model switches, rate-limit advisories) that are otherwise silently dropped.
 *
 * These events fire asynchronously during a query session and carry a
 * `notification_type` string and a human-readable `message`. Surfacing them in
 * the agent log makes the lifecycle of a session visible — previously the only
 * evidence of compaction or a model switch was an increase in cache-write tokens
 * in the post-turn accounting line.
 *
 * Returns `{ continue: true }` — the hook is purely observational.
 */
const notificationHook: HookCallback = async (
  input,
): Promise<HookJSONOutput> => {
  if (input.hook_event_name !== "Notification") {
    return { continue: true };
  }
  const n = input as NotificationHookInput;
  const titlePart = n.title ? ` [${n.title}]` : "";
  log(
    "agent",
    `[NOTIFICATION]${titlePart} type=${n.notification_type}: ${n.message}`,
  );
  return { continue: true };
};

/**
 * StopFailure hook: log SDK stop-failure events for error telemetry.
 *
 * `StopFailure` fires when the SDK loop exits abnormally — e.g. an API error
 * that bypasses the normal `result` message path. Without this hook the failure
 * is swallowed by the SDK and only the downstream catch block in handler.ts
 * sees it (as a thrown error), losing the `error_details` field that contains
 * the raw API response. Logging it here preserves the full context.
 *
 * Returns `{ continue: true }` — this hook cannot prevent the failure, only
 * record it.
 */
const stopFailureHook: HookCallback = async (
  input,
): Promise<HookJSONOutput> => {
  if (input.hook_event_name !== "StopFailure") {
    return { continue: true };
  }
  const sf = input as StopFailureHookInput;
  logError(
    "agent",
    `[STOP_FAILURE] error=${JSON.stringify(sf.error)}` +
      (sf.error_details ? ` details=${sf.error_details}` : ""),
  );
  return { continue: true };
};

// ── Options builder ─────────────────────────────────────────────────────────

/**
 * Build the SDK `systemPrompt` option from a prepared prompt.
 *
 * When a dynamic part exists, the prompt is sent as blocks split by
 * `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`: everything before the marker is the
 * static prefix the API can cache across sessions; everything after is
 * the volatile tail (workspace listing, daily-memory pointer) that
 * changes between rebuilds without invalidating the prefix.
 */
function toSdkSystemPrompt(prepared: PreparedSystemPrompt): string | string[] {
  if (!prepared.dynamicText) return prepared.staticText;
  return [
    prepared.staticText,
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    prepared.dynamicText,
  ];
}

export function buildSdkOptions(
  chatId: string,
  abortController?: AbortController,
  modelOverride?: string,
  preparedPrompt?: PreparedSystemPrompt,
): BuildSdkOptionsResult {
  const config = getConfig();
  const chatSettings = getChatSettings(chatId);
  const activeModel = modelOverride ?? chatSettings.model ?? config.model;
  const activeEffort = chatSettings.effort ?? "adaptive";
  const resolvedActiveModel = resolveModelId(activeModel);

  const thinkingConfig = EFFORT_MAP[activeEffort] ?? {
    thinking: { type: "adaptive" as const },
  };

  const session = getSession(chatId);

  // Per-session closure-shared state for the terminator hook pair (see
  // buildTurnTerminatorHooks docstring). Each chat gets its own failure set
  // so concurrent sessions never leak flags into each other.
  const { postToolUseFailureHook, postToolBatchHook } =
    buildTurnTerminatorHooks();

  // Guest turns (non-operator sender) get no SDK built-ins at all — Bash/Read/
  // Write/Skill live outside the hub, so the hub's guest scope can't hide
  // them — and only the plugin servers the guest scope allows.
  const guest = isGuestTurn(chatId);
  const builtinTools = guest
    ? []
    : config.nativeTools
      ? ALLOWED_TOOLS_CHAT.filter((t) => !NATIVE_REPLACED_BUILTINS.has(t))
      : [...ALLOWED_TOOLS_CHAT];

  const allServers = {
    ...buildMcpServers(chatId),
    ...buildPluginMcpServers(chatId),
  };
  const mcpServers = guest
    ? Object.fromEntries(
        Object.entries(allServers).filter(
          ([name]) =>
            isFrontendToolServerName(name) || isGuestPluginAllowed(name),
        ),
      )
    : allServers;

  // Tool definitions render BEFORE the system prompt, so a set that shifts
  // mid-session invalidates the system prompt and every cached message after
  // it — the most expensive cache event there is, and one the aggregate
  // hit-rate can't show. Plugin-provided MCP servers are the mutable part.
  reportToolFingerprint(
    chatId,
    toolFingerprint(builtinTools, Object.keys(mcpServers)),
  );

  const options: Options = {
    model: resolvedActiveModel,
    // Prefer the caller's frozen per-session prompt; fall back to the
    // global config split (warm-up and legacy callers), then to the
    // plain string for configs built without parts (tests).
    systemPrompt: preparedPrompt
      ? toSdkSystemPrompt(preparedPrompt)
      : config.systemPromptParts
        ? toSdkSystemPrompt({
            text: config.systemPrompt,
            staticText: config.systemPromptParts.staticText,
            dynamicText: config.systemPromptParts.dynamicText,
          })
        : config.systemPrompt,
    cwd: config.workspace,
    // The SDK's permission system is designed for an interactive Claude
    // Code IDE session where a human approves each tool call. Talon runs
    // the SDK as a server-side bot — there's no human at the keyboard
    // to confirm Bash/Edit/etc., and our security boundary is the bot
    // account itself (its OS user, its workspace dir, its mempalace),
    // not the SDK's per-tool prompts. `bypassPermissions` skips the
    // interactive prompts; `allowDangerouslySkipPermissions` is the
    // explicit acknowledgement the SDK requires alongside it. Treat
    // these as a unit — flipping either alone is a configuration bug.
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // Cancellation signal — when aborted, the SDK tears down the spawned
    // subprocess and stops streaming. The chat handler uses this both as a
    // shutdown hook for the daemon and as the kill-switch for a watchdog
    // that fires if the SDK iterator hangs after emitting `result`. The
    // happy-path SDK exit is owned by the PostToolBatch hook below; this
    // is defence in depth, not the primary terminator.
    ...(abortController ? { abortController } : {}),
    ...(config.claudeBinary
      ? { pathToClaudeCodeExecutable: config.claudeBinary }
      : {}),
    // Keep session transcripts: Talon resumes chats from them.
    settings: { ...CLAUDE_RETENTION_SETTINGS },
    // Whitelist of SDK built-in tools. Anything not listed (e.g. WebSearch,
    // WebFetch, Monitor, PushNotification, RemoteTrigger, Plan/Worktree/Todo
    // helpers, AskUserQuestion, ScheduleWakeup) is unavailable to the model.
    // MCP tools are governed independently via `mcpServers` below.
    //
    // When `config.nativeTools` is on, the SDK's built-in shell/filesystem
    // tools are dropped in favour of Talon's own native tools (which also
    // teleport onto companion devices), and Agent (sub-agent dispatch) is
    // removed too — the owner prefers the native surface without nested
    // agents. Flip the flag back off to restore the built-ins instantly.
    tools: builtinTools,
    ...thinkingConfig,
    mcpServers,
    hooks: {
      PostToolUseFailure: [{ hooks: [postToolUseFailureHook] }],
      PostToolBatch: [{ hooks: [postToolBatchHook] }],
      Notification: [{ hooks: [notificationHook] }],
      StopFailure: [{ hooks: [stopFailureHook] }],
    },
    ...(session.sessionId ? { resume: session.sessionId } : {}),
  };

  return { options, activeModel, session };
}
