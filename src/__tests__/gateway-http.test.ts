import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../core/plugin/index.js", () => ({
  handlePluginAction: vi.fn(async () => null),
}));

vi.mock("../util/watchdog.js", () => ({
  getHealthStatus: vi.fn(() => ({
    healthy: true,
    totalMessagesProcessed: 0,
    recentErrorCount: 0,
    msSinceLastMessage: 0,
  })),
}));

vi.mock("../storage/sessions.js", () => ({
  getActiveSessionCount: vi.fn(() => 0),
}));

vi.mock("../core/engine/dispatcher.js", () => ({
  getActiveCount: vi.fn(() => 0),
}));

// Mock cron-store for shared actions
vi.mock("../storage/cron.js", () => ({
  addCronJob: vi.fn(),
  getCronJob: vi.fn(),
  getCronJobsForChat: vi.fn(() => []),
  updateCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  validateCronExpression: vi.fn(() => ({
    valid: true,
    next: new Date().toISOString(),
  })),
  generateCronId: vi.fn(() => "test-id"),
  loadCronJobs: vi.fn(),
}));

const accountsAdmin = vi.hoisted(() => ({
  listClaudeAccountsWithStatus: vi.fn(async () => [
    { id: "claude", label: "Claude", status: "signed in" },
  ]),
  addClaudeAccount: vi.fn(async (req: { name?: string }) => ({
    ok: true,
    account: { id: `claude-${req.name ?? "2"}` },
  })),
  removeClaudeAccount: vi.fn(async () => ({ ok: true, chatsMoved: 0 })),
}));
vi.mock("../core/auth/claude-accounts-admin.js", () => accountsAdmin);

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

import { Gateway } from "../core/engine/gateway.js";
import { bus } from "../core/bus/index.js";
import { taskTable } from "../core/tasks/index.js";
import { gatewayFetch } from "./helpers/gateway-fetch.js";

let gateway: Gateway;
let port: number;

// Mock frontend handler
const mockFrontendHandler = vi.fn(async (body: Record<string, unknown>) => {
  const action = body.action as string;
  if (action === "send_message")
    return { ok: true, message_id: 42, text: "sent" };
  if (action === "get_chat_info") return { ok: true, id: 123, type: "private" };
  return null;
});

beforeAll(async () => {
  gateway = new Gateway();
  gateway.setFrontendHandler(mockFrontendHandler);
  port = await gateway.start(19899); // test port
});

afterAll(async () => {
  await gateway.stop();
});

beforeEach(() => {
  // Clear contexts for known test chatIds
  for (const id of [123, 999]) {
    gateway.clearContext(id);
    gateway.clearContext(id);
  }
  mockFrontendHandler.mockClear();
});

async function post(
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await gatewayFetch(`http://127.0.0.1:${port}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: resp.status,
    body: (await resp.json()) as Record<string, unknown>,
  };
}

describe("gateway HTTP server", () => {
  describe("health endpoint", () => {
    it("returns health JSON", async () => {
      const resp = await gatewayFetch(`http://127.0.0.1:${port}/health`);
      expect(resp.status).toBe(200);
      const data = (await resp.json()) as Record<string, unknown>;
      expect(data.ok).toBeDefined();
      expect(data.uptime).toBeDefined();
      expect(data.memory).toBeDefined();
    });
  });

  describe("task endpoints", () => {
    it("GET /tasks lists the task table", async () => {
      const task = taskTable.begin({ kind: "heartbeat", label: "#1" });
      try {
        const resp = await gatewayFetch(`http://127.0.0.1:${port}/tasks`);
        expect(resp.status).toBe(200);
        const data = (await resp.json()) as {
          ok: boolean;
          tasks: Array<Record<string, unknown>>;
        };
        expect(data.ok).toBe(true);
        expect(data.tasks.find((t) => t.id === task.id)).toMatchObject({
          kind: "heartbeat",
          state: "running",
        });
      } finally {
        task.succeed();
      }
    });

    it("POST /tasks/kill aborts a killable task", async () => {
      const abort = vi.fn();
      const task = taskTable.begin({ kind: "dream", label: "test", abort });
      try {
        const resp = await gatewayFetch(`http://127.0.0.1:${port}/tasks/kill`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: task.id }),
        });
        expect(resp.status).toBe(200);
        expect(await resp.json()).toEqual({ ok: true });
        expect(abort).toHaveBeenCalledTimes(1);
      } finally {
        task.fail(new Error("aborted"));
      }
    });

    it("POST /tasks/kill reports unknown ids", async () => {
      const resp = await gatewayFetch(`http://127.0.0.1:${port}/tasks/kill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: 999_999 }),
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ ok: false, reason: "not-found" });
    });

    it("POST /tasks/kill rejects malformed bodies", async () => {
      const invalidJson = await gatewayFetch(
        `http://127.0.0.1:${port}/tasks/kill`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not json{{{",
        },
      );
      expect(invalidJson.status).toBe(400);

      const nonIntegerId = await gatewayFetch(
        `http://127.0.0.1:${port}/tasks/kill`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: "7" }),
        },
      );
      expect(nonIntegerId.status).toBe(400);
    });
  });

  describe("claude accounts", () => {
    const post = (path: string, body: string) =>
      gatewayFetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

    it("GET /claude-accounts lists every account with its status", async () => {
      const resp = await gatewayFetch(
        `http://127.0.0.1:${port}/claude-accounts`,
      );
      expect(await resp.json()).toEqual({
        ok: true,
        accounts: [{ id: "claude", label: "Claude", status: "signed in" }],
      });
    });

    it("POST /claude-accounts/add passes the name through", async () => {
      const resp = await post("/claude-accounts/add", '{"name":"work"}');
      expect(await resp.json()).toEqual({
        ok: true,
        account: { id: "claude-work" },
      });
      expect(accountsAdmin.addClaudeAccount).toHaveBeenLastCalledWith({
        name: "work",
        label: undefined,
      });
    });

    it("POST /claude-accounts/remove deletes credentials unless told not to", async () => {
      await post("/claude-accounts/remove", '{"id":"claude-2"}');
      expect(accountsAdmin.removeClaudeAccount).toHaveBeenLastCalledWith(
        "claude-2",
        { deleteCredentials: true },
      );
      await post(
        "/claude-accounts/remove",
        '{"id":"claude-2","deleteCredentials":false}',
      );
      expect(accountsAdmin.removeClaudeAccount).toHaveBeenLastCalledWith(
        "claude-2",
        { deleteCredentials: false },
      );
    });

    it("rejects malformed bodies", async () => {
      expect((await post("/claude-accounts/add", "nope{")).status).toBe(400);
      expect((await post("/claude-accounts/add", "[1]")).status).toBe(400);
      expect((await post("/claude-accounts/remove", "{}")).status).toBe(400);
    });
  });

  describe("event bus tail", () => {
    it("GET /events/recent returns the ring, honouring the since cursor", async () => {
      const published = bus.publish({
        type: "turn.completed",
        chatId: "tail-test",
        source: "message",
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
      });

      const all = await gatewayFetch(`http://127.0.0.1:${port}/events/recent`);
      expect(all.status).toBe(200);
      const allBody = (await all.json()) as {
        ok: boolean;
        events: Array<{ id: number; type: string }>;
      };
      expect(allBody.ok).toBe(true);
      expect(allBody.events.some((e) => e.id === published.id)).toBe(true);

      const after = await gatewayFetch(
        `http://127.0.0.1:${port}/events/recent?since=${published.id}`,
      );
      const afterBody = (await after.json()) as {
        events: Array<{ id: number }>;
      };
      expect(afterBody.events.every((e) => e.id > published.id)).toBe(true);
    });
  });

  describe("404 handling", () => {
    it("returns 404 for unknown paths", async () => {
      const resp = await gatewayFetch(`http://127.0.0.1:${port}/nonexistent`);
      expect(resp.status).toBe(404);
    });

    it("returns 404 for GET /action", async () => {
      const resp = await gatewayFetch(`http://127.0.0.1:${port}/action`);
      expect(resp.status).toBe(404);
    });
  });

  describe("malformed requests", () => {
    it("returns 400 for invalid JSON", async () => {
      const resp = await gatewayFetch(`http://127.0.0.1:${port}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json{{{",
      });
      expect(resp.status).toBe(400);
      const data = (await resp.json()) as Record<string, unknown>;
      expect(data.ok).toBe(false);
      expect(data.error).toContain("Invalid JSON");
    });
  });

  describe("action routing", () => {
    it("returns error when no active context", async () => {
      const { body } = await post({ action: "send_message", text: "hi" });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No active chat context");
    });

    it("routes to shared actions (cron)", async () => {
      gateway.setContext(123);
      const { body } = await post({ action: "list_cron_jobs", _chatId: "123" });
      expect(body.ok).toBe(true);
      gateway.clearContext(123);
    });

    it("routes to frontend handler", async () => {
      gateway.setContext(123);
      const { body } = await post({
        action: "send_message",
        _chatId: "123",
        text: "hello",
      });
      expect(body.ok).toBe(true);
      expect(body.message_id).toBe(42);
      expect(mockFrontendHandler).toHaveBeenCalled();
      gateway.clearContext(123);
    });

    it("returns error for unknown action", async () => {
      gateway.setContext(123);
      const { body } = await post({
        action: "completely_unknown_action",
        _chatId: "123",
      });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Unknown action");
      gateway.clearContext(123);
    });

    it("returns error for missing action field", async () => {
      gateway.setContext(123);
      const { body } = await post({ _chatId: "123", text: "no action" });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Missing action");
      gateway.clearContext(123);
    });

    it("rejects unknown chatId (no active context)", async () => {
      const { body } = await post({ action: "send_message", _chatId: "999" });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No active chat context");
    });

    // Regression: the mesh is the only command channel a heartbeat run has to
    // a remote box, and its handlers ignore chatId entirely — so they must not
    // be gated behind an active chat context the way send_message is.
    it("serves mesh actions with no chat context at all", async () => {
      const { body } = await post({ action: "list_devices" });
      expect(body.error).not.toBe("No active chat context");
      expect(body.ok).toBe(true);
    });

    it("serves mesh actions when _chatId is the heartbeat sentinel", async () => {
      const { body } = await post({
        action: "list_devices",
        _chatId: "heartbeat",
      });
      expect(body.error).not.toBe("No active chat context");
      expect(body.ok).toBe(true);
    });

    // The bypass is scoped: a non-mesh action still needs a chat.
    it("still requires a chat context for non-mesh actions", async () => {
      const { body } = await post({
        action: "list_cron_jobs",
        _chatId: "heartbeat",
      });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No active chat context");
    });
  });

  describe("concurrent chat contexts via HTTP", () => {
    it("handles two chats simultaneously", async () => {
      gateway.setContext(100);
      gateway.setContext(200);

      const [r1, r2] = await Promise.all([
        post({ action: "send_message", _chatId: "100", text: "from chat 100" }),
        post({ action: "send_message", _chatId: "200", text: "from chat 200" }),
      ]);

      expect(r1.body.ok).toBe(true);
      expect(r2.body.ok).toBe(true);
      expect(mockFrontendHandler).toHaveBeenCalledTimes(2);

      gateway.clearContext(100);
      gateway.clearContext(200);
    });

    it("one chat's context doesn't affect another", async () => {
      gateway.setContext(300);
      // Chat 400 has no context
      const { body } = await post({
        action: "send_message",
        _chatId: "400",
        text: "no context",
      });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No active chat context");
      // Chat 300 still works
      const r2 = await post({
        action: "send_message",
        _chatId: "300",
        text: "still works",
      });
      expect(r2.body.ok).toBe(true);
      gateway.clearContext(300);
    });

    it("frontend handler error returns error result (doesn't crash server)", async () => {
      const errorHandler = vi.fn(async () => {
        throw new Error("handler exploded");
      });
      gateway.setFrontendHandler(errorHandler);
      gateway.setContext(123);

      const { status, body } = await post({
        action: "send_message",
        _chatId: "123",
        text: "boom",
      });

      expect(status).toBe(200); // HTTP 200, error in body
      expect(body.ok).toBe(false);
      expect(body.error).toContain("handler exploded");

      gateway.clearContext(123);
      gateway.setFrontendHandler(mockFrontendHandler); // restore
    });

    it("request without _chatId is rejected", async () => {
      gateway.setContext(123);
      const { body } = await post({
        action: "send_message",
        text: "no chatId",
      });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No active chat context");
      gateway.clearContext(123);
    });
  });

  // ── Heartbeat outbound: explicit chat_id routing ───────────────────────
  //
  // When the bridge promotes a tool's explicit `chat_id` param into both
  // `_chatId` (the routing key) AND keeps `chat_id` in the body (the
  // explicit-routing signal), the gateway should route to that chat
  // WITHOUT requiring an active context. This is what enables heartbeat
  // agents to send proactive messages to chats they're not in a live
  // session with.

  describe("explicit chat_id routing (heartbeat outbound)", () => {
    it("accepts numeric chat_id without an active context", async () => {
      // No setContext for chat 7777 — heartbeat-style outbound.
      const { body } = await post({
        action: "send_message",
        _chatId: "7777",
        chat_id: 7777,
        text: "hello from heartbeat",
      });
      expect(body.ok).toBe(true);
      expect(mockFrontendHandler).toHaveBeenCalledWith(
        expect.objectContaining({ action: "send_message", chat_id: 7777 }),
        7777,
      );
    });

    it("still rejects when chat_id is absent AND no active context (chat-mode safety)", async () => {
      // Without explicit chat_id and without an active context, the
      // legacy guard kicks in to catch chat-mode misconfigurations.
      const { body } = await post({
        action: "send_message",
        _chatId: "8888",
        text: "no chat_id, no context",
      });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No active chat context");
    });

    it("explicit chat_id rejected when not numeric (defensive)", async () => {
      // Defensive: a non-numeric explicit chat_id should fall through to
      // the string-id lookup, which fails without a matching context.
      const { body } = await post({
        action: "send_message",
        _chatId: "not-a-number",
        chat_id: "not-a-number",
        text: "garbage chat_id",
      });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No active chat context");
    });

    it("returns 500 when handleAction result cannot be JSON-serialized", async () => {
      // Make frontendHandler return a circular reference so JSON.stringify throws
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;
      const circularHandler = vi.fn(
        async () => circular,
      ) as unknown as import("../core/types.js").FrontendActionHandler;
      gateway.setFrontendHandler(circularHandler);
      gateway.setContext(123);

      const { status, body } = await post({
        action: "send_message",
        _chatId: "123",
        text: "boom",
      });

      expect(status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.error).toBeTruthy();

      gateway.clearContext(123);
      gateway.setFrontendHandler(mockFrontendHandler); // restore
    });

    // ── Heartbeat outbound: edge cases ─────────────────────────────────

    it("accepts NEGATIVE chat_id (Telegram supergroup) without active context", async () => {
      // Telegram supergroups use -100<id> as their chat ID. These are
      // legitimate routing targets and must not be rejected by the
      // gateway's falsy guard or by sign-handling.
      const { body } = await post({
        action: "send_message",
        _chatId: "-1009876543210",
        chat_id: -1009876543210,
        text: "hello supergroup",
      });
      expect(body.ok).toBe(true);
      expect(mockFrontendHandler).toHaveBeenCalledWith(
        expect.objectContaining({ chat_id: -1009876543210 }),
        -1009876543210,
      );
    });

    it("accepts chat_id=0 without conflating it with no context", async () => {
      // Number("0") = 0, which is falsy but still a resolved number.
      // The gateway's null guard keeps the number/null contract honest.
      const { body } = await post({
        action: "send_message",
        _chatId: "0",
        chat_id: 0,
        text: "to zero",
      });
      expect(body.ok).toBe(true);
      expect(mockFrontendHandler).toHaveBeenCalledWith(
        expect.objectContaining({ chat_id: 0 }),
        0,
      );
    });

    it("rejects the heartbeat sentinel even when chat_id property is present", async () => {
      // The explicit-routing branch has an extra guard:
      // `rawChatId !== "heartbeat"`. So if a heartbeat-tier MCP server
      // ships a request with _chatId still set to the sentinel, we don't
      // accidentally route to a numeric NaN. Instead we fall through to
      // the string-id lookup, which fails without context.
      const { body } = await post({
        action: "send_message",
        _chatId: "heartbeat",
        chat_id: "heartbeat",
        text: "should never route",
      });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No active chat context");
    });

    it("preserves negative chat_id sign through routing (no abs/truncation)", async () => {
      // Defensive: ensure -100<id> isn't accidentally getting Math.abs'd
      // or truncated. The handler receives the negative ID verbatim.
      const { body } = await post({
        action: "send_message",
        _chatId: "-1001234567890",
        chat_id: -1001234567890,
        text: "sign-preserve",
      });
      expect(body.ok).toBe(true);
      expect(mockFrontendHandler).toHaveBeenLastCalledWith(
        expect.objectContaining({ chat_id: -1001234567890 }),
        -1001234567890,
      );
    });

    it("explicit chat_id with active context for SAME id still routes (no exception)", async () => {
      // Defensive coexistence: when a chat has an active context AND the
      // request carries an explicit chat_id matching that context, the
      // explicit-routing branch takes precedence (no exception thrown,
      // no double-dispatch).
      gateway.setContext(7777);
      try {
        const { body } = await post({
          action: "send_message",
          _chatId: "7777",
          chat_id: 7777,
          text: "both signal active",
        });
        expect(body.ok).toBe(true);
        expect(mockFrontendHandler).toHaveBeenCalledTimes(1);
      } finally {
        gateway.clearContext(7777);
      }
    });
  });

  describe("shared actions via HTTP", () => {
    it("fetch_url rejects invalid URLs", async () => {
      gateway.setContext(123);
      const { body } = await post({
        action: "fetch_url",
        _chatId: "123",
        url: "not-a-url",
      });
      expect(body.ok).toBe(false);
      gateway.clearContext(123);
    });

    it("read_history returns ok", async () => {
      gateway.setContext(123);
      const { body } = await post({ action: "read_history", _chatId: "123" });
      expect(body.ok).toBe(true);
      gateway.clearContext(123);
    });

    it("create_cron_job works", async () => {
      gateway.setContext(123);
      const { body } = await post({
        action: "create_cron_job",
        _chatId: "123",
        name: "test",
        schedule: "0 9 * * *",
        type: "message",
        content: "hello",
      });
      expect(body.ok).toBe(true);
      gateway.clearContext(123);
    });
  });
});

// ── Plugin action route coverage ─────────────────────────────────────────────

describe("gateway routes to plugin handler", () => {
  it("returns plugin result when handlePluginAction returns non-null", async () => {
    const { handlePluginAction } = await import("../core/plugin/index.js");
    (handlePluginAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      result: "from plugin",
    });

    gateway.setContext(123);
    const { body } = await post({
      action: "plugin_specific_action",
      _chatId: "123",
    });
    expect(body.ok).toBe(true);
    expect(body.result).toBe("from plugin");
    gateway.clearContext(123);

    // Restore to always-null for subsequent tests
    (handlePluginAction as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });
});

// ── Additional branch coverage ────────────────────────────────────────────

describe("gateway — no frontend handler falls through to shared actions (line 162 FALSE branch)", () => {
  it("routes to shared action when frontendHandler is null", async () => {
    // Clear frontend handler — FALSE branch of `if (this.frontendHandler)`
    gateway.setFrontendHandler(null);
    gateway.setContext(123);

    // read_history is a shared action that should still work
    const { body } = await post({ action: "read_history", _chatId: "123" });
    expect(body.ok).toBe(true);

    gateway.clearContext(123);
    gateway.setFrontendHandler(mockFrontendHandler); // restore
  });
});

describe("gateway — non-Error thrown in handleAction catch (line 186 FALSE branch)", () => {
  it("returns error with String(err) when handler throws a non-Error", async () => {
    const stringThrowHandler = vi.fn(async () => {
      throw "plain string gateway error";
    });
    gateway.setFrontendHandler(stringThrowHandler);
    gateway.setContext(123);

    const { body } = await post({
      action: "send_message",
      _chatId: "123",
      text: "test",
    });
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("plain string gateway error");

    gateway.clearContext(123);
    gateway.setFrontendHandler(mockFrontendHandler); // restore
  });
});

describe("gateway — start() called twice returns same port (line 195 TRUE branch)", () => {
  it("returns port without restarting when already running", async () => {
    // gateway is already started — calling start() again should return same port immediately
    const secondPort = await gateway.start();
    expect(secondPort).toBe(port);
  });
});

describe("gateway health endpoint — old activity shows minutes ago (line 211 FALSE branch)", () => {
  it("shows 'Xm ago' when msSinceLastMessage >= 60000", async () => {
    const { getHealthStatus } = await import("../util/watchdog.js");
    (getHealthStatus as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      healthy: true,
      totalMessagesProcessed: 5,
      recentErrorCount: 0,
      msSinceLastMessage: 5 * 60_000, // 5 minutes ago → > 60000
    });

    const resp = await gatewayFetch(`http://127.0.0.1:${port}/health`);
    const data = (await resp.json()) as Record<string, unknown>;
    expect(data.lastActivity).toMatch(/m ago$/);
  });
});

// ── Port retry (EADDRINUSE) ───────────────────────────────────────────────

describe("gateway port retry — EADDRINUSE", () => {
  it("rejects when all retry attempts are exhausted (6 consecutive ports in use)", async () => {
    // The retry logic allows attempt 0-4 (5 retries), trying ports p, p+1, …, p+5
    // Block all 6 consecutive ports so every attempt fails → should reject
    const blockers: Array<import("node:http").Server> = [];
    for (let p = 19950; p <= 19955; p++) {
      const { createServer } = await import("node:http");
      const s = createServer();
      await new Promise<void>((resolve) => s.listen(p, "127.0.0.1", resolve));
      blockers.push(s);
    }

    try {
      const gw = new Gateway();
      gw.setFrontendHandler(async () => null);
      await expect(gw.start(19950)).rejects.toThrow();
    } finally {
      for (const s of blockers) {
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
    }
  });

  it("runs the startup body exactly once after retrying past a busy port", async () => {
    // Occupy the first port so start() retries onto the next one. The stale
    // 'listening' callback from the failed bind must not also fire on the
    // successful bind, or onStarted listeners (and the startup log) run twice.
    const { createServer } = await import("node:http");
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(19960, "127.0.0.1", resolve),
    );

    const gw = new Gateway();
    gw.setFrontendHandler(async () => null);
    let startedCount = 0;
    gw.onStarted(() => {
      startedCount++;
    });

    try {
      const boundPort = await gw.start(19960);
      expect(boundPort).toBe(19961); // retried past the blocked port
      expect(startedCount).toBe(1); // startup body ran exactly once
    } finally {
      await gw.stop();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("gateway health endpoint — active alerts", () => {
  it("lists the raised alerts for an authenticated caller", async () => {
    const { raiseAlert, resetAlertsForTest } =
      await import("../core/frontend-runtime/alerts.js");
    resetAlertsForTest(async () => {});
    raiseAlert("disk.low", "Disk almost full: 800 MiB free", {
      severity: "critical",
    });
    const resp = await gatewayFetch(`http://127.0.0.1:${port}/health`);
    const data = (await resp.json()) as Record<string, unknown>;
    expect(data.alerts).toEqual([
      expect.objectContaining({
        key: "disk.low",
        severity: "critical",
        message: "Disk almost full: 800 MiB free",
      }),
    ]);
    resetAlertsForTest();
  });
});
