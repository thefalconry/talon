/**
 * `talon accounts` — the Claude accounts Talon can run as
 * (docs/claude-accounts.md).
 *
 *   talon accounts [list]                 every Claude login and its state
 *   talon accounts add [name]             add claude-<name>, else claude-N
 *   talon accounts remove <id> [--keep-credentials]
 *   talon accounts login <id>             sign an account in, interactively
 *
 * list/add/remove go to the running daemon over its loopback gateway, so a
 * change applies at once: the daemon owns the backend registry and the
 * chats pinned to an account. With no daemon they edit config.json through
 * the same core code (core/auth/claude-accounts-admin.ts) and apply at the
 * next start. `login` needs no daemon: it runs `claude auth login` against
 * the account's config dir, and the next run reads the new credentials.
 */

import { spawn } from "node:child_process";
import pc from "picocolors";
import { findRunningInstance } from "../../core/daemon/discovery.js";
import type {
  AccountListing,
  AddedAccount,
  AdminResult,
  RemovedAccount,
} from "../../core/auth/claude-accounts-admin.js";
import { fetchGateway } from "../daemon-api.js";

const USAGE = `
  ${pc.bold("talon accounts")} — Claude accounts (docs/claude-accounts.md)

    ${pc.cyan("list")}                                 every Claude login and its state (default)
    ${pc.cyan("add")} [name]                           add claude-<name> (else the next claude-N)
    ${pc.cyan("remove")} <id> [--keep-credentials]     remove; its chats move to the default backend
    ${pc.cyan("login")} <id>                           sign an account in (runs claude auth login)
`;

/** Remove may release chats and delete a directory: allow it some time. */
const ADMIN_TIMEOUT_MS = 30_000;

/** The daemon's gateway port; null = not running; "starting" = no port yet. */
async function daemonPort(): Promise<number | null | "starting"> {
  const instance = await findRunningInstance();
  if (!instance) return null;
  return instance.port ?? "starting";
}

/** The core admin module, with the account list read from config.json. */
async function offlineAdmin() {
  const admin = await import("../../core/auth/claude-accounts-admin.js");
  const { readConfigRecord } = await import("../../core/config/persist.js");
  const { claudeAccountsFromRaw, setClaudeAccounts } =
    await import("../../core/config/claude-accounts.js");
  setClaudeAccounts(claudeAccountsFromRaw(readConfigRecord()));
  return admin;
}

type Via<T> = { daemon: boolean; result: T };

/** Ask the daemon when it runs, else do it here; undefined after an error. */
async function viaDaemonOrConfig<T>(
  path: string,
  body: Record<string, unknown> | undefined,
  offline: (admin: Awaited<ReturnType<typeof offlineAdmin>>) => Promise<T>,
): Promise<Via<T> | undefined> {
  const port = await daemonPort();
  if (port === "starting") {
    console.error(
      `  ${pc.yellow("●")} Talon is starting (gateway port unknown) — try again in a moment.\n`,
    );
    process.exitCode = 1;
    return undefined;
  }
  if (port === null)
    return { daemon: false, result: await offline(await offlineAdmin()) };
  const init = body
    ? { method: "POST", body: JSON.stringify(body) }
    : undefined;
  const result = (await fetchGateway(port, path, init, ADMIN_TIMEOUT_MS)) as T;
  return { daemon: true, result };
}

function failed(error: string): void {
  console.error(`\n  ${pc.red("✖")} ${error}\n`);
  process.exitCode = 1;
}

const NEXT_START = pc.dim(
  "Talon isn't running: config.json is updated, and the change applies at its next start.",
);

async function listAccounts(): Promise<void> {
  const via = await viaDaemonOrConfig<{ accounts: AccountListing[] }>(
    "/claude-accounts",
    undefined,
    async (admin) => ({ accounts: await admin.listClaudeAccountsWithStatus() }),
  );
  if (!via) return;
  console.log(`\n  ${pc.bold("Claude accounts")}\n`);
  for (const a of via.result.accounts) {
    const dot = a.status.startsWith("signed in") ? pc.green("●") : pc.red("●");
    const tag = a.isDefault ? pc.dim(" (default)") : "";
    console.log(`  ${dot} ${pc.cyan(a.id)}${tag}  ${a.label}  ${a.status}`);
    console.log(pc.dim(`      ${a.configDir}`));
  }
  console.log();
}

async function addAccount(name: string | undefined): Promise<void> {
  const via = await viaDaemonOrConfig<AdminResult<AddedAccount>>(
    "/claude-accounts/add",
    name ? { name } : {},
    (admin) => admin.addClaudeAccount({ name }),
  );
  if (!via) return;
  if (!via.result.ok) return failed(via.result.error);
  const { account } = via.result;
  console.log(
    `\n  ${pc.green("✔")} Added ${pc.cyan(account.id)} (${account.label}) at ${account.configDir}`,
  );
  console.log(
    `  Sign it in: ${pc.cyan(`talon accounts login ${account.id}`)}, or /auth in Telegram.`,
  );
  console.log(via.daemon ? "" : `  ${NEXT_START}\n`);
}

async function removeAccount(
  id: string,
  keepCredentials: boolean,
): Promise<void> {
  const deleteCredentials = !keepCredentials;
  const via = await viaDaemonOrConfig<AdminResult<RemovedAccount>>(
    "/claude-accounts/remove",
    { id, deleteCredentials },
    (admin) => admin.removeClaudeAccount(id, { deleteCredentials }),
  );
  if (!via) return;
  if (!via.result.ok) return failed(via.result.error);
  const r = via.result;
  const moved =
    r.chatsMoved > 0
      ? ` ${r.chatsMoved} chat(s) moved to the default backend${r.sessionKept ? " (session kept)" : ""}.`
      : "";
  console.log(`\n  ${pc.green("✔")} Removed ${pc.cyan(r.account.id)}.${moved}`);
  console.log(
    r.credentialsDeleted
      ? "  Its sign-in was deleted."
      : `  Its sign-in was left at ${r.account.configDir}.`,
  );
  console.log(via.daemon ? "" : `  ${NEXT_START}\n`);
}

/** `claude auth login` with the account's CLAUDE_CONFIG_DIR, on this terminal. */
async function loginAccount(id: string): Promise<void> {
  const { readConfigRecord } = await import("../../core/config/persist.js");
  const { claudeAccountsFromRaw, defaultClaudeConfigDir } =
    await import("../../core/config/claude-accounts.js");
  const record = readConfigRecord();
  const account = claudeAccountsFromRaw(record).find((a) => a.id === id);
  if (id !== "claude" && !account)
    return failed(`No Claude account "${id}" in config.json.`);
  const env = { ...process.env };
  if (account) {
    // Link `projects` first, so the CLI never makes a real one there.
    const { ensureSharedProjects } =
      await import("../../core/auth/claude-projects.js");
    await ensureSharedProjects(account.configDir, defaultClaudeConfigDir(), id);
    env.CLAUDE_CONFIG_DIR = account.configDir;
  }
  const bin =
    typeof record.claudeBinary === "string" && record.claudeBinary
      ? record.claudeBinary
      : "claude";
  const code = await new Promise<number>((resolve) => {
    const child = spawn(bin, ["auth", "login"], { stdio: "inherit", env });
    child.on("error", (err) => {
      console.error(`  ${pc.red("✖")} Couldn't run ${bin}: ${err.message}`);
      resolve(1);
    });
    child.on("exit", (status) => resolve(status ?? 1));
  });
  if (code !== 0) return failed(`${bin} auth login exited with ${code}.`);
  console.log(`\n  ${pc.green("✔")} ${id} signed in.\n`);
}

export async function runAccountsCommand(args: string[]): Promise<void> {
  const [sub = "list", target] = args;
  switch (sub) {
    case "list":
      return listAccounts();
    case "add":
      return addAccount(target);
    case "remove":
    case "login":
      if (!target) return failed(`talon accounts ${sub} needs an account id.`);
      return sub === "login"
        ? loginAccount(target)
        : removeAccount(target, args.includes("--keep-credentials"));
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      console.error(`  Unknown accounts command: ${sub}\n${USAGE}`);
      process.exitCode = 1;
  }
}
