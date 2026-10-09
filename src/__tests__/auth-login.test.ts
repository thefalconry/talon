import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseClaudeLoginPrompt,
  parseCodexDevicePrompt,
  stripAnsi,
} from "../core/auth/login-flow.js";
import {
  alertKeyFor,
  alertTextFor,
  resetAuthExpiryAnnouncements,
  runAuthExpiryCheck,
} from "../core/auth/expiry-monitor.js";
import {
  clearProviderExpired,
  describeProviderStatus,
  markProviderExpired,
  parseClaudeCredentials,
  parseCodexAuth,
  readProviderStatus,
} from "../core/auth/status.js";
import {
  renderAuthPanel,
  renderLoginPrompt,
} from "../frontend/telegram/auth-panel.js";

const DAY = 86_400_000;

describe("login prompt parsers", () => {
  it("extracts URL and one-time code from codex device auth output", () => {
    const out =
      "\n\x1b[1mWelcome to Codex\x1b[0m\n1. Open this link in your browser\n" +
      "   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code (expires in 15 minutes)\n" +
      "   \x1b[94mD2YX-C4SB4\x1b[0m\n";
    expect(parseCodexDevicePrompt(out)).toEqual({
      url: "https://auth.openai.com/codex/device",
      code: "D2YX-C4SB4",
      needsCode: false,
    });
    expect(
      parseCodexDevicePrompt("Welcome to Codex\n1. Open this link"),
    ).toBeUndefined();
  });

  it("extracts the sign-in URL from claude auth login output and asks for a code", () => {
    const out =
      "Opening browser to sign in…\nIf the browser didn't open, visit: " +
      "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\nPaste code here if prompted > ";
    expect(parseClaudeLoginPrompt(out)).toEqual({
      url: "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz",
      needsCode: true,
    });
    expect(
      parseClaudeLoginPrompt("Opening browser to sign in…"),
    ).toBeUndefined();
    expect(stripAnsi("\x1b[94mplain\x1b[0m")).toBe("plain");
  });
});

describe("provider status", () => {
  it("reads claude refresh-token expiry as the login expiry", () => {
    const now = Date.now();
    const s = parseClaudeCredentials(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "a",
          refreshToken: "r",
          expiresAt: now + DAY,
          refreshTokenExpiresAt: now + 12 * DAY,
          subscriptionType: "max",
        },
      }),
    );
    expect(s.loggedIn).toBe(true);
    expect(s.expired).toBe(false);
    expect(describeProviderStatus(s, now)).toBe(
      "signed in (max plan), login expires in 12d",
    );
    expect(parseClaudeCredentials("{}").loggedIn).toBe(false);
    expect(parseClaudeCredentials("not json").loggedIn).toBe(false);
  });

  it("reads codex chatgpt and api-key auth files", () => {
    const now = Date.now();
    const chatgpt = parseCodexAuth(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "x.y.z", refresh_token: "r" },
        last_refresh: new Date(now - 3 * DAY).toISOString(),
      }),
    );
    expect(chatgpt).toMatchObject({
      loggedIn: true,
      expired: false,
      account: "ChatGPT",
    });
    expect(describeProviderStatus(chatgpt, now)).toBe(
      "signed in (ChatGPT), refreshed 3d ago",
    );
    expect(
      parseCodexAuth(JSON.stringify({ OPENAI_API_KEY: "sk-1" })).account,
    ).toBe("API key");
    expect(
      parseCodexAuth(JSON.stringify({ OPENAI_API_KEY: null, tokens: {} }))
        .loggedIn,
    ).toBe(false);
  });

  it("treats a missing file as not signed in and honours backend expiry reports", async () => {
    const home = await mkdtemp(join(tmpdir(), "talon-auth-"));
    try {
      const env = { CODEX_HOME: home } as NodeJS.ProcessEnv;
      expect((await readProviderStatus("codex", env)).loggedIn).toBe(false);
      await writeFile(
        join(home, "auth.json"),
        JSON.stringify({ tokens: { refresh_token: "r" } }),
      );
      expect(await readProviderStatus("codex", env)).toMatchObject({
        loggedIn: true,
        expired: false,
      });
      markProviderExpired("codex");
      expect((await readProviderStatus("codex", env)).expired).toBe(true);
      clearProviderExpired("codex");
      expect((await readProviderStatus("codex", env)).expired).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("expiry monitor", () => {
  const now = Date.now();

  it("keys alerts by state so each is announced once", () => {
    const fresh = {
      provider: "claude" as const,
      loggedIn: true,
      expired: false,
      loginExpiresAt: now + 30 * DAY,
    };
    expect(alertKeyFor(fresh, now)).toBeUndefined();
    const soon = { ...fresh, loginExpiresAt: now + 3 * DAY + 1000 };
    expect(alertKeyFor(soon, now)).toBe("claude:expiring:3");
    expect(alertTextFor(soon, now)).toContain("expires in 3 days");
    expect(alertKeyFor({ ...fresh, expired: true }, now)).toBe(
      "claude:expired",
    );
    expect(
      alertKeyFor({ provider: "codex", loggedIn: false, expired: true }, now),
    ).toBe("codex:missing");
    expect(
      alertTextFor({ provider: "codex", loggedIn: false, expired: true }, now),
    ).toContain("/auth");
  });

  describe("with isolated credential dirs", () => {
    let home: string;
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), "talon-auth-mon-"));
      process.env.CODEX_HOME = join(home, "codex");
      process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
      resetAuthExpiryAnnouncements();
    });
    afterEach(async () => {
      delete process.env.CODEX_HOME;
      delete process.env.CLAUDE_CONFIG_DIR;
      await rm(home, { recursive: true, force: true });
    });

    it("notifies once per state and re-arms when the state changes", async () => {
      const sent: string[] = [];
      const notify = async (t: string): Promise<void> => {
        sent.push(t);
      };
      await runAuthExpiryCheck(now, notify);
      expect(sent).toHaveLength(2); // both missing
      await runAuthExpiryCheck(now, notify);
      expect(sent).toHaveLength(2); // latched

      const { mkdir, writeFile: wf } = await import("node:fs/promises");
      await mkdir(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
      await wf(
        join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "a",
            refreshTokenExpiresAt: now + 2 * DAY + 1000,
          },
        }),
      );
      await runAuthExpiryCheck(now, notify);
      expect(sent).toHaveLength(3);
      expect(sent[2]).toContain("Claude login expires in 2 days");
    });
  });
});

describe("telegram auth panel", () => {
  it("renders a status line and sign-in button per provider plus refresh", () => {
    const panel = renderAuthPanel([
      {
        provider: "claude",
        loggedIn: true,
        expired: false,
        account: "max plan",
        loginExpiresAt: Date.now() + 30 * DAY,
      },
      { provider: "codex", loggedIn: false, expired: true },
    ]);
    expect(panel.text).toContain("🟢 <b>Claude</b>");
    expect(panel.text).toContain("🔴 <b>Codex</b> — not signed in");
    expect(panel.keyboard.map((row) => row[0])).toEqual([
      { text: "🔄 Re-sign in to Claude", callback_data: "auth:login:claude" },
      { text: "🔑 Sign in to Codex", callback_data: "auth:login:codex" },
      { text: "➕ Add Claude account", callback_data: "auth:add" },
      { text: "↻ Refresh", callback_data: "auth:refresh" },
    ]);
  });

  it("renders the device code and an open-link button for codex, reply instructions for claude", () => {
    const codex = renderLoginPrompt("codex", {
      url: "https://auth.openai.com/codex/device",
      code: "AB12-CD34E",
      needsCode: false,
    });
    expect(codex.text).toContain("<code>AB12-CD34E</code>");
    expect(codex.text).not.toContain("reply to this message");
    expect(codex.keyboard[0][0]).toEqual({
      text: "🌐 Open sign-in page",
      url: "https://auth.openai.com/codex/device",
    });
    expect(codex.keyboard[1][0]).toEqual({
      text: "✖ Cancel",
      callback_data: "auth:cancel:codex",
    });

    const claude = renderLoginPrompt("claude", {
      url: "https://claude.com/x",
      needsCode: true,
    });
    expect(claude.text).toContain("reply to this message");
  });
});
