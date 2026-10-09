/**
 * The /auth panel's account controls: add (straight into sign-in), remove
 * behind a confirmation, and "Use in this chat" through the shared /model
 * switch. Every callback payload fits Telegram's 64 bytes. The account
 * service, the login flow and the pool are mocked; this is the Telegram
 * surface only (the service has claude-accounts-admin.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";

const admin = vi.hoisted(() => ({
  addClaudeAccount: vi.fn(),
  planClaudeAccountRemoval: vi.fn(),
  removeClaudeAccount: vi.fn(),
}));
vi.mock("../core/auth/claude-accounts-admin.js", () => admin);

const login = vi.hoisted(() => ({
  activeLoginFlow: vi.fn(() => undefined),
  startLogin: vi.fn(() => ({
    provider: "claude-2",
    prompt: Promise.resolve({
      url: "https://claude.com/oauth/authorize?x",
      needsCode: true,
    }),
    done: new Promise(() => {}),
    submitCode: vi.fn(),
    cancel: vi.fn(),
  })),
}));
vi.mock("../core/auth/login-flow.js", () => login);

const switching = vi.hoisted(() => ({
  switchChatBackend: vi.fn(async () => ({
    ok: true,
    text: "Backend: Claude (account 2) (model: default). Session kept.",
  })),
  resetChatBackend: vi.fn(async () => ({
    ok: true,
    text: "Backend reset to default (claude; model: default).",
  })),
}));
vi.mock("../frontend/presentation/model-commands.js", () => switching);

const chat = vi.hoisted(() => ({ backendId: "claude", override: false }));
vi.mock("../core/engine/backend-controller/index.js", () => ({
  hasBackendPool: () => true,
  getPoolConfig: () => ({}),
  getBackendIdForChat: () => chat.backendId,
  getBackendIdForRole: () => "claude",
  hasChatBackendOverride: () => chat.override,
  isBackendAvailable: () => true,
  listAvailableBackends: () => [
    { id: "claude", label: "Anthropic" },
    { id: "claude-2", label: "Claude (account 2)" },
    { id: "codex", label: "Codex" },
  ],
}));

const { setClaudeAccounts } = await import("../core/config/claude-accounts.js");
const { renderAuthPanel, renderRemoveConfirm } =
  await import("../frontend/telegram/auth-panel.js");
const { handleAuthCallback } =
  await import("../frontend/telegram/callbacks/auth.js");
const { registerAuthCommand } =
  await import("../frontend/telegram/commands/auth.js");
const { setAdminUserId } =
  await import("../frontend/telegram/commands/state.js");

import type { TalonConfig } from "../core/config/index.js";

const ADMIN = 111;
const config = { claudeBinary: "claude" } as TalonConfig;
const deps = { config };
const account2 = {
  id: "claude-2" as const,
  label: "Claude (account 2)",
  configDir: "/home/t/.talon/accounts/claude-2",
};

type Keyboard = { text: string; callback_data?: string; url?: string }[][];

/** A button's payload ("" for a URL button). */
const data = (b: object): string =>
  "callback_data" in b ? String(b.callback_data) : "";

type Ctx = Context & {
  reply: ReturnType<typeof vi.fn>;
  answerCallbackQuery: ReturnType<typeof vi.fn>;
  api: { editMessageText: ReturnType<typeof vi.fn> };
};

function makeCtx(from = ADMIN, match = ""): Ctx {
  return {
    chat: { id: from, type: "private" },
    from: { id: from, first_name: "T" },
    match,
    callbackQuery: { message: { message_id: 7 } },
    reply: vi.fn().mockResolvedValue({ message_id: 9 }),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    api: { editMessageText: vi.fn().mockResolvedValue(true) },
  } as unknown as Ctx;
}

function lastEdit(ctx: Ctx): { text: string; keyboard: Keyboard } {
  const call = ctx.api.editMessageText.mock.calls.at(-1);
  const opts = call?.[3] as { reply_markup?: { inline_keyboard: Keyboard } };
  return {
    text: String(call?.[2] ?? ""),
    keyboard: opts?.reply_markup?.inline_keyboard ?? [],
  };
}

const signedOut = (provider: string) =>
  ({ provider, loggedIn: false, expired: true }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  setAdminUserId(ADMIN);
  setClaudeAccounts([account2]);
  chat.backendId = "claude";
  chat.override = false;
});

describe("panel", () => {
  it("adds use/remove under each Claude row, marks this chat's row, and offers add", () => {
    const panel = renderAuthPanel(
      [signedOut("claude"), signedOut("claude-2"), signedOut("codex")],
      { backendId: "claude", selectable: ["claude", "claude-2", "codex"] },
    );
    expect(panel.text).toContain("<b>Claude</b> — not signed in · this chat");
    expect(panel.text).not.toContain("account 2)</b> — not signed in ·");
    expect(panel.keyboard.map((row) => row.map(data))).toEqual([
      ["auth:login:claude"],
      ["auth:login:claude-2"],
      ["auth:use:claude-2", "auth:rm:claude-2"],
      ["auth:login:codex"],
      ["auth:add"],
      ["auth:refresh"],
    ]);
  });

  it("offers the default account to a chat pinned elsewhere, and hides what enabledBackends excludes", () => {
    const panel = renderAuthPanel(
      [signedOut("claude"), signedOut("claude-2")],
      {
        backendId: "claude-2",
        selectable: ["claude"],
      },
    );
    expect(panel.keyboard.flat().map(data)).toEqual([
      "auth:login:claude",
      "auth:use:claude",
      "auth:login:claude-2",
      "auth:rm:claude-2",
      "auth:add",
      "auth:refresh",
    ]);
  });

  it("keeps every payload within 64 bytes for the longest account id", () => {
    const id = `claude-${"a".repeat(32)}` as const;
    setClaudeAccounts([{ id, label: "Long", configDir: "/x" }]);
    const panel = renderAuthPanel([signedOut("claude"), signedOut(id)], {
      backendId: "codex",
      selectable: ["claude", id],
    });
    const confirm = renderRemoveConfirm({
      account: { id, label: "Long", configDir: "/x" },
      chats: [],
      defaultBackendId: "claude",
      sessionKept: true,
      managedDir: true,
    });
    const payloads = [...panel.keyboard, ...confirm.keyboard].flat().map(data);
    expect(payloads).toContain(`auth:rmok:${id}`);
    for (const data of payloads)
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
  });

  it("the confirmation says where the chats go and what happens to the sign-in", () => {
    const managed = renderRemoveConfirm({
      account: account2,
      chats: ["1", "2"],
      defaultBackendId: "claude",
      sessionKept: true,
      managedDir: true,
    });
    expect(managed.text).toContain(
      "2 chats on it move to the default backend, Claude (session kept).",
    );
    expect(managed.text).toContain("sign-in is deleted along with");
    expect(managed.keyboard).toEqual([
      [
        { text: "🗑 Remove", callback_data: "auth:rmok:claude-2" },
        { text: "Back", callback_data: "auth:refresh" },
      ],
    ]);
    const foreign = renderRemoveConfirm({
      account: { ...account2, configDir: "/srv/claude" },
      chats: [],
      defaultBackendId: "claude",
      sessionKept: true,
      managedDir: false,
    });
    expect(foreign.text).toContain("No chat is pinned to it.");
    expect(foreign.text).toContain(
      "sign-in is left at <code>/srv/claude</code>",
    );
  });
});

describe("callbacks", () => {
  it("refuses non-admins", async () => {
    const ctx = makeCtx(222);
    await handleAuthCallback(ctx, "auth:add", deps);
    expect(admin.addClaudeAccount).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Not authorized.",
    });
  });

  it("add creates the account and starts its sign-in in the same message", async () => {
    admin.addClaudeAccount.mockResolvedValue({
      ok: true,
      account: account2,
      live: true,
    });
    const ctx = makeCtx();
    await handleAuthCallback(ctx, "auth:add", deps);
    expect(admin.addClaudeAccount).toHaveBeenCalledWith({});
    expect(login.startLogin).toHaveBeenCalledWith("claude-2", {
      claude: "claude",
      codex: undefined,
    });
    expect(ctx.api.editMessageText.mock.calls.at(-1)?.[1]).toBe(7);
    expect(lastEdit(ctx).text).toContain("Sign in to Claude (account 2)");
  });

  it("a refused add redraws the panel with the reason", async () => {
    admin.addClaudeAccount.mockResolvedValue({
      ok: false,
      error: "claude-2 already exists.",
    });
    const ctx = makeCtx();
    await handleAuthCallback(ctx, "auth:add", deps);
    expect(login.startLogin).not.toHaveBeenCalled();
    expect(lastEdit(ctx).text).toContain(
      "❌ Couldn't add a Claude account: claude-2 already exists.",
    );
  });

  it("remove asks first, then removes and notes the outcome", async () => {
    admin.planClaudeAccountRemoval.mockReturnValue({
      ok: true,
      account: account2,
      chats: ["5"],
      defaultBackendId: "claude",
      sessionKept: true,
      managedDir: true,
    });
    const ctx = makeCtx();
    await handleAuthCallback(ctx, "auth:rm:claude-2", deps);
    expect(admin.removeClaudeAccount).not.toHaveBeenCalled();
    expect(lastEdit(ctx).text).toContain("Remove Claude (account 2)?");

    admin.removeClaudeAccount.mockResolvedValue({
      ok: true,
      account: account2,
      chatsMoved: 1,
      sessionKept: true,
      credentialsDeleted: true,
      live: true,
    });
    await handleAuthCallback(ctx, "auth:rmok:claude-2", deps);
    expect(admin.removeClaudeAccount).toHaveBeenCalledWith("claude-2", {
      deleteCredentials: true,
    });
    expect(lastEdit(ctx).text).toContain(
      "🗑 Claude (account 2) removed. 1 chat moved to the default backend (session kept). Sign-in deleted.",
    );
  });

  it("a refused removal is a toast and leaves the panel alone", async () => {
    admin.planClaudeAccountRemoval.mockReturnValue({
      ok: false,
      error: 'claude-2 is the "backend" backend.',
    });
    const ctx = makeCtx();
    await handleAuthCallback(ctx, "auth:rm:claude-2", deps);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'claude-2 is the "backend" backend.',
    });
    expect(ctx.api.editMessageText).not.toHaveBeenCalled();
  });

  it("use pins this chat through the shared /model switch", async () => {
    const ctx = makeCtx();
    await handleAuthCallback(ctx, "auth:use:claude-2", deps);
    expect(switching.switchChatBackend).toHaveBeenCalledWith(
      String(ADMIN),
      { id: "claude-2", label: "Claude (account 2)" },
      deps,
    );
    expect(lastEdit(ctx).text).toContain("💬 Backend: Claude (account 2)");
  });

  it("use on the chat role's default drops the override instead of pinning it", async () => {
    chat.backendId = "claude-2";
    chat.override = true;
    const ctx = makeCtx();
    await handleAuthCallback(ctx, "auth:use:claude", deps);
    expect(switching.resetChatBackend).toHaveBeenCalledWith(
      String(ADMIN),
      deps,
    );
    expect(switching.switchChatBackend).not.toHaveBeenCalled();
  });
});

describe("/auth add", () => {
  it("adds the named account and drives its sign-in in a new message", async () => {
    admin.addClaudeAccount.mockResolvedValue({
      ok: true,
      account: { ...account2, id: "claude-work", label: "Claude (work)" },
      live: true,
    });
    let handler: ((ctx: Context) => Promise<void>) | undefined;
    const bot = {
      command: (_name: string, fn: (ctx: Context) => Promise<void>) => {
        handler = fn;
      },
      on: vi.fn(),
    } as unknown as Bot;
    registerAuthCommand(bot, deps);
    const ctx = makeCtx(ADMIN, "add work");
    await handler!(ctx);
    expect(admin.addClaudeAccount).toHaveBeenCalledWith({ name: "work" });
    expect(login.startLogin).toHaveBeenCalledWith(
      "claude-work",
      expect.anything(),
    );
    expect(ctx.api.editMessageText.mock.calls.at(-1)?.[1]).toBe(9);
  });
});
