/**
 * Claude SDK one-shot agent runner — used by heartbeat & dream.
 *
 * The heartbeat/dream modules own timing, locking, state, and the run log
 * file. This module owns everything Claude-SDK-specific: building the SDK
 * options dict, calling `query()`, formatting each SDK message into the run
 * log, and post-abort orphan-subprocess eviction (Linux /proc walk).
 *
 * Exposed via the Backend abstraction (see core/types.ts) so that
 * non-SDK backends (Kilo, OpenCode) can supply their own implementations
 * without heartbeat/dream knowing the difference.
 */

import { readdir, readFile } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { OneShotAgentParams, OneShotUsage } from "../../core/types.js";
import { log, logWarn } from "../../util/log.js";
import { ALLOWED_TOOLS_BACKGROUND } from "../../core/constants.js";
import { CLAUDE_RETENTION_SETTINGS, EFFORT_MAP } from "./constants.js";
import {
  DEFAULT_CLAUDE_ACCOUNT,
  sdkEnvFor,
  type ClaudeRunAccount,
} from "./accounts/account.js";
import { buildMcpServers, buildPluginMcpServers } from "./options.js";
import { isBackgroundToolContext } from "../../core/agents/context.js";
import { warnIfBelowCacheMinimum } from "../runtime/cache/cache-telemetry.js";
import { emitAssistantText, emitSessionId } from "../runtime/one-shot-hooks.js";
import {
  isOtherLiveDaemon,
  ownerFromEnviron,
} from "../../core/daemon/pidfile.js";

const DEFAULT_SUBPROCESS_KILL_GRACE_MS = 5 * 1000;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** SIGTERM → grace → SIGKILL window when force-killing orphan subprocesses. */
const SUBPROCESS_KILL_GRACE_MS = envMs(
  "TALON_HEARTBEAT_SUBPROCESS_KILL_GRACE_MS",
  DEFAULT_SUBPROCESS_KILL_GRACE_MS,
);

/**
 * Optional config the bootstrap layer passes in once at startup so
 * runOneShotAgent can locate the bundled `claude` binary and (for dream)
 * scope MCP servers to a specific plugin set.
 */
export type OneShotConfig = {
  claudeBinary?: string;
  /** MemPalace MCP config gate — only relevant for the dream context. */
  mempalace?: { pythonPath: string; palacePath: string };
};

let oneShotConfig: OneShotConfig = {};

export function initClaudeOneShot(cfg: OneShotConfig): void {
  oneShotConfig = cfg;
}

export async function runOneShotAgent(
  params: OneShotAgentParams,
  account: ClaudeRunAccount = DEFAULT_CLAUDE_ACCOUNT,
): Promise<OneShotUsage | void> {
  const {
    prompt,
    systemPrompt,
    workspace,
    model,
    reasoningEffort,
    contextLabel,
    abortController,
    appendLog,
    onAssistantText,
    resumeSessionId,
    onSessionId,
  } = params;

  // Reasoning effort is opt-in for background runs (config `heartbeatEffort`
  // / `dreamEffort`). Unset → omit the thinking options entirely so the SDK
  // keeps whatever default the model ships with, which is what these runs
  // did before the knob existed. The chat path applies an explicit
  // `{ thinking: { type: "adaptive" } }` fallback instead because a chat has
  // a persisted per-chat setting to honour; a one-shot has none.
  const thinkingConfig = reasoningEffort
    ? EFFORT_MAP[reasoningEffort]
    : undefined;
  // A sub-agent's private TMPDIR (and any other per-run vars) layered over
  // the daemon's environment — the SDK replaces, not merges, `env` — with
  // the account's CLAUDE_CONFIG_DIR on top.
  const env = sdkEnvFor(account, params.env);

  const options = {
    model,
    systemPrompt,
    ...thinkingConfig,
    cwd: workspace,
    ...(env ? { env } : {}),
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    abortController,
    ...(oneShotConfig.claudeBinary
      ? { pathToClaudeCodeExecutable: oneShotConfig.claudeBinary }
      : {}),
    // Keep session transcripts: interrupted sub-agents resume from them.
    settings: { ...CLAUDE_RETENTION_SETTINGS },
    mcpServers: assembleMcpServers(contextLabel),
    // Whitelist of SDK built-in tools for background contexts (heartbeat,
    // dream). Same as chat minus `Agent` — nested sub-agent dispatch from
    // inside an unattended pass complicates lifecycle tracking.
    tools: [...ALLOWED_TOOLS_BACKGROUND],
    // A sub-agent interrupted by a daemon restart continues its own SDK
    // session: the transcript (brief, tool calls, results) is intact on disk
    // and the prompt below is only the "you were interrupted" note.
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
  };
  if (resumeSessionId) {
    log(
      "agent",
      `[${contextLabel}] Claude one-shot resuming session ${resumeSessionId}`,
    );
  }

  if (reasoningEffort && !thinkingConfig) {
    // `minimal` / `xhigh` are Codex-side vocabulary with no Claude
    // equivalent in EFFORT_MAP — the run proceeds on the model default
    // rather than failing, but say so in the log so a configured knob that
    // does nothing isn't silent.
    logWarn(
      "agent",
      `[${contextLabel}] Claude one-shot: effort "${reasoningEffort}" has no ` +
        `Claude mapping — using the model default`,
    );
  } else if (thinkingConfig) {
    log(
      "agent",
      `[${contextLabel}] Claude one-shot effort: ${reasoningEffort}`,
    );
  }

  // Background runs are the one path whose prompt can be small enough to
  // fall under the model's cacheable floor — where nothing is cached and the
  // API reports no error at all. Chat prompts always clear it.
  warnIfBelowCacheMinimum(contextLabel, model, `${systemPrompt}\n${prompt}`);

  const qi = query({
    prompt,
    options: options as Parameters<typeof query>[0]["options"],
  });

  // The final `result` message carries the run's total token usage — the
  // settlement figure the task table records.
  let usage: OneShotUsage | undefined;
  let sessionReported: string | undefined;
  for await (const msg of qi) {
    // Every SDK message carries the session id; report it the first time it
    // is seen (and again only if it ever changes — a resumed session can be
    // forked to a new id).
    const sid = (msg as { session_id?: unknown }).session_id;
    if (typeof sid === "string" && sid && sid !== sessionReported) {
      sessionReported = sid;
      emitSessionId(onSessionId, sid);
    }
    await formatAndAppendMessage(appendLog, msg, onAssistantText);
    if (msg.type === "result") {
      const u = msg.usage;
      usage = {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      };
    }
  }
  return usage;
}

/**
 * Per-context MCP server selection.
 * - background tool contexts (`heartbeat`, and every `agent:<id>` sub-agent
 *   run — see `core/agents/context.ts`): frontend tools + all loaded plugins,
 *   the full surface these runs need to post messages, react, read history
 *   and reach their own agent tools. The servers are keyed by the context
 *   label itself, so each sub-agent gets its own hub session and its tool
 *   calls arrive at the gateway identified as that agent.
 * - "dream": only mempalace (when configured) — dream is a memory
 *   consolidation pass and shouldn't be doing outbound messaging.
 * - anything else: empty (treat unknown contexts as plugin-free).
 *
 * `buildMcpServers` throws if the agent config hasn't been initialised
 * (e.g. unit tests that mock the agent). Treat that case as "no frontend
 * MCP available" rather than crashing the whole one-shot run — plugin MCP
 * servers still load and the agent runs normally.
 */
function assembleMcpServers(contextLabel: string): Record<string, unknown> {
  if (isBackgroundToolContext(contextLabel)) {
    let frontendServers: Record<string, unknown> = {};
    try {
      frontendServers = buildMcpServers(contextLabel) as Record<
        string,
        unknown
      >;
    } catch {
      frontendServers = {};
    }
    let pluginServers: Record<string, unknown> = {};
    try {
      pluginServers = buildPluginMcpServers(contextLabel);
    } catch {
      pluginServers = {};
    }
    return { ...frontendServers, ...pluginServers };
  }
  if (contextLabel === "dream") {
    if (!oneShotConfig.mempalace) return {};
    try {
      return buildPluginMcpServers("dream", ["mempalace"]);
    } catch {
      return {};
    }
  }
  return {};
}

async function formatAndAppendMessage(
  appendLog: (text: string) => Promise<void>,
  msg: SDKMessage,
  onAssistantText?: OneShotAgentParams["onAssistantText"],
): Promise<void> {
  try {
    const ts = new Date().toISOString().slice(11, 19);

    switch (msg.type) {
      case "assistant": {
        const textBlocks = msg.message.content
          .filter((b) => b.type === "text")
          .map((b) => ("text" in b ? (b as { text: string }).text : ""));
        const toolUseBlocks = msg.message.content
          .filter((b) => b.type === "tool_use")
          .map((b) => {
            const tu = b as { name: string; input: unknown };
            return `**Tool call:** \`${tu.name}\`\n\`\`\`json\n${JSON.stringify(tu.input, null, 2)}\n\`\`\``;
          });

        if (textBlocks.length > 0) {
          const assistantText = textBlocks.join("\n");
          // Report before the log write: an append failure (full disk, closed
          // handle) must not also swallow the run's result for a hook caller.
          emitAssistantText(onAssistantText, assistantText);
          await appendLog(`\n## [${ts}] Assistant\n${assistantText}\n`);
        }
        if (toolUseBlocks.length > 0) {
          await appendLog(`\n${toolUseBlocks.join("\n\n")}\n`);
        }
        break;
      }
      case "result": {
        // Deliberately NOT reported through `onAssistantText`. The SDK's
        // terminal `result` message restates the last assistant turn's text
        // (`subtype: "success"`) or carries an error string (the
        // `error_*` subtypes) — never anything the `assistant` case above
        // has not already emitted. Reporting it too would hand every hook
        // caller a duplicate final segment, and the truncated copy at that
        // (2000 chars, below). The log keeps it because a run log wants the
        // settlement line; a sub-agent result does not.
        const result =
          "result" in msg
            ? (msg as { result: string }).result
            : JSON.stringify(msg);
        const truncated =
          result.length > 2000
            ? result.slice(0, 2000) + "\n... (truncated)"
            : result;
        await appendLog(
          `\n### [${ts}] Result (${msg.subtype})\n\`\`\`\n${truncated}\n\`\`\`\n`,
        );
        break;
      }
      case "system": {
        await appendLog(`\n### [${ts}] System (${msg.subtype})\n`);
        break;
      }
      case "user": {
        if (msg.tool_use_result != null) {
          const raw =
            typeof msg.tool_use_result === "string"
              ? msg.tool_use_result
              : JSON.stringify(msg.tool_use_result, null, 2);
          const truncated =
            raw.length > 2000 ? raw.slice(0, 2000) + "\n... (truncated)" : raw;
          await appendLog(
            `\n### [${ts}] Tool Result\n\`\`\`\n${truncated}\n\`\`\`\n`,
          );
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    process.stderr.write(
      `[one-shot] Log write error: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

/**
 * Find and kill any lingering `claude` subprocess (and its descendants) whose
 * environment carries `TALON_CHAT_ID=<contextLabel>`. We identify them by
 * reading /proc/<pid>/environ — that file is owned by the same uid as the
 * spawner (us) and contains the env vars Talon set when launching the SDK
 * subprocess via MCP launcher. SIGTERM with a short grace, then SIGKILL.
 */
/**
 * Decide whether a `/proc` entry is a run orphan this sweep may kill.
 *
 * Carrying the chat id is necessary but NOT sufficient. Every chat-scoped
 * child Talon spawns inherits `TALON_CHAT_ID` — including trigger watchers
 * (`core/background/triggers/spawn.ts` sets it alongside `TALON_TRIGGER_ID`)
 * and their descendants, which are long-lived by design and belong to no run.
 * Matching on the chat id alone made every orphan sweep kill that chat's
 * triggers: the warden respawned them, the next sweep killed them again, and
 * the only visible symptom was a trigger stuck in "errored" with no output.
 *
 * Three independent guards, because this function issues SIGKILL:
 *  - refuse anything tagged `TALON_TRIGGER_ID` (a trigger, or its child);
 *  - refuse anything spawned by another daemon that is still running
 *    (see core/daemon/pidfile.ts). Its "orphans" are that daemon's live runs;
 *  - require the argv to actually be the `claude` SDK binary, which is the
 *    only thing this sweep was ever meant to reap.
 */
export function isEvictableOrphan(
  envEntries: string[],
  argv: string[],
  target: string,
): boolean {
  if (!envEntries.includes(target)) return false;
  if (envEntries.some((entry) => entry.startsWith("TALON_TRIGGER_ID="))) {
    return false;
  }
  if (isOtherLiveDaemon(ownerFromEnviron(envEntries))) return false;
  return argv.some((arg) => arg === "claude" || arg.endsWith("/claude"));
}

export async function evictOrphanSubprocesses(contextLabel: string): Promise<{
  found: number;
  termed: number;
  killed: number;
}> {
  const result = { found: 0, termed: 0, killed: 0 };

  if (process.platform !== "linux") {
    // /proc is Linux-only. macOS/Windows: rely on SDK abort + grace alone.
    return result;
  }

  const myPid = process.pid;
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return result;
  }

  const target = `TALON_CHAT_ID=${contextLabel}`;
  const matched: number[] = [];
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === myPid) continue;
    try {
      const environRaw = await readFile(`/proc/${pid}/environ`, "utf-8");
      const argvRaw = await readFile(`/proc/${pid}/cmdline`, "utf-8");
      // /proc/<pid>/environ is NUL-delimited. Split on \0 and match exact
      // entries — a raw .includes() can false-positive on other vars whose
      // value happens to contain the substring. Since this code can SIGKILL,
      // err on the side of strict matching. (Copilot review on #144.)
      if (
        isEvictableOrphan(environRaw.split("\0"), argvRaw.split("\0"), target)
      ) {
        matched.push(pid);
      }
    } catch {
      // Process exited between readdir and readFile, or we don't own it. Skip.
      continue;
    }
  }

  result.found = matched.length;
  if (matched.length === 0) return result;

  for (const pid of matched) {
    try {
      process.kill(pid, "SIGTERM");
      result.termed++;
    } catch {
      // ESRCH (already gone) or EPERM — ignore.
    }
  }

  await new Promise<void>((r) => {
    const t = setTimeout(r, SUBPROCESS_KILL_GRACE_MS);
    t.unref();
  });

  for (const pid of matched) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
      result.killed++;
    } catch {
      // Already gone — no-op.
    }
  }

  log(
    "heartbeat",
    `Subprocess sweep (${contextLabel}): found=${result.found} termed=${result.termed} killed=${result.killed}`,
  );
  return result;
}
