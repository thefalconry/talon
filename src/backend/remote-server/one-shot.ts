/**
 * Shared one-shot agent runner for the remote-server backend family
 * (Kilo, OpenCode) — used by heartbeat & dream.
 *
 * The heartbeat/dream modules own timing, locking, and the run log
 * file. This module owns everything agent-server-specific: ensuring
 * the HTTP server is up, registering an MCP server tagged with the
 * contextLabel (so the agent's outbound tool calls reach the right
 * frontend), creating an ephemeral session, running the prompt,
 * rendering the response parts into the run log, and cleaning up.
 *
 * The per-backend differences are exactly the `RemoteOneShotBindings`
 * fields — server bootstrap, model-selection parsing, and the
 * delivery-contract suffix.
 *
 * These servers run in a long-lived process, so there are no orphan
 * subprocesses to evict — `evictOrphanSubprocesses` is intentionally
 * not implemented for this family.
 *
 * Note on reasoning effort: `params.reasoningEffort` (config
 * `heartbeatEffort` / `dreamEffort`) is deliberately unused here. Neither
 * server's `session.prompt` exposes a reasoning knob — the level is baked
 * into the provider's model id when it's selectable at all — so the field
 * is ignored rather than half-honoured.
 *
 * Note on abort semantics: both SDKs expose `session.abort` but the
 * REST `prompt` endpoint blocks until the underlying provider
 * returns. The heartbeat module's outer abort grace is what actually
 * unblocks the lock — `session.abort` is best-effort cleanup so the
 * model stops spending tokens once the timeout fires.
 */

import type { OneShotAgentParams, OneShotUsage } from "../../core/types.js";
import { logWarn } from "../../util/log.js";
import {
  approvePendingPermissions,
  extractAssistantUsage,
  rejectPendingQuestions,
  type RemoteSessionClient,
  type RemoteAssistantInfo,
} from "./session-helpers.js";
import { appendBackendSuffix, sleep } from "../runtime/index.js";
import { emitAssistantText } from "../runtime/one-shot-hooks.js";
import { buildPermissionRuleset } from "./sessions.js";

// ── Client surface ──────────────────────────────────────────────────────────

/**
 * The slice of the SDK client the one-shot path touches. Wider than
 * `RemoteAgentClient` (which covers only the always-shared helpers):
 * one-shot drives the session lifecycle directly. Method syntax keeps
 * parameter checking bivariant so both concrete SDK clients satisfy
 * it structurally.
 */
export interface RemoteOneShotClient extends RemoteSessionClient {
  session: RemoteSessionClient["session"] & {
    prompt(args: {
      sessionID: string;
      parts: Array<{ type: "text"; text: string }>;
      model: { providerID: string; modelID: string };
      system: string;
      tools?: Record<string, boolean>;
    }): Promise<{ data?: unknown }>;
    abort(args: { sessionID: string }): Promise<unknown>;
    delete(args: { sessionID: string }): Promise<unknown>;
  };
}

// ── Bindings ────────────────────────────────────────────────────────────────

/** The per-backend seams: server bootstrap, model parsing, suffix. */
export type RemoteOneShotBindings<TClient extends RemoteOneShotClient> = {
  /** Display label for log lines ("Kilo", "OpenCode"). */
  label: string;
  /** Delivery-contract suffix appended to the system prompt. */
  systemPromptSuffix: string;
  ensureServer(): Promise<TClient>;
  /** Split a stored model value into provider/model ids. */
  parseModelSelection(value: string): {
    providerID?: string;
    modelID: string;
  };
  resolveProviderID(client: TClient, modelID: string): Promise<string>;
  ensureChatMcpServer(client: TClient, chatId: string): Promise<string>;
  ensurePluginMcpServers(client: TClient, chatId: string): Promise<string[]>;
  buildToolOverrides(
    client: TClient,
    chatServerName: string,
    pluginServerNames?: readonly string[],
  ): Promise<Record<string, boolean> | undefined>;
  disconnectChatMcpServer(client: TClient, serverName: string): Promise<void>;
  errMsg(e: unknown): string;
};

// ── Runner ──────────────────────────────────────────────────────────────────

export async function runRemoteOneShotAgent<
  TClient extends RemoteOneShotClient,
>(
  bindings: RemoteOneShotBindings<TClient>,
  params: OneShotAgentParams,
): Promise<OneShotUsage | void> {
  const {
    prompt,
    systemPrompt,
    model,
    contextLabel,
    abortController,
    appendLog,
    onAssistantText,
  } = params;
  const { label, errMsg } = bindings;

  const oc = await bindings.ensureServer();
  const { providerID: selectedProviderID, modelID } =
    bindings.parseModelSelection(model);
  const providerID =
    selectedProviderID ?? (await bindings.resolveProviderID(oc, modelID));

  const chatMcpServerName = await bindings.ensureChatMcpServer(
    oc,
    contextLabel,
  );
  const pluginMcpServerNames = await bindings.ensurePluginMcpServers(
    oc,
    contextLabel,
  );
  const toolOverrides = await bindings.buildToolOverrides(
    oc,
    chatMcpServerName,
    pluginMcpServerNames,
  );

  const sessionResp = await oc.session.create({
    title: `One-shot ${contextLabel} ${new Date().toISOString()}`,
    permission: buildPermissionRuleset(contextLabel),
  });
  const sessionData = sessionResp.data as Record<string, unknown> | undefined;
  const sessionID =
    typeof sessionData?.id === "string" ? sessionData.id : String(Date.now());

  // Abort handler: when the heartbeat timeout fires, ask the server to
  // stop generating. The await on `session.prompt` will reject; we
  // propagate. Without this, runaway generation on a hung heartbeat
  // keeps spending tokens until the provider returns naturally.
  const onAbort = (): void => {
    oc.session
      .abort({ sessionID })
      .catch((err) =>
        logWarn(
          "agent",
          `One-shot session.abort failed for ${sessionID}: ${errMsg(err)}`,
        ),
      );
  };
  abortController.signal.addEventListener("abort", onAbort, { once: true });
  const watchdogAbort = new AbortController();
  const seenQuestionIds = new Set<string>();
  const seenPermissionIds = new Set<string>();
  const interactionWatchdog = (async () => {
    while (!watchdogAbort.signal.aborted) {
      try {
        await Promise.all([
          rejectPendingQuestions(
            oc,
            sessionID,
            contextLabel,
            seenQuestionIds,
            label,
          ),
          approvePendingPermissions(
            oc,
            sessionID,
            contextLabel,
            seenPermissionIds,
            label,
          ),
        ]);
      } catch (err) {
        logWarn(
          "agent",
          `${label} one-shot interaction watchdog failed: ${errMsg(err)}`,
        );
      }
      await sleep(350, watchdogAbort.signal);
    }
  })();

  try {
    if (abortController.signal.aborted) {
      throw new Error("Aborted before prompt was sent");
    }

    const finalSystemPrompt = appendBackendSuffix(
      systemPrompt,
      bindings.systemPromptSuffix,
    );

    const resp = await oc.session.prompt({
      sessionID,
      parts: [{ type: "text", text: prompt }],
      model: { providerID, modelID },
      system: finalSystemPrompt,
      ...(toolOverrides ? { tools: toolOverrides } : {}),
    });

    const data = resp.data as Record<string, unknown> | undefined;
    const parts = Array.isArray(data?.parts)
      ? (data.parts as Array<Record<string, unknown>>)
      : [];

    for (const part of parts) {
      await appendResponsePart(appendLog, part, onAssistantText);
    }

    // The prompt response's assistant info carries the run's token usage —
    // the settlement figure the task table records.
    const info = data?.info as RemoteAssistantInfo | undefined;
    if (info) {
      const u = extractAssistantUsage(info);
      if (u.inputTokens > 0 || u.outputTokens > 0) {
        return {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheRead: u.cacheRead,
          cacheWrite: u.cacheWrite,
        };
      }
    }
  } finally {
    abortController.signal.removeEventListener("abort", onAbort);
    watchdogAbort.abort();
    await interactionWatchdog.catch(() => {});
    await Promise.all([
      bindings.disconnectChatMcpServer(oc, chatMcpServerName),
      ...pluginMcpServerNames.map((name) =>
        bindings.disconnectChatMcpServer(oc, name),
      ),
    ]);
    try {
      await oc.session.delete({ sessionID });
    } catch (err) {
      logWarn(
        "agent",
        `Failed to delete one-shot ${label} session ${sessionID}: ${errMsg(err)}`,
      );
    }
  }
}

// ── Run-log rendering ───────────────────────────────────────────────────────

/**
 * Render one response part into the Markdown run log, and report the
 * assistant's final text to the run's optional `onAssistantText` consumer.
 *
 * Only the `text` parts are reported: `reasoning` parts are the model's
 * thinking and tool parts are call payloads, neither of which is the run's
 * answer.
 */
async function appendResponsePart(
  appendLog: (text: string) => Promise<void>,
  part: Record<string, unknown>,
  onAssistantText?: OneShotAgentParams["onAssistantText"],
): Promise<void> {
  const ts = new Date().toISOString().slice(11, 19);
  const type = typeof part.type === "string" ? part.type : "unknown";

  if (type === "text") {
    const text = typeof part.text === "string" ? part.text : "";
    if (text) {
      emitAssistantText(onAssistantText, text);
      await appendLog(`\n## [${ts}] Assistant\n${text}\n`);
    }
    return;
  }

  if (type === "tool" || type === "tool_use") {
    const name =
      typeof part.tool === "string"
        ? part.tool
        : typeof part.name === "string"
          ? part.name
          : "tool";
    const input =
      "input" in part ? part.input : "state" in part ? part.state : null;
    await appendLog(
      `\n**Tool call:** \`${name}\`\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\`\n`,
    );
    return;
  }

  if (type === "step-start" || type === "step-finish") {
    return;
  }

  if (type === "reasoning") {
    const text = typeof part.text === "string" ? part.text : "";
    if (text) await appendLog(`\n### [${ts}] Reasoning\n${text}\n`);
    return;
  }

  // Fallback: dump unknown part types so we don't lose information.
  const truncated = JSON.stringify(part, null, 2).slice(0, 2000);
  await appendLog(
    `\n### [${ts}] Part (${type})\n\`\`\`json\n${truncated}\n\`\`\`\n`,
  );
}
