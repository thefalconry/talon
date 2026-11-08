/**
 * In-process fake of the opencode / kilo HTTP server.
 *
 * Both backends (kilo is an opencode fork with the same wire API) talk to a
 * loopback HTTP server via an `openapi-fetch`-style SDK client, and the
 * backend ADOPTS any server already listening on `OPENCODE_PORT`/`KILO_PORT`
 * (it probes `GET /global/health` and reuses it instead of spawning the real
 * `opencode serve`). So we start this fake on a free port, point the env var
 * at it, and the production backend connects to it.
 *
 * The turn the model "runs" is scripted per-test via `setTurn`. On
 * `promptAsync` the server: dispatches any scripted MCP tool calls through a
 * real MCP client (routing to Talon's gateway), pushes SSE events
 * (message.part.updated for tools, message.updated for usage, session.idle to
 * end the turn), and records the final assistant message for the subsequent
 * `session.messages` read.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface RemoteTurnItem {
  type: "text" | "tool";
  /** For text. */
  text?: string;
  /** For tool. */
  tool?: string;
  input?: Record<string, unknown>;
}

export interface RemoteTurn {
  emit: RemoteTurnItem[];
  usage?: { input?: number; output?: number };
}

interface McpRegistration {
  name: string;
  /** Stdio shape (`type: "local"`). */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Remote shape (`type: "remote"`) — Talon's MCP hub URL. */
  url?: string;
  headers?: Record<string, string>;
}

export interface FakeRemoteServer {
  port: number;
  /** Set the script for the NEXT promptAsync. */
  setTurn: (turn: RemoteTurn) => void;
  /** Names of MCP servers registered via POST /mcp. */
  mcpRegistrations: () => string[];
  stop: () => Promise<void>;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

const readBody = (req: import("node:http").IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => resolve(buf));
  });

export async function startFakeRemoteServer(
  port = 0,
): Promise<FakeRemoteServer> {
  const sseClients = new Set<ServerResponse>();
  const mcpServers = new Map<string, McpRegistration>();
  const mcpClients = new Map<
    string,
    {
      client: McpClient;
      transport: StdioClientTransport | StreamableHTTPClientTransport;
    }
  >();
  let currentTurn: RemoteTurn = { emit: [] };
  let lastAssistant: Record<string, unknown> | null = null;
  const sessions = new Set<string>();

  const dbg = (msg: string) => {
    if (process.env.STUB_REMOTE_DEBUG)
      process.stderr.write(`[fake-remote] ${msg}\n`);
  };

  // Event-driven "wait until an SSE client is connected". The backend subscribes
  // to the SSE stream just before promptAsync but doesn't await it, so the
  // connection can land a few ms after the prompt POST. Resolving on the actual
  // connect (vs polling) is both cleaner and race-free.
  const sseWaiters = new Set<() => void>();
  const whenSseClient = (timeoutMs = 5000): Promise<void> =>
    new Promise((resolve) => {
      if (sseClients.size > 0) return resolve();
      const done = () => {
        clearTimeout(timer);
        sseWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      sseWaiters.add(done);
    });

  const pushSse = (event: Record<string, unknown>) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    dbg(`push ${event.type} to ${sseClients.size} client(s)`);
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        /* client gone */
      }
    }
  };

  const getMcpClient = async (name: string) => {
    if (mcpClients.has(name)) return mcpClients.get(name)!;
    const cfg = mcpServers.get(name);
    if (!cfg) return null;
    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    if (cfg.url) {
      // Remote registration — Talon's MCP hub over streamable HTTP.
      transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: { headers: cfg.headers ?? {} },
      });
    } else {
      const mergedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string") mergedEnv[k] = v;
      }
      Object.assign(mergedEnv, cfg.env ?? {});
      transport = new StdioClientTransport({
        command: cfg.command ?? "",
        args: cfg.args ?? [],
        env: mergedEnv,
        stderr: "pipe",
      });
    }
    const client = new McpClient(
      { name: "fake-remote", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    const entry = { client, transport };
    mcpClients.set(name, entry);
    return entry;
  };

  /**
   * Pick the talon chat MCP server (named `talon-tools-*`). The stub executes
   * turns serially, so the most recent registration matches the prompt's chat;
   * production additionally scopes the visible catalog per prompt.
   */
  const talonServerName = () => {
    const talon = [...mcpServers.keys()].filter((n) =>
      n.startsWith("talon-tools-"),
    );
    return talon[talon.length - 1] ?? [...mcpServers.keys()].pop();
  };

  const runTurn = async (sessionID: string) => {
    await whenSseClient();
    const parts: Array<Record<string, unknown>> = [];
    for (const item of currentTurn.emit) {
      if (item.type === "text") {
        parts.push({ type: "text", text: item.text ?? "" });
      } else if (item.type === "tool") {
        const callID = "call_" + randomUUID().slice(0, 8);
        const input = item.input ?? {};
        // Actually execute the tool through the registered MCP server so it
        // routes to Talon's gateway (the real opencode server does this).
        const serverName = talonServerName();
        dbg(`tool ${item.tool} → server ${serverName ?? "(none)"}`);
        if (serverName) {
          const conn = await getMcpClient(serverName);
          if (conn) {
            try {
              const r = await conn.client.callTool({
                name: item.tool ?? "",
                arguments: input,
              });
              dbg(
                `callTool ${item.tool} result ${JSON.stringify(r).slice(0, 200)}`,
              );
            } catch (e) {
              dbg(`callTool ${item.tool} error ${(e as Error).message}`);
            }
          } else {
            dbg(`no MCP client for ${serverName}`);
          }
        }
        // Report the tool via SSE so the handler's onToolUse fires.
        pushSse({
          type: "message.part.updated",
          properties: {
            sessionID,
            part: {
              id: "prt_" + randomUUID().slice(0, 8),
              type: "tool",
              callID,
              tool: item.tool,
              state: { status: "completed", input },
            },
          },
        });
        parts.push({
          type: "tool",
          callID,
          tool: item.tool,
          state: { status: "completed", input },
        });
      }
    }

    const info = {
      role: "assistant",
      sessionID,
      tokens: {
        input: currentTurn.usage?.input ?? 10,
        output: currentTurn.usage?.output ?? 5,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
    };
    lastAssistant = {
      id: "msg_" + randomUUID().slice(0, 8),
      role: "assistant",
      parts,
      info,
    };

    // Usage update, then idle to close the turn.
    pushSse({ type: "message.updated", properties: { info } });
    pushSse({ type: "session.idle", properties: { sessionID } });
  };

  const server: Server = createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    const method = req.method ?? "GET";
    dbg(`${method} ${url}`);

    // Health — the reuse probe.
    if (url === "/global/health") return json(res, 200, { status: "ok" });

    // SSE event stream.
    if (url === "/global/event" || url === "/event") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      // Wake anything waiting for a live stream (see whenSseClient).
      // Snapshot: woken waiters remove themselves mid-iteration.
      for (const w of Array.from(sseWaiters)) w();
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // Question watchdog polls this — return an empty list so it idles quietly.
    if (url === "/question") return json(res, 200, []);

    // Provider list.
    if (url === "/provider" || url === "/config/providers") {
      return json(res, 200, {
        stub: [
          {
            id: "stub",
            name: "Stub Provider",
            models: { "stub-model": { providerID: "stub" } },
          },
        ],
      });
    }

    if (url === "/mcp" && method === "POST") {
      void readBody(req).then((body) => {
        try {
          const parsed = JSON.parse(body || "{}");
          const name = String(parsed.name ?? "");
          const cfg = parsed.config ?? {};
          // opencode/kilo `mcp.add` sends `config.command` as a full
          // `[executable, ...args]` array and `config.environment` (not `env`).
          const cmdArr = Array.isArray(cfg.command)
            ? cfg.command.map(String)
            : cfg.command
              ? [String(cfg.command)]
              : [];
          const environment =
            cfg.environment && typeof cfg.environment === "object"
              ? cfg.environment
              : cfg.env && typeof cfg.env === "object"
                ? cfg.env
                : {};
          const remoteUrl =
            typeof cfg.url === "string" && cfg.url ? cfg.url : undefined;
          if (name && remoteUrl) {
            // `type: "remote"` — Talon's MCP hub endpoint.
            mcpServers.set(name, {
              name,
              url: remoteUrl,
              headers:
                cfg.headers && typeof cfg.headers === "object"
                  ? (cfg.headers as Record<string, string>)
                  : undefined,
            });
          } else if (name && cmdArr.length > 0) {
            mcpServers.set(name, {
              name,
              command: cmdArr[0],
              args: cmdArr.slice(1),
              env: environment,
            });
          }
        } catch {
          /* ignore */
        }
        json(res, 200, { ok: true });
      });
      return;
    }

    // Disconnect: opencode/kilo send `POST /mcp/{name}/disconnect`; also accept
    // a bare DELETE /mcp/{name} for robustness.
    const mcpDisconnect =
      (method === "POST" && url.match(/^\/mcp\/([^/]+)\/disconnect$/)) ||
      (method === "DELETE" && url.match(/^\/mcp\/([^/]+)$/));
    if (mcpDisconnect) {
      const name = decodeURIComponent(mcpDisconnect[1]);
      mcpServers.delete(name);
      void mcpClients
        .get(name)
        ?.client.close()
        .catch(() => {});
      mcpClients.delete(name);
      return json(res, 200, { ok: true });
    }
    // Connect ack.
    if (method === "POST" && /^\/mcp\/[^/]+\/connect$/.test(url)) {
      return json(res, 200, { ok: true });
    }

    // Session create.
    if (url === "/session" && method === "POST") {
      const id = "ses_stub_" + randomUUID().slice(0, 8);
      sessions.add(id);
      return json(res, 200, { id });
    }

    // Session get / messages / message(prompt) / abort.
    const sessionMatch = url.match(/^\/session\/([^/]+)(\/.*)?$/);
    if (sessionMatch) {
      const sessionID = sessionMatch[1];
      const sub = sessionMatch[2] ?? "";

      if (sub === "" && method === "GET") {
        return json(res, sessions.has(sessionID) ? 200 : 404, {
          id: sessionID,
        });
      }
      if (sub === "/abort" && method === "POST") {
        return json(res, 200, { ok: true });
      }
      if (sub === "/message" && method === "GET") {
        return json(res, 200, lastAssistant ? [lastAssistant] : []);
      }
      if (
        (sub === "/prompt_async" || sub === "/message" || sub === "/prompt") &&
        method === "POST"
      ) {
        // promptAsync — ack immediately, then run the scripted turn async.
        sessions.add(sessionID);
        json(res, 200, { ok: true });
        void runTurn(sessionID);
        return;
      }
    }

    // Default OK so unknown probes don't break the SDK.
    return json(res, 200, {});
  });

  const boundPort = await new Promise<number>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });

  return {
    port: boundPort,
    setTurn: (turn) => {
      currentTurn = turn;
      lastAssistant = null;
    },
    mcpRegistrations: () => [...mcpServers.keys()],
    stop: async () => {
      for (const { client, transport } of mcpClients.values()) {
        try {
          await client.close();
        } catch {
          /* ignore */
        }
        try {
          await transport.close();
        } catch {
          /* ignore */
        }
      }
      mcpClients.clear();
      for (const res of sseClients) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
