/**
 * Heartbeat agent — system-prompt + goal-block building, the one-shot agent
 * run with timeout/abort/orphan-eviction, and the per-run log helpers.
 */

import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { files as pathFiles, dirs } from "../../../util/paths.js";
import { logError, logWarn } from "../../../util/log.js";
import { toYMD } from "../../../util/time.js";
import { getDefaultModel } from "../../models/catalog.js";
import { loadSystemTemplate } from "../../prompt/templates.js";
import { formatGoal, getOpenGoals } from "../../../storage/goals.js";
import { taskTable, type TaskHandle } from "../../tasks/index.js";
import type { Backend } from "../../agent-runtime/capabilities.js";
import type { OneShotAgentParams } from "../../types.js";
import { acquireBackendInstance } from "../../engine/backend-controller/index.js";
import {
  chooseBackend,
  recordBackendRunFailure,
  recordBackendRunSuccess,
  recordBackendRunUsage,
  resolveRoutedModel,
} from "../../engine/backend-router/index.js";
import { resolveBackgroundEffort } from "../effort.js";
import { raceWithTimeout } from "../isolated-agent.js";
import { hb } from "./state.js";

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000; // 10-minute soft cap
const DEFAULT_HEARTBEAT_ABORT_GRACE_MS = 30 * 1000;
const HEARTBEAT_LOGS_DIR = resolve(dirs.logs, "heartbeats");

/**
 * Thrown when the heartbeat exceeds the configured timeout. Distinguishes
 * timeouts from agent-internal failures so callers can advance state on the
 * former (the hour was spent) but preserve it on the latter (retry as-is).
 */
export class HeartbeatTimeoutError extends Error {
  constructor() {
    super("Heartbeat agent timed out");
    this.name = "HeartbeatTimeoutError";
  }
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Overridable via env (eg integration tests). Read per RUN, not at module
 * load, so tests (and operators) can adjust without re-importing the module.
 */
function heartbeatTimeoutMs(): number {
  return envMs("TALON_HEARTBEAT_TIMEOUT_MS", DEFAULT_HEARTBEAT_TIMEOUT_MS);
}

/**
 * After we abort the agent on timeout, wait this long for the agent promise to
 * settle gracefully before releasing the lock and evicting orphans. Read per
 * run — see heartbeatTimeoutMs.
 */
function heartbeatAbortGraceMs(): number {
  return envMs(
    "TALON_HEARTBEAT_ABORT_GRACE_MS",
    DEFAULT_HEARTBEAT_ABORT_GRACE_MS,
  );
}

/**
 * Build the heartbeat agent system prompt from the package-owned template
 * `prompts/system/heartbeat-agent.md`. Names each `${frontend}-tools` MCP
 * server it actually has access to. Terminal-only deployments get a minimal
 * prompt (the `outbound` block is omitted); the `mempalace` block renders only
 * when the plugin is registered. Exported for tests.
 */
export function buildHeartbeatSystemPrompt(): string {
  const frontends = hb.config?.frontends ?? [];
  // trim: omitted {{#if}} blocks leave their tag lines' newlines behind.
  return loadSystemTemplate("heartbeat-agent", {
    mempalace: hb.config?.mempalace ? "yes" : undefined,
    outbound: frontends.length > 0 ? "yes" : undefined,
    toolList: frontends.map((f) => `\`${f}-tools\``).join(", "),
    exampleFrontend: frontends[0],
  }).trim();
}

/**
 * Render the open-goal listing for the heartbeat prompt. Cross-chat by design:
 * the heartbeat is a global agent, so it sees every chat's open goals (with
 * chat ids for routing updates back).
 */
function renderGoalsBlock(): { text: string; count: number } {
  let text = "(no open goals)";
  let count = 0;
  try {
    const goals = getOpenGoals();
    count = goals.length;
    if (count > 0) {
      text = goals.map((g) => formatGoal(g, { withChatId: true })).join("\n\n");
    }
  } catch (err) {
    logWarn(
      "heartbeat",
      `Failed to load goals for heartbeat prompt: ${err instanceof Error ? err.message : err}`,
    );
    text = "(goal store unavailable this run)";
  }
  return { text, count };
}

/** Everything the seeded heartbeat.md template interpolates. */
type HeartbeatPromptInputs = {
  lastRunIso: string;
  runCount: number;
  workspace: string;
  logsDir: string;
  memoryFile: string;
  instructionsFile: string;
  dailyMemoryFile: string;
};

/**
 * Load the user's heartbeat.md (seeded to ~/.talon/prompts/) and fill its
 * placeholders. Seeded copies are never rewritten once the user owns them,
 * so two older vintages get their missing sections appended instead.
 */
function renderHeartbeatPrompt(inputs: HeartbeatPromptInputs): string {
  const promptPath = resolve(dirs.prompts, "heartbeat.md");
  const goalsBlock = renderGoalsBlock();
  let prompt: string;
  let hadGoalsVar: boolean;
  let hadStateVar: boolean;
  try {
    const raw = readFileSync(promptPath, "utf-8");
    hadGoalsVar = raw.includes("{{goals}}");
    hadStateVar = raw.includes("{{stateFile}}");
    prompt = raw
      .replace(/\{\{workspace\}\}/g, inputs.workspace)
      .replace(/\{\{logsDir\}\}/g, inputs.logsDir)
      .replace(/\{\{lastRunIso\}\}/g, inputs.lastRunIso)
      .replace(/\{\{memoryFile\}\}/g, inputs.memoryFile)
      .replace(/\{\{stateFile\}\}/g, pathFiles.state)
      .replace(/\{\{instructionsFile\}\}/g, inputs.instructionsFile)
      .replace(/\{\{dailyMemoryFile\}\}/g, inputs.dailyMemoryFile)
      .replace(/\{\{runCount\}\}/g, String(inputs.runCount))
      .replace(/\{\{intervalMinutes\}\}/g, String(hb.intervalMinutesRef))
      .replace(/\{\{goals\}\}/g, goalsBlock.text);
  } catch {
    throw new Error(`Failed to read heartbeat prompt from ${promptPath}`);
  }

  // Seeded heartbeat.md copies predating the goals feature have no {{goals}}
  // placeholder — append the goals-fallback section so goals reach the agent
  // regardless of template vintage. Only when there ARE open goals.
  if (!hadGoalsVar && goalsBlock.count > 0) {
    prompt += `\n\n${loadSystemTemplate("heartbeat-agent", {
      mode: "goals-fallback",
      count: String(goalsBlock.count),
      goals: goalsBlock.text,
    }).trim()}`;
  }

  // Same vintage problem for the memory/state split: a seeded heartbeat.md
  // from before it still instructs the agent to write memory.md, which is
  // how status snapshots accreted in the durable store in the first place.
  if (!hadStateVar) {
    logWarn(
      "heartbeat",
      `Seeded ${promptPath} predates the memory/state split — appending ` +
        `file-ownership rules. Delete that file to re-seed the current prompt.`,
    );
    prompt += `\n\n${loadSystemTemplate("heartbeat-agent", {
      mode: "state-fallback",
      stateFile: pathFiles.state,
      memoryFile: inputs.memoryFile,
    }).trim()}`;
  }
  return prompt;
}

/** Create this run's log file and write its header; returns the path. */
async function openHeartbeatLog(
  runCount: number,
  lastRunIso: string,
  model: string,
  effort: { effort?: string; dropped?: string },
  prompt: string,
): Promise<string> {
  const heartbeatLogFile = await createHeartbeatLogFile();
  await appendHeartbeatLog(
    heartbeatLogFile,
    `# Heartbeat Run #${runCount} — ${new Date().toISOString()}\n`,
  );
  await appendHeartbeatLog(
    heartbeatLogFile,
    `**Trigger:** ${lastRunIso === "never" ? "first run" : `last_run=${lastRunIso}`}, model=${model}` +
      `${effort.effort ? `, effort=${effort.effort}` : ""}\n`,
  );
  if (effort.dropped) {
    await appendHeartbeatLog(
      heartbeatLogFile,
      `**Effort:** ${effort.dropped}\n`,
    );
  }
  await appendHeartbeatLog(
    heartbeatLogFile,
    `**Prompt:**\n\`\`\`\n${prompt}\n\`\`\`\n\n---\n`,
  );
  return heartbeatLogFile;
}

/**
 * Run the one-shot agent under the heartbeat's soft timeout. On timeout the
 * abort signal goes out, the backend gets a bounded grace window to clean
 * up, and a backend that ignores it is asked to evict its orphans; either
 * way the error propagates so the caller releases the lock.
 */
async function runOneShotWithTimeout(
  background: NonNullable<Backend["background"]>,
  params: OneShotAgentParams,
  abortController: AbortController,
  task: TaskHandle,
  runCount: number,
  heartbeatLogFile: string,
): Promise<Awaited<ReturnType<typeof background.runOneShotAgent>>> {
  let timeoutFired = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    const t = setTimeout(() => {
      timeoutFired = true;
      try {
        abortController.abort(new HeartbeatTimeoutError());
      } catch {
        /* ignore */
      }
      reject(new HeartbeatTimeoutError());
    }, heartbeatTimeoutMs());
    t.unref(); // Don't prevent Node.js from exiting cleanly during shutdown
    timeoutHandle = t;
  });

  const agentPromise = (async () => {
    const usage = await background.runOneShotAgent(params);
    await appendHeartbeatLog(
      heartbeatLogFile,
      `\n---\n**Heartbeat #${runCount} completed at ${new Date().toISOString()}**\n`,
    );
    return usage;
  })();

  try {
    return await Promise.race([agentPromise, timeoutPromise]);
  } catch (err) {
    // Snapshot timeout state and clear the timer immediately, BEFORE any awaits
    // in the error-handling path. Otherwise the timer can fire during the async
    // log append below and flip `timeoutFired` to true for what was actually a
    // non-timeout failure.
    const wasTimeout = timeoutFired;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    task.fail(err);
    await appendHeartbeatLog(
      heartbeatLogFile,
      `\n---\n**Heartbeat #${runCount} FAILED at ${new Date().toISOString()}:** ${err}\n`,
    );
    if (wasTimeout) {
      await evictAfterIgnoredAbort(background, agentPromise, runCount);
    } else {
      // Non-timeout failure path — agentPromise has already settled.
      await agentPromise.catch(() => {});
    }
    throw err;
  } finally {
    // Safety net — already cleared in catch on the error path, but a clean
    // resolution of Promise.race() needs this too.
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Give the backend a bounded grace window to clean up after the abort
 * signal — but never wait indefinitely. If the backend ignores the abort,
 * release the lock anyway and ask it to evict any orphan subprocesses.
 */
async function evictAfterIgnoredAbort(
  background: NonNullable<Backend["background"]>,
  agentPromise: Promise<unknown>,
  runCount: number,
): Promise<void> {
  const settled = await raceWithTimeout(
    agentPromise.catch(() => "settled"),
    heartbeatAbortGraceMs(),
  );
  if (settled !== "timed_out") return;
  logWarn(
    "heartbeat",
    `Heartbeat #${runCount} backend ignored abort after ${heartbeatAbortGraceMs()}ms — releasing lock and evicting orphan subprocesses`,
  );
  // Fire-and-forget — we don't block the next heartbeat on subprocess
  // cleanup. Backends that don't spawn per-run subprocesses leave
  // evictOrphanSubprocesses unimplemented; that's fine.
  const evict = background.evictOrphanSubprocesses;
  if (evict) {
    evict("heartbeat").catch((sweepErr: unknown) => {
      logError("heartbeat", "Orphan subprocess sweep failed", sweepErr);
    });
  }
}

/** The backend + model one heartbeat run uses, and how to let it go after. */
interface HeartbeatTarget {
  readonly backendId: string;
  readonly backend: Backend;
  readonly model: string;
  readonly release: (() => Promise<void>) | null;
}

/**
 * Pick the backend for this run.
 *
 * The heartbeat is the most movable background work Talon has: an isolated
 * one-shot, hourly, on no session. So when the operator pinned neither
 * `heartbeatBackend` nor `heartbeatModel`, it goes wherever the plan has
 * room — and takes that backend's default model, since a model id means
 * nothing on another provider. Anything pinned is honoured as written, and
 * the chat's own backend is never moved by this.
 *
 * A routed run holds a transient pool reference, so the caller must always
 * call `release`.
 */
async function resolveHeartbeatTarget(
  config: NonNullable<typeof hb.config>,
  roleBackend: Backend,
  roleModel: string,
): Promise<HeartbeatTarget> {
  const roleId = config.getBackendId?.() ?? config.pinnedBackendId ?? "";
  const stay: HeartbeatTarget = {
    backendId: roleId,
    backend: roleBackend,
    model: roleModel,
    release: null,
  };
  if (!roleId) return stay;

  const decision = await chooseBackend({
    purpose: "heartbeat",
    chatBackendId: roleId,
    ...(config.pinnedBackendId
      ? { requestedBackendId: config.pinnedBackendId }
      : {}),
    ...(config.heartbeatModel ? { requestedModel: config.heartbeatModel } : {}),
  });
  if (!decision.routed || decision.backendId === roleId) return stay;

  const model = await resolveRoutedModel(decision.backendId);
  if (!model) {
    logWarn(
      "heartbeat",
      `routed to ${decision.backendId} but it names no default model — ` +
        `staying on ${roleId}`,
    );
    return stay;
  }
  try {
    const acquired = await acquireBackendInstance(decision.backendId);
    if (!acquired.backend.background) {
      await acquired.release();
      return stay;
    }
    return {
      backendId: decision.backendId,
      backend: acquired.backend,
      model,
      release: acquired.release,
    };
  } catch (err) {
    logWarn(
      "heartbeat",
      `could not acquire routed backend ${decision.backendId}: ${err instanceof Error ? err.message : err} — staying on ${roleId}`,
    );
    return stay;
  }
}

export async function runHeartbeatAgent(
  lastRunTimestamp: number,
  runCount: number,
): Promise<string> {
  const config = hb.config;
  if (!config) {
    throw new Error("Heartbeat agent not initialized");
  }

  const lastRunIso =
    lastRunTimestamp > 0 ? new Date(lastRunTimestamp).toISOString() : "never";
  const workspace = config.workspace ?? dirs.workspace;
  const memoryFile = pathFiles.memory;
  const prompt = renderHeartbeatPrompt({
    lastRunIso,
    runCount,
    workspace,
    logsDir: dirs.logs,
    memoryFile,
    instructionsFile: resolve(workspace, "heartbeat-instructions.md"),
    dailyMemoryFile: resolve(dirs.dailyMemory, `${toYMD(new Date())}.md`),
  });

  const roleModel = config.heartbeatModel ?? config.model ?? getDefaultModel();
  const roleBackend = config.getBackend?.() ?? null;
  if (!roleBackend?.background) {
    throw new Error(
      "Heartbeat requires a backend that implements the background capability",
    );
  }
  const target = await resolveHeartbeatTarget(config, roleBackend, roleModel);
  const { model, backend } = target;
  const background = backend.background as NonNullable<Backend["background"]>;

  // Effort is resolved against the heartbeat backend's catalog, not just
  // copied from config — a level the model doesn't offer is dropped with a
  // reason rather than handed to the SDK.
  const effort = await resolveBackgroundEffort({
    requested: config.heartbeatEffort,
    model,
    backend,
  });
  if (effort.dropped) {
    logWarn("heartbeat", effort.dropped);
  }

  const heartbeatLogFile = await openHeartbeatLog(
    runCount,
    lastRunIso,
    model,
    effort,
    prompt,
  );

  // AbortController is the canonical way to signal a cancellation to a backend.
  // .abort() should tear down any spawned subprocess (Claude SDK) or stop
  // streaming (Kilo/OpenCode). We defend against backends that ignore it — see
  // heartbeatAbortGraceMs.
  const abortController = new AbortController();
  const task = taskTable.begin({
    kind: "heartbeat",
    label: `#${runCount}`,
    abort: () => abortController.abort(),
  });
  task.bind({ model });

  let usage: Awaited<ReturnType<typeof runOneShotWithTimeout>>;
  try {
    usage = await runOneShotWithTimeout(
      background,
      {
        prompt,
        systemPrompt: buildHeartbeatSystemPrompt(),
        workspace,
        model,
        ...(effort.effort ? { reasoningEffort: effort.effort } : {}),
        contextLabel: "heartbeat",
        abortController,
        appendLog: (text) => appendHeartbeatLog(heartbeatLogFile, text),
      },
      abortController,
      task,
      runCount,
      heartbeatLogFile,
    );
  } catch (err) {
    recordBackendRunFailure(target.backendId, err);
    throw err;
  } finally {
    // A routed run borrowed the instance from the pool; hand it back on
    // every path or the provider stays warm until the daemon restarts.
    if (target.release) {
      await target
        .release()
        .catch((err: unknown) =>
          logError("heartbeat", "failed to release routed backend", err),
        );
    }
  }
  recordBackendRunUsage(target.backendId, usage ?? undefined);
  recordBackendRunSuccess(target.backendId);
  task.succeed(usage ?? undefined);
  return heartbeatLogFile;
}

// ── Logging helpers ─────────────────────────────────────────────────────────

async function createHeartbeatLogFile(): Promise<string> {
  // Best-effort: a failure to create the log directory must not abort the
  // heartbeat run itself. The per-append writes are already caught, so a
  // missing dir just means dropped log entries.
  try {
    if (!existsSync(HEARTBEAT_LOGS_DIR)) {
      await mkdir(HEARTBEAT_LOGS_DIR, { recursive: true });
    }
  } catch (err) {
    logError(
      "heartbeat",
      "Failed to create heartbeat log dir — run continues, log entries will be dropped",
      err,
    );
  }
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const seq = hb.logFileSequence++;
  return resolve(HEARTBEAT_LOGS_DIR, `heartbeat-${ts}-${seq}.md`);
}

async function appendHeartbeatLog(
  logFile: string,
  text: string,
): Promise<void> {
  try {
    await appendFile(logFile, text);
  } catch (err) {
    logError("heartbeat", "Failed to write heartbeat log", err);
  }
}
