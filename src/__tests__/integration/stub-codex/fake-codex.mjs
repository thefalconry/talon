#!/usr/bin/env node
/**
 * Stub `codex` CLI — replaces the real `codex` binary in integration tests.
 *
 * The `@openai/codex-sdk` drives a turn by spawning
 *   `codex exec --experimental-json [--config k=v ...] [--model m] [resume <id>]`
 * writing the prompt to stdin, then reading newline-delimited `ThreadEvent`
 * JSON from stdout until the process exits 0. This script implements just
 * enough of that protocol to drive Talon's codex handler through a scripted
 * turn without hitting the live model.
 *
 * Wiring (set by the harness):
 *   STUB_CODEX_SCRIPT   path to JSON file (CodexStubScript, see protocol.ts)
 *   STUB_CODEX_STATE    path to a counter file (persists "which turn" across
 *                       the per-turn re-spawns)
 *   STUB_CODEX_LOG      optional protocol log path
 *   STUB_CODEX_TIMEOUT_MS hard timeout (default 10000)
 *
 * MCP: the codex-sdk passes MCP servers as flattened TOML `--config
 * mcp_servers.<name>.<field>=<tomlvalue>` argv. When the script sets
 * `dispatchMcp`, we reconstruct that config, connect a real MCP client over
 * stdio to the named server, and invoke the tool — so `end_turn` / `send`
 * route through Talon's gateway exactly as in production.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const LOG_FILE = process.env.STUB_CODEX_LOG;
const log = (msg) => {
  if (LOG_FILE) {
    try {
      appendFileSync(LOG_FILE, msg + "\n");
    } catch {
      /* ignore */
    }
  }
};

// ── Parse `--config mcp_servers.*` argv back into a server map ────────────────
//
// The codex-sdk flattens `{ mcp_servers: { "<name>": { command, args, env } } }`
// into repeated `--config <dotted.key>=<tomlValue>` args. Strings are JSON
// (toTomlValue uses JSON.stringify), arrays render as `["a","b"]` (valid JSON),
// numbers/bools are bare. We reverse that into a nested object.

const decodeTomlValue = (raw) => {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.replace(/^"|"$/g, "");
    }
  }
  if (v.startsWith("[")) {
    try {
      return JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
};

const setNested = (obj, dottedKey, value) => {
  const parts = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
};

const parseConfigArgs = () => {
  const argv = process.argv;
  const root = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--config") continue;
    const pair = argv[i + 1];
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq);
    const value = decodeTomlValue(pair.slice(eq + 1));
    setNested(root, key, value);
  }
  return root;
};

const CONFIG = parseConfigArgs();
const MCP_SERVERS = CONFIG.mcp_servers ?? {};
log("MCP servers from --config: " + JSON.stringify(Object.keys(MCP_SERVERS)));

// ── MCP client management (mirror of fake-claude) ────────────────────────────

const mcpClients = new Map();

const getMcpClient = async (serverName) => {
  if (mcpClients.has(serverName)) return mcpClients.get(serverName);
  const cfg = MCP_SERVERS?.[serverName];
  if (!cfg || (!cfg.command && !cfg.url)) {
    log(`getMcpClient: no config for server ${serverName}`);
    return null;
  }
  try {
    // `url` is the streamable-HTTP shape Talon's MCP hub emits (the real
    // codex binary connects the same way); command/args is legacy stdio.
    // Like the real binary: `bearer_token_env_var` names an env var whose
    // value is sent as the bearer token.
    const bearer = cfg.bearer_token_env_var
      ? process.env[cfg.bearer_token_env_var]
      : undefined;
    const transport = cfg.url
      ? new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: {
            headers: {
              ...cfg.http_headers,
              ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
            },
          },
        })
      : new StdioClientTransport({
          command: cfg.command,
          args: Array.isArray(cfg.args) ? cfg.args : [],
          env:
            cfg.env && typeof cfg.env === "object"
              ? { ...process.env, ...cfg.env }
              : { ...process.env },
          stderr: "pipe",
        });
    const client = new McpClient(
      { name: "stub-codex", version: "0.0.0" },
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

const dispatchMcpTool = async (server, tool, args) => {
  const conn = await getMcpClient(server);
  if (!conn) return null;
  try {
    log(
      `MCP tools/call ${server}.${tool} ${JSON.stringify(args).slice(0, 200)}`,
    );
    const result = await conn.client.callTool({
      name: tool,
      arguments: args ?? {},
    });
    log("MCP tools/call result: " + JSON.stringify(result).slice(0, 400));
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

// ── Load script + turn counter ───────────────────────────────────────────────

const loadScript = () => {
  const path = process.env.STUB_CODEX_SCRIPT;
  if (!path || !existsSync(path)) {
    log(`no script (path=${path ?? "unset"}), emitting empty turn`);
    return { turns: [] };
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    log("script parse error: " + e.message);
    return { turns: [] };
  }
};

const nextTurnIndex = () => {
  const statePath = process.env.STUB_CODEX_STATE;
  if (!statePath) return 0;
  let idx = 0;
  try {
    if (existsSync(statePath))
      idx = Number(readFileSync(statePath, "utf8")) || 0;
  } catch {
    idx = 0;
  }
  try {
    writeFileSync(statePath, String(idx + 1));
  } catch {
    /* ignore */
  }
  return idx;
};

const SCRIPT = loadScript();
const THREAD_ID = SCRIPT.threadId ?? "thr_stub_" + randomUUID().slice(0, 8);

// ── Output ───────────────────────────────────────────────────────────────────

const emit = (obj) => {
  const line = JSON.stringify(obj);
  log("STDOUT: " + line);
  process.stdout.write(line + "\n");
};

const completedItem = (item) =>
  emit({
    type: "item.completed",
    item: { id: "i_" + randomUUID().slice(0, 8), ...item },
  });

// ── Read the whole prompt from stdin, then run the scripted turn ─────────────

const readStdin = () =>
  new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    // Some spawns close stdin immediately; guard with a short timer.
    setTimeout(() => resolve(buf), 250).unref();
  });

const HARD_TIMEOUT_MS = Number(process.env.STUB_CODEX_TIMEOUT_MS ?? 10000);
const hardTimer = setTimeout(async () => {
  log(`HARD TIMEOUT after ${HARD_TIMEOUT_MS}ms`);
  await closeAllMcpClients();
  process.exit(2);
}, HARD_TIMEOUT_MS);
hardTimer.unref();

const run = async () => {
  const input = await readStdin();
  log("STDIN: " + input.slice(0, 200));

  const turnIdx = nextTurnIndex();
  const turn = SCRIPT.turns?.[turnIdx];
  log(`turn index ${turnIdx} (have ${SCRIPT.turns?.length ?? 0} turns)`);

  emit({ type: "thread.started", thread_id: THREAD_ID });
  emit({ type: "turn.started" });

  if (!turn) {
    emit({
      type: "turn.completed",
      usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
    });
    await finish();
    return;
  }

  for (const item of turn.emit ?? []) {
    if (item.type === "agent_message") {
      completedItem({ type: "agent_message", text: item.text ?? "" });
    } else if (item.type === "mcp_tool_call") {
      let result = null;
      if (SCRIPT.dispatchMcp) {
        result = await dispatchMcpTool(item.server, item.tool, item.arguments);
      }
      completedItem({
        id: item.id ?? "i_" + randomUUID().slice(0, 8),
        type: "mcp_tool_call",
        server: item.server,
        tool: item.tool,
        arguments: item.arguments ?? {},
        status: result?.isError ? "failed" : "completed",
        result: result ?? { content: [], structured_content: null },
      });
    } else if (item.type === "reasoning") {
      completedItem({ type: "reasoning", text: item.text ?? "" });
    } else {
      // Raw escape hatch — emit verbatim as the item.
      completedItem(item);
    }
  }

  if (turn.fail) {
    emit({ type: "turn.failed", error: { message: turn.fail } });
  } else {
    emit({
      type: "turn.completed",
      usage: {
        input_tokens: turn.usage?.input_tokens ?? 10,
        output_tokens: turn.usage?.output_tokens ?? 5,
        cached_input_tokens: turn.usage?.cached_input_tokens ?? 0,
        reasoning_output_tokens: turn.usage?.reasoning_output_tokens ?? 0,
      },
    });
  }

  await finish();
};

const finish = async () => {
  clearTimeout(hardTimer);
  await closeAllMcpClients();
  // Flush stdout, then exit 0 so the codex-sdk's exit-code check passes.
  setTimeout(() => process.exit(0), 30);
};

run().catch(async (e) => {
  log("run error: " + (e?.stack ?? e?.message ?? String(e)));
  await closeAllMcpClients();
  process.exit(1);
});
