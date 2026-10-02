/**
 * Extra Claude accounts (`claudeAccounts`, docs/claude-accounts.md).
 *
 * The invariants:
 *   - config: ids are `claude-<name>`, unique, on their own config dir, and
 *     backend fields may only name declared accounts;
 *   - every spawn for an account carries that account's CLAUDE_CONFIG_DIR
 *     and the daemon's own environment is never written;
 *   - each account registers as its own backend, in the Claude account
 *     group and session store, explicit-only for the router;
 *   - `projects` links to the default account's store, and an existing
 *     real directory is left alone;
 *   - auth status, expiry marks and plan usage are per account.
 */

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ calls: [] as Array<{ options?: unknown }> }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn((args: { options?: unknown }) => {
    sdk.calls.push(args);
    return (async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: "ok",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })();
  }),
}));

const {
  claudeAccountConfigIssues,
  claudeAccountsFromRaw,
  resolveAccountDir,
  setClaudeAccounts,
} = await import("../core/config/claude-accounts.js");
const { BACKEND_IDS, isBackendId } =
  await import("../core/agent-runtime/model-ref.js");
const { sdkEnvFor } = await import("../backend/claude-sdk/accounts/account.js");
const { ensureSharedProjects, inspectProjectsLink } =
  await import("../core/auth/claude-projects.js");
const {
  clearProviderExpired,
  listAuthProviders,
  markProviderExpired,
  providerLabel,
  readAllProviderStatus,
  readProviderStatus,
} = await import("../core/auth/status.js");
const { getPlanUsage, resetPlanUsageCacheForTest } =
  await import("../backend/claude-sdk/usage/plan-usage.js");
const { backendStoreDirs, discoverSessionRoots, claudeProjectSlug } =
  await import("../core/backup/sources/sessions.js");
const registry = await import("../core/agent-runtime/backend-registry.js");
const { registerClaudeModelsStatic } =
  await import("../backend/claude-sdk/models/discovery.js");
const { CLAUDE_MODELS_STATIC } =
  await import("../backend/claude-sdk/models/static.js");

let root: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "talon-claude-accounts-"));
  process.env.CLAUDE_CONFIG_DIR = join(root, "default");
  delete process.env.ANTHROPIC_API_KEY;
  sdk.calls.length = 0;
  resetPlanUsageCacheForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setClaudeAccounts([]);
  clearProviderExpired("claude-2");
  rmSync(root, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

function credentials(dir: string, token: string, plan = "max"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        subscriptionType: plan,
        refreshTokenExpiresAt: Date.now() + 30 * 86_400_000,
      },
    }),
  );
}

function account2(dir = join(root, "acct-2")) {
  return {
    id: "claude-2" as const,
    label: "Claude (account 2)",
    configDir: dir,
  };
}

// ── Config ──────────────────────────────────────────────────────────────────

describe("config validation", () => {
  it("accepts account ids as backend ids by shape", () => {
    expect(isBackendId("claude-2")).toBe(true);
    expect(isBackendId("claude-work")).toBe(true);
    expect(isBackendId("claude-")).toBe(false);
    expect(isBackendId("claude_2")).toBe(false);
    expect(isBackendId("Claude-2")).toBe(false);
  });

  it("flags duplicate ids, shared dirs and undeclared references", () => {
    const issues = claudeAccountConfigIssues(
      {
        backend: "claude-3",
        enabledBackends: ["claude", "claude-2", "claude-4"],
        claudeAccounts: [
          { id: "claude-2", configDir: "/srv/a" },
          { id: "claude-2", configDir: "/srv/b" },
          { id: "claude-5", configDir: "/srv/a" },
          { id: "claude-6", configDir: join(root, "default") },
        ],
      },
      BACKEND_IDS,
    );
    expect(issues).toEqual([
      'claudeAccounts.1.id: "claude-2" is declared twice',
      'claudeAccounts.2.configDir: /srv/a is already the config dir of "claude-2" — each account needs its own',
      `claudeAccounts.3.configDir: ${join(root, "default")} is already the config dir of "claude" — each account needs its own`,
      'backend: "claude-3" is not a declared Claude account — add it to "claudeAccounts"',
      'enabledBackends.2: "claude-4" is not a declared Claude account — add it to "claudeAccounts"',
    ]);
  });

  it("is clean for a valid list", () => {
    expect(
      claudeAccountConfigIssues(
        {
          backend: "claude",
          heartbeatBackend: "claude-2",
          claudeAccounts: [{ id: "claude-2", configDir: "/srv/a" }],
        },
        BACKEND_IDS,
      ),
    ).toEqual([]);
  });

  it("expands ~ in configDir against the user's home", () => {
    expect(resolveAccountDir("~/.talon/accounts/x", "/home/test")).toBe(
      "/home/test/.talon/accounts/x",
    );
    expect(resolveAccountDir("/srv/x/", "/home/test")).toBe("/srv/x");
  });
});

// ── Environment ─────────────────────────────────────────────────────────────

describe("spawn environment", () => {
  it("the default account inherits; an account gets its own CLAUDE_CONFIG_DIR", () => {
    const base = { PATH: "/bin", CLAUDE_CONFIG_DIR: "/default" };
    expect(
      sdkEnvFor({ backendId: "claude", label: "x" }, undefined, base),
    ).toBeUndefined();
    expect(
      sdkEnvFor(
        { backendId: "claude-2", label: "x", configDir: "/acct" },
        undefined,
        base,
      ),
    ).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/acct" });
  });

  it("a caller's extra env can't point a run at another login", () => {
    const env = sdkEnvFor(
      { backendId: "claude-2", label: "x", configDir: "/acct" },
      { TMPDIR: "/tmp/run", CLAUDE_CONFIG_DIR: "/elsewhere" },
      { PATH: "/bin" },
    );
    expect(env).toEqual({
      PATH: "/bin",
      TMPDIR: "/tmp/run",
      CLAUDE_CONFIG_DIR: "/acct",
    });
  });
});

// ── Registration + a real backend instance ──────────────────────────────────

describe("account backends", () => {
  it("register in the Claude group, explicit-only, sharing sessions", async () => {
    const { loadBuiltinBackends } = await import("../backend/builtins.js");
    await loadBuiltinBackends({ claudeAccounts: [account2()] });
    // Idempotent: doctor and the daemon may both load.
    await loadBuiltinBackends({ claudeAccounts: [account2()] });

    const factory = registry.getBackend("claude-2");
    expect(factory).toMatchObject({
      id: "claude-2",
      label: "Claude (account 2)",
      accountGroup: "claude",
      sessionStore: "claude",
      explicitOnly: true,
    });
    expect(registry.getBackend("claude")?.explicitOnly).toBeUndefined();
    expect(registry.inSameAccountGroup("claude", "claude-2")).toBe(true);
    expect(registry.inSameAccountGroup("claude", "codex")).toBe(false);
    expect(registry.sharesSessionStore("claude", "claude-2")).toBe(true);
    expect(registry.sharesSessionStore("claude", "codex")).toBe(false);
    expect(registry.isRoutingAlternate("claude-2", "claude")).toBe(false);
    expect(registry.isRoutingAlternate("claude-2", "codex")).toBe(false);
    expect(registry.isRoutingAlternate("claude", "codex")).toBe(true);
  });

  it("runs background work with the account's config dir and links its projects", async () => {
    // Registration is per process (a changed account needs a restart), so
    // start from an empty registry rather than the previous test's dir.
    registry.clearBackends();
    const { registerClaudeAccountBackends } =
      await import("../backend/claude-sdk/accounts/register.js");
    const dir = join(root, "acct-2");
    registerClaudeAccountBackends({ claudeAccounts: [account2(dir)] });
    // A catalog is already there (as when the default account booted
    // first), so the account doesn't probe for models.
    registerClaudeModelsStatic(CLAUDE_MODELS_STATIC);

    const before = process.env.CLAUDE_CONFIG_DIR;
    const { backend } = await registry.getBackend("claude-2")!.init(
      {
        model: "default",
        workspace: join(root, "workspace"),
        systemPrompt: "x",
        frontend: "terminal",
      } as never,
      { getBridgePort: () => 0, frontendName: "terminal" },
    );
    expect(backend.id).toBe("claude-2");

    await backend.background!.runOneShotAgent({
      prompt: "hi",
      systemPrompt: "sys",
      workspace: join(root, "workspace"),
      model: "default",
      contextLabel: "subagent",
      abortController: new AbortController(),
      appendLog: async () => {},
      env: { TMPDIR: "/tmp/run" },
    } as never);

    const options = sdk.calls.at(-1)?.options as {
      env?: Record<string, string>;
    };
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe(dir);
    expect(options.env?.TMPDIR).toBe("/tmp/run");
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(before);

    // init linked the account's projects to the default store.
    expect(lstatSync(join(dir, "projects")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "projects"))).toBe(
      join(root, "default", "projects"),
    );
  });
});

// ── projects link ───────────────────────────────────────────────────────────

describe("shared projects", () => {
  it("creates the link (and both dirs) when absent, and is idempotent", async () => {
    const acct = join(root, "acct");
    const def = join(root, "default");
    expect((await inspectProjectsLink(acct, def)).state).toBe("missing");
    expect((await ensureSharedProjects(acct, def)).state).toBe("linked");
    expect((await ensureSharedProjects(acct, def)).state).toBe("linked");
    // A transcript written through either path is the same file.
    writeFileSync(join(acct, "projects", "s.jsonl"), "{}\n");
    expect(lstatSync(join(def, "projects", "s.jsonl")).isFile()).toBe(true);
  });

  it("leaves a real projects directory alone", async () => {
    const acct = join(root, "acct");
    mkdirSync(join(acct, "projects", "keep"), { recursive: true });
    const report = await ensureSharedProjects(acct, join(root, "default"));
    expect(report.state).toBe("separate");
    expect(lstatSync(join(acct, "projects")).isDirectory()).toBe(true);
    expect(lstatSync(join(acct, "projects", "keep")).isDirectory()).toBe(true);
  });
});

// ── Auth status ─────────────────────────────────────────────────────────────

describe("per-account auth status", () => {
  it("lists each account separately, from its own credentials", async () => {
    credentials(join(root, "default"), "tok-1", "max");
    setClaudeAccounts([account2()]);

    expect(listAuthProviders()).toEqual(["claude", "claude-2", "codex"]);
    expect(providerLabel("claude-2")).toBe("Claude (account 2)");
    const before = await readAllProviderStatus();
    expect(before.map((s) => [s.provider, s.loggedIn])).toEqual([
      ["claude", true],
      ["claude-2", false],
      ["codex", false],
    ]);

    credentials(join(root, "acct-2"), "tok-2", "pro");
    expect(await readProviderStatus("claude-2")).toMatchObject({
      provider: "claude-2",
      loggedIn: true,
      account: "pro plan",
      expired: false,
    });
  });

  it("marks one account expired without touching the other", async () => {
    credentials(join(root, "default"), "tok-1");
    credentials(join(root, "acct-2"), "tok-2");
    setClaudeAccounts([account2()]);

    markProviderExpired("claude-2");
    expect((await readProviderStatus("claude-2")).expired).toBe(true);
    expect((await readProviderStatus("claude")).expired).toBe(false);
    clearProviderExpired("claude-2");
    expect((await readProviderStatus("claude-2")).expired).toBe(false);
  });
});

// ── Plan usage ──────────────────────────────────────────────────────────────

describe("per-account plan usage", () => {
  it("reads each account's windows with that account's token", async () => {
    credentials(join(root, "default"), "tok-1");
    credentials(join(root, "acct-2"), "tok-2");
    const percentFor: Record<string, number> = {
      "Bearer tok-1": 91,
      "Bearer tok-2": 12,
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const auth = headers?.Authorization ?? "";
      return new Response(
        JSON.stringify({
          limits: [{ kind: "session", percent: percentFor[auth] }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const def = await getPlanUsage();
    const acct = await getPlanUsage(join(root, "acct-2"));
    expect(def?.windows[0]?.percent).toBe(91);
    expect(acct?.windows[0]?.percent).toBe(12);
    // Cached per account: a second read of each makes no request.
    await getPlanUsage();
    await getPlanUsage(join(root, "acct-2"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ── Backups ─────────────────────────────────────────────────────────────────

describe("backups and storage", () => {
  it("captures the shared transcripts once, never through an account's link", async () => {
    const home = join(root, "talon-home");
    const slug = claudeProjectSlug(join(home, "workspace"));
    mkdirSync(join(root, "default", "projects", slug), { recursive: true });
    await ensureSharedProjects(join(root, "acct-2"), join(root, "default"));

    const roots = await discoverSessionRoots({
      home,
      userHome: root,
      env: process.env,
      config: {
        backend: "claude-2",
        claudeAccounts: [account2()],
      },
    });
    expect(roots.map((r) => r.root)).toEqual([`sessions/claude/${slug}`]);
    expect(roots.every((r) => !r.source.includes("acct-2"))).toBe(true);
  });

  it("lists each account's dir for the container storage check", () => {
    const config = { claudeAccounts: [account2(), { id: "bad id" }] };
    expect(claudeAccountsFromRaw(config).map((a) => a.id)).toEqual([
      "claude-2",
    ]);
    expect(backendStoreDirs(root, process.env, config)).toEqual([
      { backend: "claude", path: join(root, "default") },
      { backend: "claude-2", path: join(root, "acct-2") },
    ]);
  });
});
