/**
 * Adding and removing Claude accounts at runtime
 * (core/auth/claude-accounts-admin.ts, docs/claude-accounts.md).
 *
 * The invariants:
 *   - an add picks a free id, refuses what config validation would, writes
 *     config.json, and makes the account a live backend and /auth provider;
 *   - a remove refuses the default account and any account a backend field
 *     names, moves pinned chats to the default backend (session kept when
 *     the store is shared), unregisters the backend and frees its pool
 *     entry;
 *   - only a Talon-made directory is deleted, and never the shared
 *     transcripts its `projects` link points at.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chatSettings = vi.hoisted(
  () => new Map<string, { backend?: string; model?: string }>(),
);

vi.mock("../storage/chat-settings.js", () => ({
  getAllChatSettings: () => Object.fromEntries(chatSettings),
  setChatBackend: (chatId: string, backend: string | undefined) => {
    const entry = chatSettings.get(chatId) ?? {};
    if (backend) entry.backend = backend;
    else delete entry.backend;
    chatSettings.set(chatId, entry);
  },
  clearLegacyChatModel: (chatId: string) => {
    delete chatSettings.get(chatId)?.model;
  },
}));

vi.mock("../storage/sessions.js", () => ({ resetSession: vi.fn() }));

const registry = await import("../core/agent-runtime/backend-registry.js");
const pool = await import("../core/engine/backend-controller/index.js");
const accounts = await import("../core/config/claude-accounts.js");
const admin = await import("../core/auth/claude-accounts-admin.js");
const { listAuthProviders } = await import("../core/auth/status.js");
const { resetSession } = await import("../storage/sessions.js");
const { dirs, files } = await import("../util/paths.js");
const { stubBackend } = await import("./helpers/stub-backend.js");

import type { TalonConfig } from "../core/config/index.js";
import type { BackendFactory } from "../core/agent-runtime/backend-registry.js";

const cleanups: string[] = [];

function factory(
  id: string,
  label: string,
  extra: Partial<BackendFactory> = {},
): BackendFactory {
  return {
    id,
    label,
    ...extra,
    async init() {
      return {
        backend: stubBackend({ label }),
        cleanup: () => void cleanups.push(id),
      };
    },
  };
}

const claudeFactory = (id: string, label: string) =>
  factory(id, label, { accountGroup: "claude", sessionStore: "claude" });

function writeConfig(record: Record<string, unknown>): void {
  mkdirSync(dirs.root, { recursive: true });
  writeFileSync(files.config, JSON.stringify(record));
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(files.config, "utf-8"));
}

let live: TalonConfig;

async function startPool(record: Record<string, unknown>): Promise<void> {
  writeConfig(record);
  live = { ...record } as TalonConfig;
  await pool.initBackendPool(live, {
    getBridgePort: () => 0,
    frontendName: "telegram",
  });
}

beforeEach(() => {
  registry.clearBackends();
  registry.registerBackend(claudeFactory("claude", "Anthropic"));
  registry.registerBackend(factory("codex", "Codex"));
  registry.setClaudeAccountFactoryMaker((a) =>
    factory(a.id, a.label, {
      accountGroup: "claude",
      sessionStore: "claude",
      explicitOnly: true,
    }),
  );
  chatSettings.clear();
  cleanups.length = 0;
  vi.mocked(resetSession).mockClear();
});

afterEach(() => {
  pool.resetBackendPoolForTest();
  accounts.setClaudeAccounts([]);
  registry.setClaudeAccountFactoryMaker(undefined);
  rmSync(dirs.root, { recursive: true, force: true });
});

describe("addClaudeAccount", () => {
  it("allocates claude-2, then claude-3, and makes each a live backend", async () => {
    await startPool({ backend: "claude", botToken: "keep-me" });

    const first = await admin.addClaudeAccount();
    const second = await admin.addClaudeAccount();
    expect(first).toMatchObject({
      ok: true,
      live: true,
      account: { id: "claude-2", label: "Claude (account 2)" },
    });
    expect(second).toMatchObject({ ok: true, account: { id: "claude-3" } });

    // config.json gains the entries, ~/-relative, and keeps everything else.
    expect(readConfig()).toEqual({
      backend: "claude",
      botToken: "keep-me",
      claudeAccounts: [
        {
          id: "claude-2",
          label: "Claude (account 2)",
          configDir: "~/.talon/accounts/claude-2",
        },
        {
          id: "claude-3",
          label: "Claude (account 3)",
          configDir: "~/.talon/accounts/claude-3",
        },
      ],
    });
    // Live: registry, /auth providers, /model's backend list.
    expect(registry.getBackend("claude-2")?.explicitOnly).toBe(true);
    expect(listAuthProviders()).toEqual([
      "claude",
      "claude-2",
      "claude-3",
      "codex",
    ]);
    expect(live.claudeAccounts?.map((e) => e.id)).toEqual([
      "claude-2",
      "claude-3",
    ]);
    expect(pool.isBackendAvailable("claude-3", live)).toBe(true);
    // Its projects link to the default account's store.
    const dir = join(dirs.root, "accounts", "claude-2");
    expect(lstatSync(join(dir, "projects")).isSymbolicLink()).toBe(true);
  });

  it("names an account, and adds it to enabledBackends only when that is set", async () => {
    await startPool({ backend: "claude", enabledBackends: ["claude"] });
    const added = await admin.addClaudeAccount({ name: "Work Laptop" });
    expect(added).toMatchObject({
      ok: true,
      account: { id: "claude-work-laptop", label: "Claude (Work Laptop)" },
    });
    expect(readConfig().enabledBackends).toEqual([
      "claude",
      "claude-work-laptop",
    ]);
    expect(live.enabledBackends).toEqual(["claude", "claude-work-laptop"]);
  });

  it("refuses a taken id, an unusable name, and what validation would reject", async () => {
    await startPool({
      backend: "claude",
      claudeAccounts: [
        // Sits on the directory claude-2 would get.
        { id: "claude-x", configDir: "~/.talon/accounts/claude-2" },
      ],
    });
    expect(await admin.addClaudeAccount({ name: "x" })).toEqual({
      ok: false,
      error: "claude-x already exists.",
    });
    expect(await admin.addClaudeAccount({ name: "!!!" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("can't name an account"),
    });
    const clash = await admin.addClaudeAccount();
    expect(clash.ok).toBe(false);
    expect(!clash.ok && clash.error).toContain(
      'is already the config dir of "claude-x"',
    );
    // Nothing was written.
    expect(readConfig().claudeAccounts).toHaveLength(1);
    expect(registry.hasBackend("claude-2")).toBe(false);
  });

  it("refuses past the account cap", async () => {
    await startPool({
      backend: "claude",
      claudeAccounts: Array.from({ length: 16 }, (_, i) => ({
        id: `claude-a${i}`,
        configDir: `/srv/acct-${i}`,
      })),
    });
    expect(await admin.addClaudeAccount()).toMatchObject({
      ok: false,
      error: expect.stringContaining("at most 16"),
    });
  });

  it("without a daemon, only writes config.json", async () => {
    writeConfig({ backend: "claude" });
    const added = await admin.addClaudeAccount();
    expect(added).toMatchObject({ ok: true, live: false });
    expect(readConfig().claudeAccounts).toHaveLength(1);
    expect(registry.hasBackend("claude-2")).toBe(false);
  });
});

describe("removeClaudeAccount", () => {
  async function poolWithAccount(record: Record<string, unknown> = {}) {
    await startPool({ backend: "claude", ...record });
    const added = await admin.addClaudeAccount();
    if (!added.ok) throw new Error(added.error);
    return added.account;
  }

  async function pin(chatId: string, id: string): Promise<void> {
    chatSettings.set(chatId, { backend: id, model: "legacy" });
    expect((await pool.rebindChat(chatId, id, live)).ok).toBe(true);
  }

  it("moves pinned chats to the default, keeps their session, and unregisters", async () => {
    const account = await poolWithAccount();
    await pin("100", "claude-2");
    await pin("200", "claude-2");

    const plan = admin.planClaudeAccountRemoval("claude-2");
    expect(plan).toMatchObject({
      ok: true,
      chats: ["100", "200"],
      defaultBackendId: "claude",
      sessionKept: true,
      managedDir: true,
    });

    const removed = await admin.removeClaudeAccount("claude-2");
    expect(removed).toMatchObject({
      ok: true,
      chatsMoved: 2,
      sessionKept: true,
      credentialsDeleted: true,
      live: true,
    });
    expect(pool.getBackendIdForChat("100")).toBe("claude");
    expect(chatSettings.get("100")).toEqual({});
    expect(resetSession).not.toHaveBeenCalled();
    // Pool entry freed, backend and provider gone, config.json cleaned.
    expect(cleanups).toEqual(["claude-2"]);
    expect(registry.hasBackend("claude-2")).toBe(false);
    expect(listAuthProviders()).toEqual(["claude", "codex"]);
    expect(readConfig().claudeAccounts).toBeUndefined();
    expect(live.claudeAccounts).toEqual([]);
    expect(existsSync(account.configDir)).toBe(false);
  });

  it("resets the session when the default backend can't resume it", async () => {
    await poolWithAccount({ backend: "codex" });
    await pin("100", "claude-2");
    const removed = await admin.removeClaudeAccount("claude-2");
    expect(removed).toMatchObject({ ok: true, sessionKept: false });
    expect(resetSession).toHaveBeenCalledWith("100", "backend-removed");
  });

  it("refuses the default account, unknown ids, and an account a role uses", async () => {
    await poolWithAccount();
    live.heartbeatBackend = "claude-2";
    expect(await admin.removeClaudeAccount("claude")).toMatchObject({
      ok: false,
      error: expect.stringContaining("default Claude account"),
    });
    expect(await admin.removeClaudeAccount("claude-9")).toEqual({
      ok: false,
      error: 'No Claude account "claude-9".',
    });
    expect(await admin.removeClaudeAccount("claude-2")).toEqual({
      ok: false,
      error:
        'claude-2 is the "heartbeatBackend" backend. Point "heartbeatBackend" at another backend first.',
    });
    expect(registry.hasBackend("claude-2")).toBe(true);
  });

  it("deletes the account dir but never the shared transcripts behind its link", async () => {
    const account = await poolWithAccount();
    const shared = join(process.env.CLAUDE_CONFIG_DIR!, "projects");
    writeFileSync(join(account.configDir, "projects", "s.jsonl"), "{}\n");
    writeFileSync(join(account.configDir, ".credentials.json"), "{}");

    await admin.removeClaudeAccount("claude-2");
    expect(existsSync(account.configDir)).toBe(false);
    expect(readFileSync(join(shared, "s.jsonl"), "utf-8")).toBe("{}\n");
  });

  it("keeps the dir on request, and always keeps one Talon didn't make", async () => {
    const account = await poolWithAccount();
    const kept = await admin.removeClaudeAccount("claude-2", {
      deleteCredentials: false,
    });
    expect(kept).toMatchObject({ ok: true, credentialsDeleted: false });
    expect(existsSync(account.configDir)).toBe(true);

    const outside = join(dirs.root, "..", "elsewhere", "acct");
    writeConfig({
      backend: "claude",
      claudeAccounts: [{ id: "claude-ext", configDir: outside }],
    });
    accounts.setClaudeAccounts(
      accounts.resolveClaudeAccounts([
        { id: "claude-ext", configDir: outside },
      ]),
    );
    mkdirSync(outside, { recursive: true });
    const ext = await admin.removeClaudeAccount("claude-ext");
    expect(ext).toMatchObject({ ok: true, credentialsDeleted: false });
    expect(existsSync(outside)).toBe(true);
    rmSync(join(dirs.root, "..", "elsewhere"), { recursive: true });
  });
});

describe("registry seams", () => {
  it("unregisterBackend drops an id and reports whether it was there", () => {
    expect(registry.unregisterBackend("codex")).toBe(true);
    expect(registry.hasBackend("codex")).toBe(false);
    expect(registry.unregisterBackend("codex")).toBe(false);
  });

  it("makeClaudeAccountFactory is empty until a driver installs its maker", () => {
    const account = {
      id: "claude-2" as const,
      label: "Claude (account 2)",
      configDir: "/srv/a",
    };
    registry.setClaudeAccountFactoryMaker(undefined);
    expect(registry.makeClaudeAccountFactory(account)).toBeUndefined();
    registry.setClaudeAccountFactoryMaker((a) => claudeFactory(a.id, a.label));
    expect(registry.makeClaudeAccountFactory(account)?.id).toBe("claude-2");
  });
});
