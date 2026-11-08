#!/usr/bin/env node
/**
 * Stub claude CLI — replaces the real `claude` binary in integration tests.
 *
 * The Claude Agent SDK communicates with the `claude` CLI via streaming JSONL
 * over stdin/stdout (`--input-format stream-json --output-format stream-json`).
 * This script implements just enough of the protocol to drive the SDK through
 * a scripted conversation so we can write integration tests for our handler,
 * options, hooks, and stream processing without hitting the live API.
 *
 * The script to run is provided via `STUB_CLAUDE_SCRIPT` (path to JSON file)
 * or `STUB_CLAUDE_SCRIPT_INLINE` (inline JSON). Schema is described in
 * `protocol.ts`.
 *
 * Protocol summary (reverse-engineered from real SDK invocations):
 *
 *   SDK → binary (stdin):
 *     1. {type: "control_request", request: {subtype: "initialize", ...}}
 *     2. {type: "user", message: {role, content}, parent_tool_use_id, ...}
 *     3. (after tool_use blocks dispatch) {type: "user", message: {role: "user",
 *        content: [{type: "tool_result", tool_use_id, content}]}, ...}
 *
 *   binary → SDK (stdout):
 *     1. {type: "control_response", response: {subtype: "success", request_id,
 *        response: SDKControlInitializeResponse}}
 *     2. {type: "system", subtype: "init", session_id, ...}
 *     3. {type: "assistant", message: {content: [...]}, session_id, ...}
 *     4. {type: "result", subtype: "success"|"error_during_execution"|...}
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

// Static imports — esbuild's CJS bundle (used for the Windows SEA build)
// keeps dynamic `await import(...)` as `require(...)` calls, but the SEA
// binary doesn't ship `node_modules`, so dynamic imports fail at runtime
// on Windows. Static imports force esbuild to inline the module bodies
// into the bundle, which is what we need for SEA. POSIX uses the .mjs
// directly so it doesn't matter there, but keeping it consistent.
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const LOG_FILE = process.env.STUB_CLAUDE_LOG;
const log = (msg) => {
  if (LOG_FILE) appendFileSync(LOG_FILE, msg + "\n");
};

// ── MCP config + client management ──────────────────────────────────────────
//
// The SDK passes `--mcp-config '<json>'` on the binary's argv based on the
// `mcpServers` option. The real claude binary spawns those subprocesses and
// dispatches tool_use → MCP `tools/call` round-trips. The stub does the same
// when `script.dispatchMcp` is true — a real MCP client connection over stdio
// to each configured server, lazy spawn on first use.

const parseMcpConfig = () => {
  const argv = process.argv;
  const idx = argv.findIndex((a) => a === "--mcp-config");
  if (idx === -1 || idx + 1 >= argv.length) return { mcpServers: {} };
  try {
    return JSON.parse(argv[idx + 1]);
  } catch (e) {
    log("--mcp-config parse error: " + e.message);
    return { mcpServers: {} };
  }
};

const MCP_CONFIG = parseMcpConfig();
log(
  "MCP_CONFIG servers: " +
    JSON.stringify(Object.keys(MCP_CONFIG.mcpServers ?? {})),
);

/** Map of server name → {client, transport} once connected. */
const mcpClients = new Map();

// Like the real CLI, `${VAR}` references in MCP headers expand from the
// process env — how Talon hands over the gateway token without putting it
// on the command line.
const expandHeaders = (headers) =>
  Object.fromEntries(
    Object.entries(headers ?? {}).map(([k, v]) => [
      k,
      String(v).replace(
        /\$\{([A-Z0-9_]+)\}/g,
        (_, name) => process.env[name] ?? "",
      ),
    ]),
  );

const getMcpClient = async (serverName) => {
  if (mcpClients.has(serverName)) return mcpClients.get(serverName);
  const cfg = MCP_CONFIG.mcpServers?.[serverName];
  if (!cfg) {
    log(`getMcpClient: no config for server ${serverName}`);
    return null;
  }
  try {
    // Mirror the real binary's transport selection: `type: "http"` (the
    // shape Talon's MCP hub emits) connects over streamable HTTP; the
    // command/args shape spawns a stdio subprocess.
    const transport =
      cfg.type === "http" || cfg.url
        ? new StreamableHTTPClientTransport(new URL(cfg.url), {
            requestInit: { headers: expandHeaders(cfg.headers) },
          })
        : new StdioClientTransport({
            command: cfg.command,
            args: cfg.args ?? [],
            env: cfg.env ? { ...process.env, ...cfg.env } : { ...process.env },
            stderr: "pipe",
          });
    const client = new McpClient(
      { name: "stub-claude", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    log(`MCP connected: ${serverName}`);
    const entry = { client, transport };
    mcpClients.set(serverName, entry);
    return entry;
  } catch (e) {
    log(`MCP connect error for ${serverName}: ${e.message}`);
    return null;
  }
};

/**
 * Parse `mcp__<server>__<tool>` into [serverName, toolName]. The boundary is
 * the first `__` after the leading `mcp__` — server names may contain
 * hyphens (e.g. `telegram-tools`) but not `__` itself.
 */
const parseMcpToolName = (fullName) => {
  if (!fullName.startsWith("mcp__")) return null;
  const idx = fullName.indexOf("__", 5);
  if (idx === -1) return null;
  return [fullName.slice(5, idx), fullName.slice(idx + 2)];
};

const dispatchMcpToolUse = async (block) => {
  const parsed = parseMcpToolName(block.name);
  if (!parsed) {
    log(`dispatchMcpToolUse: not MCP-routed: ${block.name}`);
    return null;
  }
  const [serverName, toolName] = parsed;
  const conn = await getMcpClient(serverName);
  if (!conn) return null;
  try {
    log(
      `MCP tools/call ${serverName}.${toolName} ` +
        JSON.stringify(block.input).slice(0, 200),
    );
    const result = await conn.client.callTool({
      name: toolName,
      arguments: block.input,
    });
    log("MCP tools/call result: " + JSON.stringify(result).slice(0, 500));
    return result;
  } catch (e) {
    log(`MCP tools/call error: ${e.message}`);
    return { isError: true, content: [{ type: "text", text: e.message }] };
  }
};

const closeAllMcpClients = async () => {
  for (const [name, { client, transport }] of mcpClients) {
    try {
      await client.close();
    } catch (e) {
      log(`MCP close error ${name}: ${e.message}`);
    }
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
  }
  mcpClients.clear();
};

// ── Load script ──────────────────────────────────────────────────────────────

const loadScript = () => {
  if (process.env.STUB_CLAUDE_SCRIPT_INLINE) {
    return JSON.parse(process.env.STUB_CLAUDE_SCRIPT_INLINE);
  }
  const path = process.env.STUB_CLAUDE_SCRIPT;
  if (!path || !existsSync(path)) {
    // No script provided — degrade gracefully. Used for SDK model-discovery
    // boots and other "init only, never receive user messages" flows.
    log(
      `no script provided (path=${path ?? "unset"}), running in init-only mode`,
    );
    return { turns: [] };
  }
  return JSON.parse(readFileSync(path, "utf8"));
};

const SCRIPT = loadScript();
const SESSION_ID =
  SCRIPT.sessionId ?? "stub-session-" + randomUUID().slice(0, 8);

// ── Output helpers ──────────────────────────────────────────────────────────

const send = (obj) => {
  const line = JSON.stringify(obj);
  log("STDOUT: " + line);
  process.stdout.write(line + "\n");
};

// Mock models the stub advertises through the standard
// `SDKControlInitializeResponse.models` field. The production `registerClaudeModels`
// path discovers these via `q.supportedModels()` exactly the same way it would
// against a real `claude` binary. That's the whole point — tests run through
// the unmodified bootstrap, no test-side overrides for model discovery.
//
// Schema per SDK's sdk.d.ts: `{ value, displayName, description }` (camelCase).
const STUB_MODELS = [
  {
    value: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6 (stub)",
    description:
      "Stub model — integration test fixture. Always responds with whatever " +
      "the test script in STUB_CLAUDE_SCRIPT specifies for this turn.",
  },
  {
    value: "claude-opus-4-7",
    displayName: "Opus 4.7 (stub)",
    description:
      "Stub model — integration test fixture (alias of sonnet stub).",
  },
  {
    value: "default",
    displayName: "Default (stub)",
    description:
      "Default stub model — used when tests don't specify one explicitly.",
  },
];

const defaultInitResponse = {
  commands: [],
  agents: [],
  output_style: "default",
  available_output_styles: ["default"],
  models: STUB_MODELS,
  account: { email: "stub@stub.test", organization: { name: "stub-org" } },
};

const defaultSystemInit = {
  type: "system",
  subtype: "init",
  session_id: SESSION_ID,
  cwd: process.cwd(),
  tools: [],
  mcp_servers: [],
  model: "claude-sonnet-4-6",
  permissionMode: "bypassPermissions",
  slash_commands: [],
  apiKeySource: "none",
};

// ── State ────────────────────────────────────────────────────────────────────

let turnIndex = 0;
/** Map from request_id we emitted -> resolver waiting on the SDK's response. */
const pendingRequests = new Map();
/** When set, the init handshake has captured these hook callback ids by event. */
let hookCallbackIds = {};

// ── Message handlers ────────────────────────────────────────────────────────

const handleInitialize = (msg) => {
  // Capture hook callback ids — needed if the stub fires hooks during a turn.
  const hooks = msg.request?.hooks ?? {};
  hookCallbackIds = {};
  for (const [event, matchers] of Object.entries(hooks)) {
    hookCallbackIds[event] = matchers.flatMap((m) => m.hookCallbackIds ?? []);
  }
  log("CAPTURED hookCallbackIds: " + JSON.stringify(hookCallbackIds));
  const initResponse = SCRIPT.initResponse ?? defaultInitResponse;
  send({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: msg.request_id,
      response: initResponse,
    },
  });
  send(SCRIPT.systemInit ?? defaultSystemInit);
};

/** Send a control_request to the SDK and resolve with its control_response payload. */
const sendControlRequest = (request) => {
  const requestId = "stub_req_" + randomUUID().slice(0, 8);
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    send({ type: "control_request", request_id: requestId, request });
    // Per-call timeout in case SDK never responds
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(
          new Error("control_request timeout: " + JSON.stringify(request)),
        );
      }
    }, 5000).unref();
  });
};

const handleUser = async (_msg) => {
  // Pop the next scripted turn and emit its messages
  const turn = SCRIPT.turns?.[turnIndex];
  turnIndex += 1;
  if (!turn) {
    // No more scripted turns — emit a benign result and exit
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "stub: out of script",
      duration_ms: 1,
      duration_api_ms: 0,
      num_turns: turnIndex,
      session_id: SESSION_ID,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    return;
  }
  for (const out of turn.emit ?? []) {
    if (out.type === "_fire_hook") {
      // Synthesize a hook_callback control_request to the SDK. The SDK calls
      // the registered hook function and replies with the hook output. If the
      // hook returns continue:false, we stop emitting subsequent items.
      const callbackIds = hookCallbackIds[out.event] ?? [];
      if (!callbackIds.length) {
        log(`no hook registered for event ${out.event}, skipping`);
        continue;
      }
      let stopped = false;
      for (const callbackId of callbackIds) {
        try {
          const resp = await sendControlRequest({
            subtype: "hook_callback",
            callback_id: callbackId,
            input: out.input,
            tool_use_id: out.tool_use_id,
          });
          log("hook response: " + JSON.stringify(resp));
          if (resp?.response?.continue === false) {
            stopped = true;
            break;
          }
        } catch (e) {
          log("hook fire error: " + e.message);
        }
      }
      if (stopped) {
        log("hook returned continue:false, halting emit loop");
        // Emit a result indicating hook-driven termination so the SDK iterator
        // closes cleanly.
        send({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "stub: hook stopped",
          duration_ms: 1,
          duration_api_ms: 0,
          num_turns: turnIndex,
          session_id: SESSION_ID,
          total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
        });
        return;
      }
      continue;
    }
    const filled = fillDefaults(out);
    send(filled);

    // ── MCP auto-dispatch ─────────────────────────────────────────────────
    // After emitting the assistant message to the SDK, walk its tool_use
    // blocks and dispatch any MCP-routed names through a real MCP client
    // connection. The result lands in the protocol log and is also wrapped
    // as a synthetic `user`/`tool_result` message back to the SDK so the
    // handler.ts loop sees the round-trip the same way it would in
    // production. Disabled by default — opt in via `script.dispatchMcp`.
    if (
      SCRIPT.dispatchMcp &&
      filled.type === "assistant" &&
      Array.isArray(filled.message?.content)
    ) {
      for (const block of filled.message.content) {
        if (block?.type !== "tool_use") continue;
        const result = await dispatchMcpToolUse(block);
        if (result === null) continue;
        // Synthesize a user/tool_result so the SDK can chain on it. The
        // real binary sends this back through stdout when MCP returns.
        send({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: block.id,
                content: Array.isArray(result.content)
                  ? result.content
                  : [{ type: "text", text: JSON.stringify(result) }],
                is_error: Boolean(result.isError),
              },
            ],
          },
          session_id: SESSION_ID,
          parent_tool_use_id: out.parent_tool_use_id ?? null,
        });
      }
    }
  }
};

const fillDefaults = (out) => {
  if (out.type === "assistant") {
    return {
      type: "assistant",
      message: {
        id: "msg_" + randomUUID().slice(0, 8),
        type: "message",
        role: "assistant",
        model: out.message?.model ?? "claude-sonnet-4-6",
        content: out.message?.content ?? [],
        stop_reason: out.message?.stop_reason ?? "end_turn",
        stop_sequence: out.message?.stop_sequence ?? null,
        usage: out.message?.usage ?? {
          input_tokens: 1,
          output_tokens: 1,
        },
      },
      session_id: SESSION_ID,
      parent_tool_use_id: out.parent_tool_use_id ?? null,
    };
  }
  if (out.type === "result") {
    // Talon's stream.ts reads token usage from `modelUsage[sdkModel]`. Build a
    // matching shape from `usage` if the test didn't provide modelUsage explicitly.
    const usage = out.usage ?? { input_tokens: 0, output_tokens: 0 };
    const defaultModelUsage = {
      "claude-sonnet-4-6": {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        contextWindow: 200_000,
      },
    };
    return {
      type: "result",
      subtype: out.subtype ?? "success",
      is_error: out.is_error ?? false,
      result: out.result ?? "",
      duration_ms: out.duration_ms ?? 1,
      duration_api_ms: out.duration_api_ms ?? 0,
      num_turns: out.num_turns ?? turnIndex,
      session_id: SESSION_ID,
      total_cost_usd: out.total_cost_usd ?? 0,
      usage,
      modelUsage: out.modelUsage ?? defaultModelUsage,
    };
  }
  return out;
};

// ── Stdin loop ──────────────────────────────────────────────────────────────

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    log("STDIN: " + line);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log("STDIN parse error on: " + line);
      continue;
    }
    if (
      msg.type === "control_request" &&
      msg.request?.subtype === "initialize"
    ) {
      handleInitialize(msg);
    } else if (msg.type === "user") {
      handleUser(msg).catch((e) => log("handleUser error: " + e.message));
    } else if (msg.type === "control_response") {
      // Response to a control_request the stub previously sent (e.g. a fired
      // hook). Resolve the pending promise.
      const requestId = msg.response?.request_id;
      const pending = pendingRequests.get(requestId);
      if (pending) {
        pendingRequests.delete(requestId);
        pending.resolve(msg);
      }
    } else if (msg.type === "control_request") {
      // Ack other control requests with empty success so the SDK doesn't hang
      send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response: {},
        },
      });
    }
  }
});

process.stdin.on("end", async () => {
  log("STDIN ENDED");
  await closeAllMcpClients();
  // Give pending stdout writes time to flush, then exit
  setTimeout(() => process.exit(0), 50);
});

// Safety: hard timeout so a misbehaving test doesn't hang CI
const HARD_TIMEOUT_MS = Number(process.env.STUB_CLAUDE_TIMEOUT_MS ?? 10000);
setTimeout(async () => {
  log(`HARD TIMEOUT after ${HARD_TIMEOUT_MS}ms`);
  await closeAllMcpClients();
  process.exit(2);
}, HARD_TIMEOUT_MS).unref();
