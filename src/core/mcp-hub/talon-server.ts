/**
 * In-process Talon tool server: composeTools + createBridge + textResult,
 * bound to one (frontend, chatId) that arrives per hub session from the
 * request URL. One `McpServer` instance per session, zero processes.
 *
 * Tool-surface trimming (`disabledTools` / `disabledToolTags`) never
 * removes `end_turn` — tool-only backends need it to close every turn.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { composeTools } from "../tools/index.js";
import { createBridge, textResult } from "../tools/bridge.js";
import type {
  BridgeFunction,
  ToolDefinition,
  ToolFrontend,
  ToolTag,
} from "../tools/types.js";
import {
  guestParamViolation,
  isGuestToolAllowed,
  isGuestTurn,
  isOperatorPrivateChat,
  operatorDmChatId,
  OPERATOR_PRIVATE_OUTPUT_TOOLS,
} from "./guest-scope.js";

export const VALID_TOOL_FRONTENDS: ReadonlySet<string> = new Set([
  "telegram",
  "teams",
  "terminal",
  "discord",
  "native",
  "whatsapp",
]);

export type TalonServerOptions = {
  frontend: ToolFrontend;
  chatId: string;
  /** Gateway base URL, e.g. http://127.0.0.1:19876 */
  bridgeUrl: string;
  disabledTools?: readonly string[];
  disabledToolTags?: readonly string[];
  /** Expose the native tool set (replaces the SDK built-ins). */
  includeNativeTools?: boolean;
  /**
   * Build the guest surface: expose only the conversation allowlist. Calls
   * are re-checked against the chat's live turn scope either way, so a
   * session opened by an operator turn can't serve a later guest turn.
   * See guest-scope.ts.
   */
  guest?: boolean;
};

/** Build a Talon tool MCP server bound to one (frontend, chatId) pair. */
export function buildTalonToolServer(options: TalonServerOptions): McpServer {
  const bridge = createBridge(options.bridgeUrl, options.chatId);
  const server = new McpServer({
    name: `${options.frontend}-tools`,
    version: "3.0.0",
  });

  const excludeNames = (options.disabledTools ?? []).filter(
    (name) => name !== "end_turn",
  );
  const excludeTags = (options.disabledToolTags ?? []) as ToolTag[];

  const tools = composeTools({
    frontend: options.frontend,
    excludeTags,
    excludeNames,
    includeNativeTools: options.includeNativeTools,
  });
  if (excludeTags.length > 0 && !tools.some((t) => t.name === "end_turn")) {
    const endTurn = composeTools({ frontend: options.frontend }).find(
      (t) => t.name === "end_turn",
    );
    if (endTurn) tools.push(endTurn);
  }

  const surface = options.guest
    ? tools.filter((t) => isGuestToolAllowed(t.name))
    : tools;

  for (const tool of surface) {
    server.tool(tool.name, tool.description, tool.schema, async (params) =>
      textResult(await callScoped(options, tool, bridge, params)),
    );
  }

  return server;
}

/** A refused call: an error result the model reads as a failure. */
function refuse(message: string): { ok: false; text: string } {
  return { ok: false, text: message };
}

const PRIVATE_OUTPUT_RECEIPT =
  "Done. The result carries a live bridge credential, so it was sent to the " +
  "operator's private chat instead of this one. Do not repeat or summarise it here.";

/**
 * Run one tool call under the chat's live scope: guest turns get the
 * allowlist and the parameter guard; credential-bearing tools only ever
 * show their output in the operator's private chat.
 */
async function callScoped(
  options: TalonServerOptions,
  tool: ToolDefinition,
  bridge: BridgeFunction,
  params: Record<string, unknown>,
): Promise<unknown> {
  const guest = options.guest || isGuestTurn(options.chatId);
  if (guest) {
    if (!isGuestToolAllowed(tool.name)) {
      return refuse("Not available in this chat.");
    }
    const why = guestParamViolation(options.chatId, params);
    if (why) return refuse(`Not available in this chat: ${why}.`);
  }
  if (
    !OPERATOR_PRIVATE_OUTPUT_TOOLS.has(tool.name) ||
    isOperatorPrivateChat(options.frontend, options.chatId)
  ) {
    return tool.execute(params, bridge);
  }
  const dm = operatorDmChatId();
  if (!dm) {
    return refuse(
      `${tool.name} returns a credential and can only run in the operator's private chat.`,
    );
  }
  const result = (await tool.execute(params, bridge)) as {
    ok?: boolean;
    text?: string;
  };
  if (result?.ok === false) return result;
  const text = result?.text ?? JSON.stringify(result);
  await bridge("send_message", { text, chat_id: dm });
  return { ok: true, text: PRIVATE_OUTPUT_RECEIPT };
}
