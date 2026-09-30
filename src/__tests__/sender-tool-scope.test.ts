/**
 * Tool scope is decided per sender, not per chat.
 *
 * What would reveal a regression:
 *   - a non-operator in an allowed group getting the operator's tools
 *     (shell, devices, cross-chat reads) because the chat is allowed;
 *   - a hub session opened during an operator turn still serving the full
 *     surface to a later guest turn in the same chat;
 *   - a guest naming another chat's id and reaching it;
 *   - a credential-bearing tool result landing in a shared chat;
 *   - a batch that mixes senders riding on the operator's scope;
 *   - a group admitted only because the admin is a member once
 *     `allowedGroups` is configured;
 *   - a guest turn reaching a backend that keeps its own shell tools.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Bot, Context } from "grammy";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  enterTurnScope,
  initGuestDmScope,
  isGuestTurn,
  LOCAL_OPERATOR_SENDER,
  resolveTurnScope,
  GUEST_SCOPE_NOTICE,
  scopePrompt,
} from "../core/mcp-hub/guest-scope.js";
import { buildTalonToolServer } from "../core/mcp-hub/talon-server.js";
import { setAccessControl } from "../frontend/telegram/handlers/access.js";
import { isAccessAllowed } from "../frontend/telegram/handlers/access.js";
import { setAllowedGroups } from "../frontend/telegram/handlers/group-access.js";
import { batchSenderKeys } from "../frontend/telegram/handlers/queue.js";

const ADMIN = 424242420;
const STRANGER = 777;
const GROUP = "-1009876543210";

beforeEach(() => {
  initGuestDmScope({ operatorChats: ["wa_dm_353000000001"] }, ADMIN, [
    "discord:42",
  ]);
});

describe("resolveTurnScope", () => {
  const msg = (senderKeys: string[] | undefined, isGroup = true) => ({
    chatId: GROUP,
    isGroup,
    source: "message" as const,
    senderKeys,
  });

  it("gives the operator the full scope in a group", () => {
    expect(resolveTurnScope(msg([String(ADMIN)]))).toBe("operator");
  });

  it("guest-scopes every other sender in the same group", () => {
    expect(resolveTurnScope(msg([String(STRANGER)]))).toBe("guest");
  });

  it("guest-scopes a turn whose sender is unknown or mixed", () => {
    expect(resolveTurnScope(msg(undefined))).toBe("guest");
    expect(resolveTurnScope(msg([]))).toBe("guest");
  });

  it("matches operators across frontends by sender key", () => {
    expect(resolveTurnScope(msg(["wa_dm_353000000001"]))).toBe("operator");
    expect(resolveTurnScope(msg(["discord:42"]))).toBe("operator");
    expect(resolveTurnScope(msg(["discord:43"]))).toBe("guest");
    expect(resolveTurnScope(msg([LOCAL_OPERATOR_SENDER]))).toBe("operator");
  });

  it("guest-scopes non-operator DMs, keeps the operator's DM", () => {
    expect(
      resolveTurnScope({
        chatId: String(STRANGER),
        isGroup: false,
        source: "message",
        senderKeys: [String(STRANGER)],
      }),
    ).toBe("guest");
    expect(
      resolveTurnScope({
        chatId: String(ADMIN),
        isGroup: false,
        source: "message",
        senderKeys: [String(ADMIN)],
      }),
    ).toBe("operator");
  });

  it("honours the explicit DM opt-out, never for groups", () => {
    initGuestDmScope({ enabled: false }, ADMIN);
    const dm = {
      chatId: String(STRANGER),
      isGroup: false,
      source: "message" as const,
      senderKeys: [String(STRANGER)],
    };
    expect(resolveTurnScope(dm)).toBe("operator");
    expect(resolveTurnScope({ ...dm, chatId: GROUP, isGroup: true })).toBe(
      "guest",
    );
  });

  it("guest-scopes group pulse, keeps operator-created background work", () => {
    const bg = { chatId: GROUP, isGroup: true, senderKeys: undefined };
    expect(resolveTurnScope({ ...bg, source: "pulse" })).toBe("guest");
    expect(resolveTurnScope({ ...bg, source: "cron" })).toBe("operator");
    expect(resolveTurnScope({ ...bg, source: "trigger" })).toBe("operator");
  });
});

describe("operatorGroups", () => {
  const inGroup = (operatorInChat: boolean | undefined) => ({
    chatId: GROUP,
    isGroup: true,
    source: "message" as const,
    senderKeys: [String(STRANGER)],
    operatorInChat,
  });

  it("stays off by default — membership alone changes nothing", () => {
    expect(resolveTurnScope(inGroup(true))).toBe("guest");
  });

  it("gives every member the full scope in a group the operator is in", () => {
    initGuestDmScope({ operatorGroups: true }, ADMIN);
    expect(resolveTurnScope(inGroup(true))).toBe("operator");
    expect(resolveTurnScope({ ...inGroup(true), senderKeys: [] })).toBe(
      "operator",
    );
    expect(resolveTurnScope({ ...inGroup(true), source: "pulse" })).toBe(
      "operator",
    );
  });

  it("keeps guest scope where the operator is absent or unverified", () => {
    initGuestDmScope({ operatorGroups: true }, ADMIN);
    expect(resolveTurnScope(inGroup(false))).toBe("guest");
    expect(resolveTurnScope(inGroup(undefined))).toBe("guest");
  });

  it("never applies to DMs", () => {
    initGuestDmScope({ operatorGroups: true }, ADMIN);
    expect(
      resolveTurnScope({
        ...inGroup(true),
        chatId: String(STRANGER),
        isGroup: false,
      }),
    ).toBe("guest");
  });
});

describe("turn scope bracket", () => {
  it("marks the chat only while the turn runs", () => {
    const release = enterTurnScope(GROUP, "guest");
    expect(isGuestTurn(GROUP)).toBe(true);
    expect(isGuestTurn(String(ADMIN))).toBe(false);
    release();
    expect(isGuestTurn(GROUP)).toBe(false);
  });

  it("a stale release does not clear a newer turn's mark", () => {
    const first = enterTurnScope(GROUP, "operator");
    const second = enterTurnScope(GROUP, "guest");
    first();
    expect(isGuestTurn(GROUP)).toBe(true);
    second();
  });
});

describe("scope notice", () => {
  it("tells a guest turn its tools are withheld on purpose", () => {
    expect(scopePrompt("guest", "hi")).toBe(`${GUEST_SCOPE_NOTICE}\n\nhi`);
  });

  it("leaves an operator turn's prompt untouched", () => {
    expect(scopePrompt("operator", "hi")).toBe("hi");
  });
});

// ── Hub enforcement ─────────────────────────────────────────────────────────

type Fetched = { action: string; body: Record<string, unknown> };

function stubBridge(result: (action: string) => unknown): Fetched[] {
  const calls: Fetched[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push({ action: String(body.action), body });
      return new Response(JSON.stringify(result(String(body.action))), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

async function hubClient(chatId: string, guest = false) {
  const server = buildTalonToolServer({
    frontend: "telegram",
    chatId,
    bridgeUrl: "http://127.0.0.1:1",
    includeNativeTools: true,
    guest,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function textOf(res: unknown): string {
  return (res as { content: { text: string }[] }).content[0].text;
}

describe("hub enforces the live turn scope", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses operator tools to a guest turn on a session opened by an operator turn", async () => {
    const calls = stubBridge(() => ({ ok: true, text: "ran" }));
    const client = await hubClient(GROUP); // built with the full surface
    const release = enterTurnScope(GROUP, "guest");
    try {
      const attempts: [string, Record<string, unknown>][] = [
        ["bash", { command: "id" }],
        ["device_exec", { cmd: "id" }],
        ["forward_message", { message_id: "5", from_chat_id: String(ADMIN) }],
      ];
      for (const [name, args] of attempts) {
        const res = await client.callTool({ name, arguments: args });
        expect(textOf(res)).toMatch(/Not available in this chat/);
        expect(res.isError).toBe(true);
      }
      expect(calls).toEqual([]);
    } finally {
      release();
    }
  });

  it("lets the operator's turn in the same group use them", async () => {
    const calls = stubBridge(() => ({ ok: true, text: "sent" }));
    const client = await hubClient(GROUP);
    const release = enterTurnScope(GROUP, "operator");
    try {
      const res = await client.callTool({
        name: "send",
        arguments: { type: "text", text: "hi", chat_id: String(ADMIN) },
      });
      expect(textOf(res)).toBe("sent");
      expect(calls[0].body._chatId).toBe(String(ADMIN));
    } finally {
      release();
    }
  });

  it("keeps a guest to its own chat when it names another one", async () => {
    const calls = stubBridge(() => ({ ok: true, text: "sent" }));
    const client = await hubClient(GROUP);
    const release = enterTurnScope(GROUP, "guest");
    try {
      const other = await client.callTool({
        name: "send",
        arguments: { type: "text", text: "hi", chat_id: String(ADMIN) },
      });
      expect(textOf(other)).toMatch(/chat_id must be this chat/);
      expect(calls).toEqual([]);
      const own = await client.callTool({
        name: "send",
        arguments: { type: "text", text: "hi" },
      });
      expect(textOf(own)).toBe("sent");
      expect(calls[0].body._chatId).toBe(GROUP);
    } finally {
      release();
    }
  });
});

describe("credential-bearing tools", () => {
  const SECRET = "curl -H 'Authorization: Bearer s3cr3t' https://bridge/i/abc";
  const args = { os: "linux", arch: "amd64" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuse a guest turn without reaching the bridge", async () => {
    const calls = stubBridge(() => ({ ok: true, text: SECRET }));
    const client = await hubClient(GROUP);
    const release = enterTurnScope(GROUP, "guest");
    try {
      const res = await client.callTool({
        name: "make_node_install_link",
        arguments: args,
      });
      expect(textOf(res)).not.toContain("s3cr3t");
      expect(calls).toEqual([]);
    } finally {
      release();
    }
  });

  it("deliver to the operator's DM, never into the group", async () => {
    const calls = stubBridge((action) =>
      action === "make_node_install_link"
        ? { ok: true, text: SECRET }
        : { ok: true },
    );
    const client = await hubClient(GROUP);
    const release = enterTurnScope(GROUP, "operator");
    try {
      const res = await client.callTool({
        name: "make_node_install_link",
        arguments: args,
      });
      expect(textOf(res)).not.toContain("s3cr3t");
      expect(textOf(res)).toMatch(/private chat/);
      const sends = calls.filter((c) => c.action === "send_message");
      expect(sends).toHaveLength(1);
      expect(sends[0].body._chatId).toBe(String(ADMIN));
      expect(sends[0].body.text).toBe(SECRET);
      expect(calls.some((c) => c.body._chatId === GROUP && c.body.text)).toBe(
        false,
      );
    } finally {
      release();
    }
  });

  it("show the result directly in the operator's own DM", async () => {
    const calls = stubBridge(() => ({ ok: true, text: SECRET }));
    const client = await hubClient(String(ADMIN));
    const release = enterTurnScope(String(ADMIN), "operator");
    try {
      const res = await client.callTool({
        name: "make_node_install_link",
        arguments: args,
      });
      expect(textOf(res)).toBe(SECRET);
      expect(calls.map((c) => c.action)).toEqual(["make_node_install_link"]);
    } finally {
      release();
    }
  });

  it("refuse outside a private chat when no operator DM is configured", async () => {
    initGuestDmScope(undefined, undefined, ["discord:42"]);
    const calls = stubBridge(() => ({ ok: true, text: SECRET }));
    const client = await hubClient(GROUP);
    const res = await client.callTool({
      name: "make_node_install_link",
      arguments: args,
    });
    expect(textOf(res)).toMatch(/operator's private chat/);
    expect(calls).toEqual([]);
  });

  it("treat make_companion_pair_link the same way: refused for guests, DM-only for the operator", async () => {
    const PAIR =
      "https://bridge/pair?grant=g  Token: tdc1.0123456789abcdef.s3cr3t";
    const calls = stubBridge((action) =>
      action === "make_companion_pair_link"
        ? { ok: true, text: PAIR }
        : { ok: true },
    );
    const client = await hubClient(GROUP);
    let release = enterTurnScope(GROUP, "guest");
    try {
      const res = await client.callTool({
        name: "make_companion_pair_link",
        arguments: {},
      });
      expect(textOf(res)).not.toContain("s3cr3t");
      expect(calls).toEqual([]);
    } finally {
      release();
    }
    release = enterTurnScope(GROUP, "operator");
    try {
      const res = await client.callTool({
        name: "make_companion_pair_link",
        arguments: {},
      });
      expect(textOf(res)).not.toContain("s3cr3t");
      const sends = calls.filter((c) => c.action === "send_message");
      expect(sends).toHaveLength(1);
      expect(sends[0].body._chatId).toBe(String(ADMIN));
      expect(sends[0].body.text).toBe(PAIR);
    } finally {
      release();
    }
  });
});

// ── Telegram: group allowlist + batching ────────────────────────────────────

function groupCtx(chatId: number, fromId: number): Context {
  return {
    chat: { id: chatId, type: "supergroup", title: "G" },
    from: { id: fromId, first_name: "T" },
    message: { message_id: 1, text: "hi" },
  } as unknown as Context;
}

function memberBot(): Bot {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getChatMember: vi.fn().mockResolvedValue({ status: "member" }),
    },
  } as unknown as Bot;
}

describe("telegram group access", () => {
  beforeEach(() => {
    setAccessControl({ allowedUsers: [ADMIN], adminUserId: ADMIN });
  });
  afterEach(() => {
    setAllowedGroups(undefined);
  });

  it("denies an unlisted group even when the admin is a member", async () => {
    setAllowedGroups([-100111]);
    const bot = memberBot();
    expect(await isAccessAllowed(groupCtx(-100222, STRANGER), bot)).toBe(false);
    expect(bot.api.getChatMember).not.toHaveBeenCalled();
  });

  it("serves a listed group", async () => {
    setAllowedGroups([-100111]);
    expect(
      await isAccessAllowed(groupCtx(-100111, STRANGER), memberBot()),
    ).toBe(true);
  });

  it("keeps legacy membership-only groups working when allowedGroups is unset", async () => {
    setAllowedGroups(undefined);
    expect(
      await isAccessAllowed(groupCtx(-100333, STRANGER), memberBot()),
    ).toBe(true);
  });
});

describe("telegram batching", () => {
  it("keeps the sender for a single-sender batch", () => {
    expect(batchSenderKeys([{ senderId: ADMIN }, { senderId: ADMIN }])).toEqual(
      [String(ADMIN)],
    );
  });

  it("drops the sender when a batch mixes people", () => {
    expect(
      batchSenderKeys([{ senderId: STRANGER }, { senderId: ADMIN }]),
    ).toEqual([]);
    expect(
      resolveTurnScope({
        chatId: GROUP,
        isGroup: true,
        source: "message",
        senderKeys: batchSenderKeys([
          { senderId: STRANGER },
          { senderId: ADMIN },
        ]),
      }),
    ).toBe("guest");
  });
});
