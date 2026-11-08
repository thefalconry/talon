/**
 * Convert Talon's MCP server set into Codex CLI's `--config` TOML
 * overrides.
 *
 * Codex's MCP support is configured at startup via `~/.codex/config.toml`
 * under the `mcp_servers.<name>` table, OR via per-process `--config`
 * overrides. The Codex SDK exposes the latter through
 * `CodexOptions.config` — a JSON object the SDK flattens into dotted
 * paths and serialises as TOML literals.
 *
 * Every server is a streamable-HTTP entry pointing at the daemon's MCP
 * hub (`core/mcp-hub`) — Codex connects with `mcp_servers.<name>.url`
 * (the same transport `codex mcp add --url` configures). The hub hosts
 * Talon's tools in-process and shares plugin/brave children across
 * chats, so Codex spawns no MCP subprocesses of its own:
 *
 *   {
 *     mcp_servers: {
 *       <name>: { url: "http://127.0.0.1:<port>/mcp/..." },
 *       ...
 *     }
 *   }
 */

import type { CodexOptions } from "@openai/codex-sdk";
import {
  talonHubUrl,
  pluginHubUrl,
  hubPluginServerNames,
} from "../../core/mcp-hub/index.js";
import type { ToolExclusionConfig } from "../../core/tools/mcp-env.js";
import { GATEWAY_TOKEN_ENV } from "../../core/engine/gateway-auth.js";
import { frontendsForChat } from "../runtime/frontends.js";

/**
 * AppToolApproval values accepted by Codex's `mcp_servers.<name>` table.
 *
 * Source: `codex-rs/config/src/mcp_types.rs` — the enum is `Auto | Prompt
 * | Approve` with `#[serde(rename_all = "snake_case")]`, so the wire
 * values are the lowercase strings below.
 *
 *   - `auto`    — Codex's default. Falls back to per-tool ToolAnnotations:
 *                 `read_only_hint=true` skips approval; otherwise
 *                 (no annotations, or `destructive_hint=true`, or
 *                 `open_world_hint=true`) approval is required.
 *   - `prompt`  — Approval is requested every time, regardless of
 *                 annotations.
 *   - `approve` — Auto-approve every call. `mcp_permission_prompt_is_auto_approved`
 *                 short-circuits to `true` for this server. Equivalent
 *                 to saying "Talon trusts this server, don't ask."
 */
type CodexToolApprovalMode = "auto" | "prompt" | "approve";

/** TOML-compatible record shape Codex's CLI accepts (HTTP transport). */
export interface CodexMcpServer {
  /** Streamable-HTTP MCP endpoint (Talon's hub). */
  url: string;
  /**
   * Per-server default approval mode applied to every tool the server
   * exposes (unless a `tools.<tool>.approval_mode` override is set).
   *
   * Talon defaults all of its own MCP servers to `"approve"` because
   * Codex is run in non-interactive API mode here — there is no UI to
   * surface an approval prompt to. Without this, any tool whose schema
   * lacks `read_only_hint=true` (which is most of them) silently routes
   * through the approval flow, gets auto-cancelled, and surfaces as the
   * Rust-side `"user cancelled MCP tool call"` error.
   *
   * Serialised as `default_tools_approval_mode` in the TOML config.
   */
  default_tools_approval_mode?: CodexToolApprovalMode;
  /**
   * Env var holding the hub's bearer token. Codex reads the value from its
   * own environment (inherited from the daemon), so the token never lands
   * in the `--config` flags on its command line.
   */
  bearer_token_env_var: string;
}

/**
 * Wrap a `Record<string, CodexMcpServer>` in the `{ mcp_servers: ... }`
 * envelope the Codex SDK expects on `CodexOptions.config`.
 *
 * The SDK's `CodexConfigObject` type recursively narrows values to
 * `string | number | boolean | array | object`. Our `CodexMcpServer`
 * shape satisfies that at runtime (every leaf is a string or string
 * array), but TypeScript can't prove the structural compatibility
 * because `Record<string, CodexMcpServer>` isn't a direct subtype of
 * the recursive `CodexConfigObject` type. The cast through `unknown`
 * is centralised here so the lie lives in exactly one documented spot
 * — both `init.ts` and any future caller use this helper.
 */
export function asCodexConfig(
  mcpServers: Record<string, CodexMcpServer>,
): CodexOptions["config"] {
  return {
    mcp_servers: mcpServers,
  } as unknown as CodexOptions["config"];
}

/**
 * Default approval mode for Talon-spawned MCP servers running under
 * Codex. Every entry built by `buildCodexMcpServers` is tagged with
 * this so Codex's approval flow short-circuits — see the
 * `default_tools_approval_mode` doc on `CodexMcpServer` for the full
 * reasoning. Exposed as a module-level constant rather than a
 * literal-everywhere so behaviour changes happen in exactly one place.
 */
const TALON_MCP_DEFAULT_APPROVAL: CodexToolApprovalMode = "approve";

/**
 * Build the Codex `mcp_servers` config map for a given chat.
 *
 * Includes one frontend-tools server per non-terminal frontend (so the
 * agent can call `send` / `react` / `end_turn` etc.) plus all configured
 * plugin MCP servers. Brave Search is included as a special case when
 * configured, matching the Claude SDK backend's behaviour.
 *
 * Every server is tagged with `default_tools_approval_mode: "approve"`
 * so Codex auto-approves every tool call. Talon owns these servers
 * (they're spawned with our launcher and either talk to our own
 * bridge or to a trusted upstream the user has configured), and
 * Codex's non-interactive API mode has no UI to surface approval
 * prompts on — the previous default of `auto` was silently routing
 * any tool lacking a `read_only_hint=true` schema annotation through
 * the approval flow, where it would be auto-cancelled with the
 * Rust-side error `"user cancelled MCP tool call"`.
 */
export function buildCodexMcpServers(args: {
  chatId: string;
  bridgeUrl: string;
  frontends: readonly string[];
  braveApiKey?: string;
  /** Tool-surface trimming slice of the Talon config. */
  toolExclusions?: ToolExclusionConfig | null;
}): Record<string, CodexMcpServer> {
  const { chatId, bridgeUrl, frontends, braveApiKey } = args;

  const servers: Record<string, CodexMcpServer> = {};

  // Frontend MCP tool servers — served in-process by the hub; the
  // (frontend, chatId) binding travels in the URL. Tool-surface
  // trimming is applied hub-side (initHub). Scoped to the chat's
  // owning frontend; cross-surface contexts keep the full set.
  for (const frontend of frontendsForChat(chatId, frontends)) {
    servers[`${frontend}-tools`] = {
      url: talonHubUrl(bridgeUrl, frontend, chatId),
      default_tools_approval_mode: TALON_MCP_DEFAULT_APPROVAL,
      bearer_token_env_var: GATEWAY_TOKEN_ENV,
    };
  }

  // Brave Search MCP server (if configured) — one hub child shared by
  // every chat.
  if (braveApiKey) {
    servers["brave-search"] = {
      url: pluginHubUrl(bridgeUrl, "brave-search", chatId),
      default_tools_approval_mode: TALON_MCP_DEFAULT_APPROVAL,
      bearer_token_env_var: GATEWAY_TOKEN_ENV,
    };
  }

  // Plugin MCP servers — hub-managed children (chat-scoped, idle-reaped).
  for (const name of hubPluginServerNames()) {
    servers[name] = {
      url: pluginHubUrl(bridgeUrl, name, chatId),
      default_tools_approval_mode: TALON_MCP_DEFAULT_APPROVAL,
      bearer_token_env_var: GATEWAY_TOKEN_ENV,
    };
  }

  return servers;
}
