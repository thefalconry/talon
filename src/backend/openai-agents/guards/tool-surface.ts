/**
 * Tool surface for the backend's isolated (background) runs.
 *
 * The chat path hands the model every frontend tool server and every
 * plugin: hundreds of tools. Measured on a live install that is ~150k
 * tokens of tool schemas before the prompt, which a local 32k-context
 * model rejects on every request, so a sub-agent on such a model can't do
 * anything. Background runs therefore default to a lean surface: the
 * built-ins (Read, Write, Edit, Bash, Glob, Grep) plus the agent-plumbing
 * tools a sub-agent needs to reach its parent and peers. Config
 * `openaiBackgroundTools` widens it (`"full"`, or extra tools/servers).
 */

import type { Tool } from "@openai/agents";
import type { LeanToolScope } from "../mcp-pool.js";

/** Talon tools every background run keeps (sub-agent plumbing). */
export const AGENT_PLUMBING_TOOLS: readonly string[] = [
  "report_result",
  "check_inbox",
  "message_parent",
  "message_peer",
  "list_peers",
];

/** The `openaiBackgroundTools` config value. */
export type BackgroundToolsSetting = "lean" | "full" | readonly string[];

/**
 * The lean scope for a setting, or `undefined` for the full surface.
 * Array entries naming a plugin/hub server (`pluginNames`, plus
 * "brave-search") add that whole server; any other entry is a Talon tool
 * name added to the plumbing set.
 */
export function resolveBackgroundToolScope(
  setting: BackgroundToolsSetting | undefined,
  pluginNames: readonly string[],
): LeanToolScope | undefined {
  if (setting === "full") return undefined;
  if (setting === undefined || setting === "lean") {
    return { tools: [...AGENT_PLUMBING_TOOLS], plugins: [] };
  }
  const servers = new Set([...pluginNames, "brave-search"]);
  const tools = new Set(AGENT_PLUMBING_TOOLS);
  const plugins: string[] = [];
  for (const raw of setting) {
    const entry = raw.trim();
    if (!entry) continue;
    if (servers.has(entry)) plugins.push(entry);
    else tools.add(entry);
  }
  return { tools: [...tools], plugins };
}

/** Rough chars-per-token for JSON tool schemas (OpenAI-style BPE). */
const CHARS_PER_TOKEN = 4;

/**
 * Tool-schema budget above which a run warns: a quarter of a 32k context.
 * Anything past it crowds out the prompt on a small local model.
 */
export const TOOL_SCHEMA_WARN_TOKENS = 8_000;

/**
 * Estimate the tokens a tool list costs per request: what the model is
 * sent for each tool (name, description, JSON-schema parameters).
 */
export function estimateToolSchemaTokens(
  tools: readonly Tool<never>[],
): number {
  let chars = 0;
  for (const t of tools) {
    const def = t as {
      name?: string;
      description?: string;
      parameters?: unknown;
    };
    chars += JSON.stringify({
      type: "function",
      function: {
        name: def.name ?? "",
        description: def.description ?? "",
        parameters: def.parameters ?? {},
      },
    }).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * The warning for a tool surface of `tokens`, or null when it fits.
 * Measured against the model's context window when the endpoint
 * advertised one (over half of it), else the fixed budget.
 */
export function toolSurfaceWarning(input: {
  tokens: number;
  toolCount: number;
  contextWindow?: number;
  lean: boolean;
}): string | null {
  const { tokens, toolCount, contextWindow, lean } = input;
  const limit = contextWindow
    ? Math.floor(contextWindow / 2)
    : TOOL_SCHEMA_WARN_TOKENS;
  if (tokens <= limit) return null;
  const ctx = contextWindow
    ? ` — over half the model's ${contextWindow}-token context`
    : "";
  const hint = lean
    ? "trim `openaiBackgroundTools`"
    : 'set `openaiBackgroundTools` to "lean" (or a short list)';
  return (
    `tool schemas are ~${tokens} tokens (${toolCount} tools)${ctx}; ` +
    `a small-context model may reject every request — ${hint}`
  );
}
