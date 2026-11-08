/**
 * Delivery-contract text — single source of truth for "how a reply
 * reaches the user" documentation.
 *
 * The response-flow contract is a property of the BACKEND (claude-sdk
 * and openai-agents enforce strict tool-only delivery; codex / kilo /
 * opencode accept plain assistant text), while the delivery TOOL NAMES
 * are a property of the FRONTEND (telegram/discord ship `end_turn` /
 * `send` / `react`; native ships `end_turn` / `send_message` /
 * `react`; teams ships `end_turn` / `send_message`). Before
 * this module, the strict contract was hardcoded into the frontend
 * prompt files (prompts/telegram.md etc.) — buried mid-prompt where
 * models routinely missed it on the first turn of a session, and
 * contradicted by the text-mode backends' own suffixes.
 *
 * Backends now build their suffix from here and append it via
 * `prepareSystemPrompt({ backendSuffix })`, which places the contract
 * at the END of the static prompt — the highest-salience position —
 * without touching the prompt-cache-friendly static/dynamic split.
 *
 * Also here:
 *   - `buildFlowViolationReminder` — frontend-aware [FLOW VIOLATION]
 *     re-prompt text (the shared constant used to hardcode telegram's
 *     tool names, which made the reminder wrong on Teams).
 *   - `buildFirstTurnReminder` — a one-line nudge appended to the
 *     formatted user prompt on the FIRST turn of a session. First
 *     turns are where flow violations cluster: the model hasn't seen
 *     the contract in action yet. One short line on turn 0 is far
 *     cheaper than the 2x-token violation retry it prevents.
 *
 * The contract bodies live in `prompts/system/contract-*.md`
 * (package-owned templates, see core/prompt/templates.ts). The
 * one-line runtime reminders below stay in code: they are
 * logic-adjacent strings, like log messages.
 */

import { loadSystemTemplate } from "../../../core/prompt/templates.js";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * How a backend delivers replies to the user.
 *
 *   - `tool-only` — output stream is private scratchpad; replies MUST
 *     go through a delivery tool (claude-sdk, openai-agents).
 *   - `text-or-tools` — plain assistant text is delivered as the
 *     reply; delivery tools add rich content / targeting (codex, kilo).
 *   - `text-preferred` — plain text is the normal route; tools only
 *     for genuine side effects (opencode).
 *   - `text-only` — plain text is the only route; the backend has no
 *     frontend MCP server wired, so the delivery tools do not exist
 *     (kimi).
 */
export type DeliveryMode =
  "tool-only" | "text-or-tools" | "text-preferred" | "text-only";

/** Frontend-specific delivery tool names. */
export type DeliveryToolNames = {
  /** Turn-closing final-reply tool. */
  endTurn: string;
  /** Mid-turn / rich-content send tool. */
  send: string;
  /** Emoji-reaction tool, when the frontend supports reactions. */
  react?: string;
};

// ── Frontend tool-name registry ─────────────────────────────────────────────

const FRONTEND_TOOLS: Record<string, DeliveryToolNames> = {
  telegram: { endTurn: "end_turn", send: "send", react: "react" },
  discord: { endTurn: "end_turn", send: "send", react: "react" },
  teams: { endTurn: "end_turn", send: "send_message" },
  native: { endTurn: "end_turn", send: "send_message", react: "react" },
  whatsapp: { endTurn: "end_turn", send: "send_message" },
};

const DEFAULT_TOOLS: DeliveryToolNames = {
  endTurn: "end_turn",
  send: "send",
  react: "react",
};

/**
 * Delivery tool names for a frontend. Unknown frontends (and
 * `terminal`, which has no outbound messaging surface) fall back to
 * the telegram-shaped defaults — harmless, since backends only enforce
 * the contract when a frontend MCP server is actually wired.
 */
export function deliveryToolsForFrontend(frontend: string): DeliveryToolNames {
  return FRONTEND_TOOLS[frontend] ?? DEFAULT_TOOLS;
}

/**
 * Register (or override) the delivery tool names for a frontend.
 * Extension seam: a new frontend declares its tool names here at
 * registration time and every backend's contract, flow-violation
 * reminder, and first-turn nudge pick them up — no edits to this
 * module or to any backend.
 */
export function registerFrontendDeliveryTools(
  frontend: string,
  tools: DeliveryToolNames,
): void {
  FRONTEND_TOOLS[frontend] = tools;
}

// ── Contract suffix ─────────────────────────────────────────────────────────

/**
 * Build the response-flow contract section a backend appends to the
 * static system prompt. The prose lives in package-owned templates
 * (`prompts/system/contract-*.md`) — kept deliberately tight: this is
 * read on every session, so every sentence must earn its tokens. The
 * per-tool details (parameter shapes, examples) live in the MCP tool
 * descriptions, which the model also has in context.
 */
export function buildDeliveryContract(
  mode: DeliveryMode,
  frontend: string,
): string {
  const t = deliveryToolsForFrontend(frontend);
  return loadSystemTemplate(`contract-${mode}`, {
    end_turn: t.endTurn,
    send: t.send,
    react: t.react,
  });
}

// ── Flow-violation reminder ─────────────────────────────────────────────────

/**
 * Frontend-aware [FLOW VIOLATION] reminder. Same shape as the legacy
 * shared `FLOW_VIOLATION_REMINDER`, but with the frontend's actual
 * tool names (the constant hardcoded \`send\`/\`react\`, which don't
 * exist on Teams).
 */
export function buildFlowViolationReminder(frontend: string): string {
  const t = deliveryToolsForFrontend(frontend);
  const reactPart = t.react
    ? `, or \`${t.react}(emoji=...)\` for an emoji acknowledgement`
    : "";
  return (
    "[FLOW VIOLATION] Your previous turn ended without a delivery tool, so the " +
    "user saw nothing. Replies must go through a tool call: " +
    `\`${t.endTurn}(text=...)\` for a final reply, ` +
    `\`${t.endTurn}()\` (no args) to close silently, ` +
    `\`${t.send}(...)\` for mid-turn rich content${reactPart}. ` +
    "Tool calls alone do not close the turn. Retry now using the correct tool call."
  );
}

// ── First-turn nudge ────────────────────────────────────────────────────────

/**
 * One-line reminder appended to the formatted user prompt on the first
 * turn of a session (strict backends only). Lives in the user message,
 * not the system prompt, so it costs nothing on later turns and never
 * perturbs the cached static prefix.
 */
export function buildFirstTurnReminder(frontend: string): string {
  const t = deliveryToolsForFrontend(frontend);
  return (
    `[New session — reminder: your prose output is never shown to the user. ` +
    `Deliver your reply via ${t.endTurn}(text=...), or ${t.endTurn}() to stay silent.]`
  );
}
