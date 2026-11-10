/**
 * Interactive CLI logins driven from a chat.
 *
 * Both CLIs can only log in interactively — `codex login --device-auth`
 * prints a URL plus a one-time code and waits for the browser side to
 * finish; `claude auth login` prints a URL and waits for the code the
 * browser hands back to be pasted on stdin. Each flow here spawns the CLI
 * against a THROWAWAY home (`CODEX_HOME` / `CLAUDE_CONFIG_DIR`), so a
 * cancelled or failed attempt never touches the credentials the daemon is
 * currently using; only a successful exit installs the new file over the
 * real one (atomic rename). One flow per provider at a time — starting a
 * new one cancels the old.
 *
 * An extra Claude account (`claude-2`, …) is a provider of its own: the
 * same `claude auth login`, installed into that account's config dir
 * (created if needed, with its `projects` linked to the default account's
 * so sessions carry across — core/auth/claude-projects.ts).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { log, logWarn } from "../../util/log.js";
import {
  claudeConfigDirFor,
  defaultClaudeConfigDir,
} from "../config/claude-accounts.js";
import { ensureSharedProjects } from "./claude-projects.js";
import {
  clearProviderExpired,
  codexAuthPath,
  credentialsPathFor,
  type AuthProvider,
} from "./status.js";
import { TalonError } from "../errors.js";

const LOGIN_TIMEOUT_MS = 15 * 60_000;

export interface LoginPrompt {
  /** Page the human must open. */
  url: string;
  /** One-time code shown to the human (Codex device auth). */
  code?: string;
  /** True when the human must send a code back to us (Claude). */
  needsCode: boolean;
}

type LoginOutcome =
  | { ok: true }
  | { ok: false; reason: "cancelled" | "timeout" | "failed"; detail?: string };

export interface LoginFlow {
  provider: AuthProvider;
  /** Resolves once the CLI has printed enough to instruct the human. */
  prompt: Promise<LoginPrompt>;
  /** Resolves when the CLI exits (or is cancelled / times out). */
  done: Promise<LoginOutcome>;
  /** Feed the pasted code to the CLI (Claude). */
  submitCode(code: string): void;
  cancel(): void;
}

export interface LoginBinaries {
  claude?: string;
  codex?: string;
}

// oxlint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Parse `codex login --device-auth` output into URL + code, once both are present. */
export function parseCodexDevicePrompt(
  output: string,
): LoginPrompt | undefined {
  const text = stripAnsi(output);
  const url = /https:\/\/\S+\/device\S*/.exec(text)?.[0];
  const code = /\b([A-Z0-9]{4}-[A-Z0-9]{5,6})\b/.exec(text)?.[1];
  if (!url || !code) return undefined;
  return { url, code, needsCode: false };
}

/** Parse `claude auth login` output into the sign-in URL, once printed. */
export function parseClaudeLoginPrompt(
  output: string,
): LoginPrompt | undefined {
  const text = stripAnsi(output);
  const url = /https:\/\/\S+oauth\/authorize\S*/.exec(text)?.[0];
  if (!url) return undefined;
  return { url, needsCode: true };
}

const active = new Map<AuthProvider, LoginFlow>();

export function activeLoginFlow(provider: AuthProvider): LoginFlow | undefined {
  return active.get(provider);
}

interface Spec {
  bin: string;
  args: string[];
  homeVar: "CODEX_HOME" | "CLAUDE_CONFIG_DIR";
  parse: (out: string) => LoginPrompt | undefined;
  /** Credential file inside the throwaway home → real destination. */
  install: (tmpHome: string) => { from: string; to: string };
  /** Runs after the credentials are in place. */
  afterInstall?: () => Promise<unknown>;
}

function specFor(provider: AuthProvider, bins: LoginBinaries): Spec {
  if (provider === "codex") {
    return {
      bin: bins.codex || "codex",
      args: ["login", "--device-auth"],
      homeVar: "CODEX_HOME",
      parse: parseCodexDevicePrompt,
      install: (tmp) => ({ from: join(tmp, "auth.json"), to: codexAuthPath() }),
    };
  }
  const to = credentialsPathFor(provider);
  if (!to)
    throw new TalonError(`"${provider}" is not a configured Claude account`, {
      reason: "auth",
    });
  const accountDir =
    provider === "claude" ? undefined : claudeConfigDirFor(provider);
  return {
    bin: bins.claude || "claude",
    args: ["auth", "login"],
    homeVar: "CLAUDE_CONFIG_DIR",
    parse: parseClaudeLoginPrompt,
    install: (tmp) => ({ from: join(tmp, ".credentials.json"), to }),
    ...(accountDir
      ? {
          afterInstall: () =>
            ensureSharedProjects(
              accountDir,
              defaultClaudeConfigDir(),
              provider,
            ),
        }
      : {}),
  };
}

async function installCredentials(from: string, to: string): Promise<void> {
  // An extra account's dir may not exist before its first login.
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  const staging = join(dirname(to), `.${Date.now()}.login.tmp`);
  await copyFile(from, staging);
  await rename(staging, to);
}

export function startLogin(
  provider: AuthProvider,
  bins: LoginBinaries = {},
): LoginFlow {
  active.get(provider)?.cancel();
  const spec = specFor(provider, bins);

  let child: ChildProcess | undefined;
  let tmpHome: string | undefined;
  let output = "";
  let settled = false;
  let cancelled = false;
  let resolvePrompt!: (p: LoginPrompt) => void;
  let rejectPrompt!: (e: Error) => void;
  let resolveDone!: (o: LoginOutcome) => void;
  const prompt = new Promise<LoginPrompt>((res, rej) => {
    resolvePrompt = res;
    rejectPrompt = rej;
  });
  const done = new Promise<LoginOutcome>((res) => {
    resolveDone = res;
  });
  let promptSent = false;

  const finish = async (outcome: LoginOutcome): Promise<void> => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (active.get(provider) === flow) active.delete(provider);
    if (!promptSent)
      rejectPrompt(
        new Error(outcome.ok ? "no prompt" : outcome.detail || outcome.reason),
      );
    if (tmpHome)
      await rm(tmpHome, { recursive: true, force: true }).catch(
        (err: unknown) =>
          // The scratch HOME can hold a fresh credential copy — a leftover
          // is worth knowing about.
          logWarn(
            "notify",
            `${provider} login cleanup failed dir=${tmpHome}: ${err instanceof Error ? err.message : String(err)}`,
          ),
      );
    resolveDone(outcome);
  };

  const timer = setTimeout(() => {
    child?.kill("SIGTERM");
    void finish({ ok: false, reason: "timeout" });
  }, LOGIN_TIMEOUT_MS);

  const flow: LoginFlow = {
    provider,
    prompt,
    done,
    submitCode(code) {
      child?.stdin?.write(`${code.trim()}\n`);
    },
    cancel() {
      cancelled = true;
      child?.kill("SIGTERM");
      void finish({ ok: false, reason: "cancelled" });
    },
  };
  active.set(provider, flow);

  void (async () => {
    tmpHome = await mkdtemp(join(tmpdir(), `talon-${provider}-login-`));
    if (settled) return;
    child = spawn(spec.bin, spec.args, {
      env: { ...process.env, [spec.homeVar]: tmpHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (promptSent) return;
      const parsed = spec.parse(output);
      if (parsed) {
        promptSent = true;
        resolvePrompt(parsed);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      void finish({ ok: false, reason: "failed", detail: err.message });
    });
    child.on("exit", async (code, signal) => {
      if (settled || cancelled) return;
      if (code === 0 && tmpHome) {
        const { from, to } = spec.install(tmpHome);
        try {
          await installCredentials(from, to);
          clearProviderExpired(provider);
          await spec
            .afterInstall?.()
            .catch((err: unknown) =>
              logWarn(
                "notify",
                `${provider} login installed, but linking its sessions failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          log("notify", `${provider} login installed at ${to}`);
          await finish({ ok: true });
          return;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          logWarn(
            "notify",
            `${provider} login succeeded but install failed: ${detail}`,
          );
          await finish({
            ok: false,
            reason: "failed",
            detail: `could not install credentials: ${detail}`,
          });
          return;
        }
      }
      const tail = stripAnsi(output)
        .trim()
        .split("\n")
        .slice(-3)
        .join(" ")
        .slice(0, 300);
      await finish({
        ok: false,
        reason: "failed",
        detail: `${spec.bin} exited with ${signal ?? `code ${code}`}${tail ? `: ${tail}` : ""}`,
      });
    });
  })();

  return flow;
}
