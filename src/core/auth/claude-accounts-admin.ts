/**
 * Adding and removing Claude accounts while Talon runs.
 *
 * `claudeAccounts` in config.json is read at startup; this is the live path
 * behind /auth's add and remove buttons and `talon accounts`. An add
 * persists the entry, puts it on the process-wide account list (which is
 * what makes it an /auth provider) and registers its backend through the
 * driver's factory seam; the pool boots it on first use. A remove first
 * moves every chat pinned to the account back to the default backend, then
 * undoes the add. Those chats keep their session when the default backend
 * reads the same transcript store, which every Claude account does.
 *
 * With no pool in this process (the CLI, daemon stopped) only config.json
 * and the account's directory change, and the daemon picks the change up
 * at its next start.
 *
 * Nothing here picks an account for any work. That stays the operator's
 * call (docs/claude-accounts.md).
 */

import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  getBackend,
  hasBackend,
  listBackends,
  makeClaudeAccountFactory,
  registerBackend,
  sharesSessionStore,
  unregisterBackend,
} from "../agent-runtime/backend-registry.js";
import { BACKEND_IDS } from "../agent-runtime/model-ref.js";
import {
  claudeAccountConfigIssues,
  claudeAccountSchema,
  claudeAccountsFromRaw,
  defaultClaudeConfigDir,
  getClaudeAccount,
  isClaudeAccountId,
  listClaudeAccounts,
  MAX_CLAUDE_ACCOUNTS,
  resolveClaudeAccounts,
  setClaudeAccounts,
  type ClaudeAccount,
  type ClaudeAccountConfig,
} from "../config/claude-accounts.js";
import { persistConfigPatch, readConfigRecord } from "../config/persist.js";
import {
  chatsBoundTo,
  getBackendIdForRole,
  getPoolConfig,
  hasBackendPool,
  releaseChat,
  type BackendRole,
} from "../engine/backend-controller/index.js";
import {
  clearLegacyChatModel,
  getAllChatSettings,
  setChatBackend,
} from "../../storage/chat-settings.js";
import { resetSession } from "../../storage/sessions.js";
import { dirs } from "../../util/paths.js";
import { userHome } from "../../util/fs-path.js";
import { log } from "../../util/log.js";
import { ensureSharedProjects } from "./claude-projects.js";
import { activeLoginFlow } from "./login-flow.js";
import {
  clearProviderExpired,
  describeProviderStatus,
  readProviderStatus,
  type AuthProvider,
} from "./status.js";

export type AdminResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface AddedAccount {
  account: ClaudeAccount;
  /** False when no daemon runs here: the account applies at next start. */
  live: boolean;
}

export interface RemovalPlan {
  account: ClaudeAccount;
  /** Chats pinned to the account; they move to the default backend. */
  chats: string[];
  /** The backend those chats move to. */
  defaultBackendId: string;
  /** Whether those chats keep their session on the default backend. */
  sessionKept: boolean;
  /** The config dir is under `<talon root>/accounts/`, so Talon may delete it. */
  managedDir: boolean;
}

export interface RemovedAccount {
  account: ClaudeAccount;
  chatsMoved: number;
  sessionKept: boolean;
  /** The config dir (and the sign-in in it) was deleted. */
  credentialsDeleted: boolean;
  live: boolean;
}

export interface AccountListing {
  id: string;
  label: string;
  configDir: string;
  isDefault: boolean;
  managedDir: boolean;
  status: string;
}

const ROLE_FIELDS: ReadonlyArray<[BackendRole, string]> = [
  ["chat", "backend"],
  ["heartbeat", "heartbeatBackend"],
  ["dream", "dreamBackend"],
];

/** Where Talon keeps the accounts it creates. */
function accountsRoot(): string {
  return join(dirs.root, "accounts");
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** A config dir Talon created, and so may delete. */
function isManagedAccountDir(dir: string): boolean {
  return isInside(accountsRoot(), dir);
}

/** `~/…` when under the home dir (how operators write it), else absolute. */
function storedDir(dir: string): string {
  const home = userHome();
  if (!isInside(home, dir)) return dir;
  return `~/${relative(home, dir).split(sep).join("/")}`;
}

function failure(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

// One change at a time: two quick adds must not both pick `claude-2`.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/** The raw `claudeAccounts` entries in config.json, whatever their shape. */
function diskEntries(record: Record<string, unknown>): unknown[] {
  return Array.isArray(record.claudeAccounts) ? [...record.claudeAccounts] : [];
}

function entryId(entry: unknown): unknown {
  return (entry as { id?: unknown } | null)?.id;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Every id an added account must not take. */
function takenIds(entries: readonly unknown[]): Set<string> {
  return new Set<string>([
    ...entries
      .map(entryId)
      .filter((id): id is string => typeof id === "string"),
    ...listClaudeAccounts().map((a) => a.id),
    ...listBackends().map((b) => b.id),
  ]);
}

/** `"Work Laptop"` → `claude-work-laptop`; undefined when nothing is left. */
function namedId(name: string): string | undefined {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^claude-/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  const id = `claude-${slug}`;
  return slug && slug !== "claude" && isClaudeAccountId(id) ? id : undefined;
}

function nextNumberedId(taken: ReadonlySet<string>): string {
  let n = 2;
  while (taken.has(`claude-${n}`)) n++;
  return `claude-${n}`;
}

/** Cross-reference problems the would-be config has that today's doesn't. */
function introducedIssues(
  record: Record<string, unknown>,
  entries: readonly unknown[],
  entry: ClaudeAccountConfig,
): string[] {
  const valid = entries.flatMap((e) => {
    const parsed = claudeAccountSchema.safeParse(e);
    return parsed.success ? [parsed.data] : [];
  });
  const refs = {
    backend: str(record.backend),
    heartbeatBackend: str(record.heartbeatBackend),
    dreamBackend: str(record.dreamBackend),
    enabledBackends: Array.isArray(record.enabledBackends)
      ? record.enabledBackends.filter(
          (id): id is string => typeof id === "string",
        )
      : undefined,
  };
  const before = new Set(
    claudeAccountConfigIssues({ ...refs, claudeAccounts: valid }, BACKEND_IDS),
  );
  return claudeAccountConfigIssues(
    { ...refs, claudeAccounts: [...valid, entry] },
    BACKEND_IDS,
  ).filter((issue) => !before.has(issue));
}

/** The new entry, or why there can't be one. */
function draftAccount(
  record: Record<string, unknown>,
  request: { name?: string; label?: string },
): AdminResult<{ entry: ClaudeAccountConfig }> {
  const entries = diskEntries(record);
  if (entries.length >= MAX_CLAUDE_ACCOUNTS)
    return {
      ok: false,
      error: `Talon supports at most ${MAX_CLAUDE_ACCOUNTS} extra Claude accounts.`,
    };
  const taken = takenIds(entries);
  const name = request.name?.trim();
  const id = name ? namedId(name) : nextNumberedId(taken);
  if (!id)
    return {
      ok: false,
      error: `"${name}" can't name an account: use letters, digits and hyphens.`,
    };
  if (taken.has(id)) return { ok: false, error: `${id} already exists.` };
  const parsed = claudeAccountSchema.safeParse({
    id,
    label:
      request.label?.trim() ||
      (name ? `Claude (${name})` : `Claude (account ${id.slice(7)})`),
    configDir: storedDir(join(accountsRoot(), id)),
  });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  const issues = introducedIssues(record, entries, parsed.data);
  if (issues.length > 0) return { ok: false, error: issues.join("; ") };
  return { ok: true, entry: parsed.data };
}

/** Put an account on the live lists and register its backend. */
function goLive(account: ClaudeAccount, entry: ClaudeAccountConfig): boolean {
  setClaudeAccounts([
    ...listClaudeAccounts().filter((a) => a.id !== account.id),
    account,
  ]);
  const config = getPoolConfig();
  if (!config) return false;
  config.claudeAccounts = [
    ...(config.claudeAccounts ?? []).filter((e) => e.id !== entry.id),
    entry,
  ];
  if (config.enabledBackends)
    config.enabledBackends = [...config.enabledBackends, account.id];
  if (hasBackend(account.id)) return true;
  const factory = makeClaudeAccountFactory(account);
  if (factory) registerBackend(factory);
  return factory !== undefined;
}

async function addNow(request: {
  name?: string;
  label?: string;
}): Promise<AdminResult<AddedAccount>> {
  const record = readConfigRecord();
  const draft = draftAccount(record, request);
  if (!draft.ok) return draft;
  const { entry } = draft;
  const enabled = Array.isArray(record.enabledBackends)
    ? [...record.enabledBackends, entry.id]
    : undefined;
  persistConfigPatch({
    claudeAccounts: [...diskEntries(record), entry],
    ...(enabled ? { enabledBackends: enabled } : {}),
  });
  const account = resolveClaudeAccounts([entry])[0]!;
  const live = goLive(account, entry);
  await ensureSharedProjects(
    account.configDir,
    defaultClaudeConfigDir(),
    account.id,
  );
  log("config", `Claude account ${account.id} added (${account.configDir})`);
  return { ok: true, account, live };
}

/**
 * Add an extra Claude account: `claude-<name>` when named, else the next
 * free `claude-N`, with its config dir under `<talon root>/accounts/`. It
 * still needs signing in (/auth, `talon accounts login`).
 */
export function addClaudeAccount(
  request: { name?: string; label?: string } = {},
): Promise<AdminResult<AddedAccount>> {
  return serialized(() => addNow(request).catch(failure));
}

/** The account by id, from the live list or, with no daemon, config.json. */
function findAccount(
  id: string,
  record: Record<string, unknown>,
): ClaudeAccount | undefined {
  return (
    getClaudeAccount(id) ??
    claudeAccountsFromRaw(record).find((a) => a.id === id)
  );
}

/** The config field that still points work at `id`, if any. */
function roleUsing(
  id: string,
  record: Record<string, unknown>,
): string | undefined {
  const live = getPoolConfig() as Record<string, unknown> | null;
  const pooled = hasBackendPool();
  return ROLE_FIELDS.find(
    ([role, field]) =>
      record[field] === id ||
      live?.[field] === id ||
      (pooled && getBackendIdForRole(role) === id),
  )?.[1];
}

/** Chats pinned to `id`, by setting or by live pool binding. */
function chatsOn(id: string): string[] {
  if (!hasBackendPool()) return [];
  const pinned = Object.entries(getAllChatSettings())
    .filter(([, settings]) => settings.backend === id)
    .map(([chatId]) => chatId);
  return [...new Set([...pinned, ...chatsBoundTo(id)])];
}

function planWith(
  id: string,
  record: Record<string, unknown>,
): AdminResult<RemovalPlan> {
  if (id === "claude")
    return {
      ok: false,
      error:
        "The default Claude account can't be removed: it is the claude backend itself.",
    };
  const account = findAccount(id, record);
  if (!account) return { ok: false, error: `No Claude account "${id}".` };
  const field = roleUsing(id, record);
  if (field)
    return {
      ok: false,
      error: `${id} is the "${field}" backend. Point "${field}" at another backend first.`,
    };
  const defaultId = hasBackendPool() ? getBackendIdForRole("chat") : "claude";
  return {
    ok: true,
    account,
    chats: chatsOn(id),
    defaultBackendId: defaultId,
    // Ask before unregistering: afterwards the registry can't answer.
    sessionKept: sharesSessionStore(id, defaultId),
    managedDir: isManagedAccountDir(account.configDir),
  };
}

/** What removing `id` would do, or why it is refused. Changes nothing. */
export function planClaudeAccountRemoval(id: string): AdminResult<RemovalPlan> {
  try {
    return planWith(id, readConfigRecord());
  } catch (err) {
    return failure(err);
  }
}

/** Serve a chat on the default backend again, as boot does for a vanished one. */
async function moveChatToDefault(
  chatId: string,
  sessionKept: boolean,
): Promise<void> {
  await releaseChat(chatId);
  setChatBackend(chatId, undefined);
  // The account's own model pick stays keyed under its id; only the
  // unkeyed legacy slot could mislead the default backend.
  clearLegacyChatModel(chatId);
  if (!sessionKept) resetSession(chatId, "backend-removed");
}

/** Take an account off the live lists and out of the registry. */
function goOffline(id: string): boolean {
  setClaudeAccounts(listClaudeAccounts().filter((a) => a.id !== id));
  clearProviderExpired(id as AuthProvider);
  const config = getPoolConfig();
  if (!config) return false;
  config.claudeAccounts = (config.claudeAccounts ?? []).filter(
    (e) => e.id !== id,
  );
  if (config.enabledBackends)
    config.enabledBackends = config.enabledBackends.filter((b) => b !== id);
  if (getBackend(id)) unregisterBackend(id);
  return true;
}

async function removeNow(
  id: string,
  deleteCredentials: boolean,
): Promise<AdminResult<RemovedAccount>> {
  const record = readConfigRecord();
  const plan = planWith(id, record);
  if (!plan.ok) return plan;
  activeLoginFlow(plan.account.id)?.cancel();
  for (const chatId of plan.chats)
    await moveChatToDefault(chatId, plan.sessionKept);
  const entries = diskEntries(record).filter((e) => entryId(e) !== id);
  persistConfigPatch({
    claudeAccounts: entries.length > 0 ? entries : undefined,
    ...(Array.isArray(record.enabledBackends)
      ? { enabledBackends: record.enabledBackends.filter((b) => b !== id) }
      : {}),
  });
  const live = goOffline(id);
  // `projects` is a link into the shared store: rm unlinks it and never
  // follows it, so no transcript goes with the account.
  const credentialsDeleted = deleteCredentials && plan.managedDir;
  if (credentialsDeleted)
    await rm(plan.account.configDir, { recursive: true, force: true });
  log(
    "config",
    `Claude account ${id} removed (${plan.chats.length} chat(s) moved to the default backend` +
      `${credentialsDeleted ? ", sign-in deleted" : ""})`,
  );
  return {
    ok: true,
    account: plan.account,
    chatsMoved: plan.chats.length,
    sessionKept: plan.sessionKept,
    credentialsDeleted,
    live,
  };
}

/**
 * Remove an extra Claude account. Refused for the default account, an
 * unknown id, or an account a backend field still names. Its config dir
 * is deleted only when Talon created it and `deleteCredentials` is set;
 * a directory the operator pointed at is always left in place.
 */
export function removeClaudeAccount(
  id: string,
  { deleteCredentials = true }: { deleteCredentials?: boolean } = {},
): Promise<AdminResult<RemovedAccount>> {
  return serialized(() => removeNow(id, deleteCredentials).catch(failure));
}

/** The default account plus every extra one, with its sign-in state. */
export async function listClaudeAccountsWithStatus(): Promise<
  AccountListing[]
> {
  const rows = [
    { id: "claude", label: "Claude", configDir: defaultClaudeConfigDir() },
    ...listClaudeAccounts(),
  ];
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      label: row.label,
      configDir: row.configDir,
      isDefault: row.id === "claude",
      managedDir: row.id !== "claude" && isManagedAccountDir(row.configDir),
      status: describeProviderStatus(
        await readProviderStatus(row.id as AuthProvider),
      ),
    })),
  );
}
