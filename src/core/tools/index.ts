/**
 * Tool registry — compose filtered tool sets at runtime.
 *
 * Import domain modules, expose a single composeTools() API
 * that backends and the MCP server use to get the right tool set.
 */

import type { ToolDefinition, ToolFrontend, ToolTag } from "./types.js";

import { messagingTools } from "./chat/messaging.js";
import { chatTools } from "./chat/chat.js";
import { historyTools } from "./chat/history.js";
import { memberTools } from "./chat/members.js";
import { mediaTools } from "./chat/media.js";
import { stickerTools } from "./chat/stickers.js";
import { schedulingTools } from "./ops/scheduling.js";
import { triggerTools } from "./ops/triggers.js";
import { agentTools, preflightTools } from "./ops/agents.js";
import { goalTools } from "./ops/goals.js";
import { memoryTools } from "./content/memory.js";
import { scriptTools } from "./ops/scripts.js";
import { skillTools } from "./ops/skills.js";
import { webTools } from "./content/web.js";
import { adminTools } from "./ops/admin.js";
import { modelTools } from "./ops/models.js";
import { meshTools } from "./ops/mesh.js";
import { crossSendTools } from "./chat/cross-send.js";
import { whatsappTools } from "./chat/whatsapp.js";
import { moderationTools } from "./chat/moderation.js";
import { nativeTools } from "./ops/native.js";
import { backupTools } from "./ops/backup.js";
import { secretTools } from "./ops/secrets.js";

/** All built-in tool definitions. */
export const ALL_TOOLS: readonly ToolDefinition[] = [
  ...messagingTools,
  ...chatTools,
  ...historyTools,
  ...memberTools,
  ...mediaTools,
  ...stickerTools,
  ...schedulingTools,
  ...triggerTools,
  ...goalTools,
  ...memoryTools,
  ...scriptTools,
  ...skillTools,
  ...webTools,
  ...adminTools,
  ...modelTools,
  ...meshTools,
  ...crossSendTools,
  ...whatsappTools,
  ...moderationTools,
  // Appended, not inserted: ALL_TOOLS is serialised into the prompt-cache
  // prefix, so a new family goes on the end or every live chat re-bills its
  // system prompt (see compose-tools.test.ts).
  ...agentTools,
  ...backupTools,
  ...preflightTools,
  ...secretTools,
];

/**
 * Native tools (bash/read/write/edit/glob/search + teleport) are kept OUT of
 * ALL_TOOLS on purpose: they are an opt-in replacement for the SDK built-ins,
 * surfaced only when `composeTools({ includeNativeTools: true })` is asked
 * (driven by `config.nativeTools`). Keeping them separate preserves the
 * "no options → the full built-in set" invariant every other caller relies on.
 */
export { nativeTools };

/**
 * Names of tools that explicitly terminate the model's turn.
 *
 * Backend handlers consume this set to abort their stream loop after
 * observing one of these tools — without it, the model can keep producing
 * trailing scratchpad prose after declaring "I'm done", which trips the
 * flow-violation re-prompt path. Declaration is on the tool definition
 * (`endsTurn: true`); detection is shared; abort is backend-specific.
 *
 * The set is computed once at module load from `ALL_TOOLS`.
 */
const TURN_TERMINATOR_NAMES: ReadonlySet<string> = new Set(
  ALL_TOOLS.filter((t) => t.endsTurn).map((t) => t.name),
);

/**
 * Names of reply-delivery tools (`delivery: true` on the definition):
 * their observable effect is the message/reaction itself, which
 * frontends already surface as first-class output. Kept separate from
 * `TURN_TERMINATOR_NAMES` — `send_message` delivers without ending the
 * turn, and a future terminator need not be a delivery tool.
 */
const DELIVERY_TOOL_NAMES: ReadonlySet<string> = new Set(
  ALL_TOOLS.filter((t) => t.delivery).map((t) => t.name),
);

/**
 * All tool names registered in Talon's tool catalog. Used by
 * `stripMcpPrefix` to recognise the bare name when a backend prefixes
 * the tool with its MCP server identifier in a non-standard way (e.g.
 * Kilo's `<server>_<bare>` instead of MCP's canonical `mcp__<server>__<bare>`).
 */
const ALL_TOOL_NAMES: ReadonlySet<string> = new Set(
  [...ALL_TOOLS, ...nativeTools].map((t) => t.name),
);

/**
 * Strip a backend's MCP server prefix from a tool name.
 *
 * Two prefix conventions are in the wild:
 *
 *   1. **Claude SDK / MCP canonical:** `mcp__<server>__<tool>`
 *      e.g. `mcp__telegram-tools__end_turn` → `end_turn`.
 *
 *   2. **Kilo / OpenCode:** `<server>_<tool>` (single underscore boundary,
 *      no `mcp__` prefix). e.g. `talon-tools-424242420_send` → `send`,
 *      `talon-tools-heartbeat_end_turn` → `end_turn`. Bare names that
 *      contain underscores (`end_turn`) make a "split on _" approach
 *      ambiguous, so we resolve by checking whether the trailing segment
 *      matches a known tool name and walking backward through underscore
 *      boundaries until we hit one.
 *
 * Returns the input unchanged when no recognised prefix matches — safe
 * to call on any tool name. Without the Kilo branch, deliveries via
 * `talon-tools-<chat>_send` were not deduped against the model's
 * trailing prose, so every tool-delivered reply was emitted twice
 * (once by the tool's bridge call, once by the handler's text-part
 * fallback).
 */
export function stripMcpPrefix(toolName: string): string {
  const mcpStripped = toolName.replace(/^mcp__.+?__/, "");
  if (mcpStripped !== toolName) return mcpStripped;

  // Kilo / OpenCode `<server>_<bare>` form. Walk underscore boundaries
  // from the right; the longest tail that matches a registered tool name
  // is the bare name. Prevents `talon-tools-424242420_end_turn` from
  // resolving to `turn` (which isn't a tool).
  const segments = toolName.split("_");
  for (let i = 1; i < segments.length; i++) {
    const tail = segments.slice(i).join("_");
    if (ALL_TOOL_NAMES.has(tail)) {
      return tail;
    }
  }
  return toolName;
}

/**
 * Whether a tool call by this name should terminate the model's turn.
 *
 * Accepts both bare names (`end_turn`) and MCP-prefixed names
 * (`mcp__telegram-tools__end_turn`) — the prefix is stripped before
 * comparing against the terminator set.
 *
 * Soft-terminator override: some terminators (notably `react`) accept a
 * per-call `end_turn: false` opt-out so the model can react and keep the
 * turn alive (e.g. react-with-🤔 then look something up). When the second
 * argument is provided and the call is one of the soft-terminator tools
 * with `end_turn: false`, this returns `false` so the SDK loop keeps
 * going. When omitted (or `end_turn !== false`), behaviour matches the
 * name-only check — strict terminator.
 */
export function isTurnTerminator(
  toolName: string,
  toolInput?: unknown,
): boolean {
  const matchedBare = TURN_TERMINATOR_NAMES.has(toolName);
  const matchedStripped =
    !matchedBare && TURN_TERMINATOR_NAMES.has(stripMcpPrefix(toolName));
  if (!matchedBare && !matchedStripped) return false;

  // Per-tool soft override: `react` honours an explicit `end_turn: false`.
  const baseName = matchedBare ? toolName : stripMcpPrefix(toolName);
  if (baseName === "react" && toolInput && typeof toolInput === "object") {
    const flag = (toolInput as { end_turn?: unknown }).end_turn;
    if (flag === false) return false;
  }
  return true;
}

/**
 * Whether a tool call by this name is reply-delivery plumbing
 * (`delivery: true` on its definition) — `end_turn`, `send`,
 * `send_message`, `react`, … Its effect reaches the user as a chat
 * message or reaction, so activity timelines ("what the model did")
 * must exclude it or the reply gets double-reported as work.
 *
 * Accepts bare names (`end_turn`) and every prefixed form
 * `stripMcpPrefix` understands (`mcp__desktop-tools__end_turn`,
 * Kilo's `desktop-tools_end_turn`).
 */
export function isDeliveryTool(toolName: string): boolean {
  return (
    DELIVERY_TOOL_NAMES.has(toolName) ||
    DELIVERY_TOOL_NAMES.has(stripMcpPrefix(toolName))
  );
}

/** Filter options for composing a tool set. */
export interface ComposeOptions {
  /** Include only tools available on this frontend. */
  frontend?: ToolFrontend;
  /** Include only tools with these tags. */
  tags?: ToolTag[];
  /** Exclude tools with these tags. */
  excludeTags?: ToolTag[];
  /** Exclude specific tools by name. */
  excludeNames?: string[];
  /**
   * Include the `native` tool set (bash/read/write/edit/glob/search +
   * teleport). Off unless explicitly requested — these are only meant to be
   * live when `config.nativeTools` replaces the SDK built-ins, so every other
   * caller (and tests) gets the built-in surface by default.
   */
  includeNativeTools?: boolean;
}

/**
 * Compose a filtered set of tools at runtime.
 *
 * When no options are provided, returns ALL_TOOLS unchanged.
 * Callers describe what they need and get back matching definitions.
 */
export function composeTools(options: ComposeOptions = {}): ToolDefinition[] {
  // Native tools are opt-in — appended only when replacing the SDK built-ins,
  // so every default caller (and tests) gets exactly the built-in set.
  let tools = options.includeNativeTools
    ? [...ALL_TOOLS, ...nativeTools]
    : [...ALL_TOOLS];

  if (options.frontend) {
    tools = tools.filter(
      (t) =>
        !t.frontends ||
        t.frontends.includes("all") ||
        t.frontends.includes(options.frontend!),
    );
  }

  if (options.tags?.length) {
    tools = tools.filter((t) => options.tags!.includes(t.tag));
  }

  if (options.excludeTags?.length) {
    tools = tools.filter((t) => !options.excludeTags!.includes(t.tag));
  }

  if (options.excludeNames?.length) {
    tools = tools.filter((t) => !options.excludeNames!.includes(t.name));
  }

  return tools;
}

// Re-export types for convenience
export type { ToolDefinition } from "./types.js";
