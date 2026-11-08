/**
 * `talon backup` — snapshots and checkpoints from the outside.
 *
 * Two execution modes, chosen per subcommand:
 *
 *   - Through the daemon (`now`, `targets`, `status`) when one is
 *     running. The daemon has the plugins loaded, so it is the only
 *     process that can see the remote targets — and routing through it
 *     also means one writer, not two racing `VACUUM INTO`s.
 *   - In this process (`list`, `show`, `pin`, `unpin`, `prune`, and
 *     `now` with no daemon) — they read the manifests on disk and the
 *     index in talon.db, both of which are safe to touch concurrently.
 *
 * `restore` refuses while the daemon is running, full stop: it replaces
 * the database and the memory under a live process. Stop Talon first, or
 * use `/backup restore <id>` from chat, which stages the request and
 * lets the next boot apply it before anything opens the database.
 *
 * Lives in `commands/` because that is where docs/structure.md's worklist
 * item 8 puts every CLI command; `src/cli/` itself is at its file ceiling.
 */

import pc from "picocolors";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import {
  getFrontends,
  loadBackupConfig,
  loadConfig,
} from "../../core/config/index.js";
import { findRunningInstance } from "../../core/daemon/discovery.js";
import {
  collectBackupStatus,
  formatBackupStatus,
  formatBytes,
  formatRelative,
  isSnapshotId,
  listSnapshots,
  discoverTargets,
  readManifest,
  restoreSnapshot,
  setSnapshotPinned,
  type BackupTarget,
  type SnapshotSummary,
} from "../../core/backup/index.js";
import { resolveBackupSettings } from "../../core/backup/plan.js";
import { buildSnapshot } from "../../core/backup/snapshot.js";
import { pruneLocal, reconcileIndex } from "../../core/backup/store.js";
import {
  describeRetention,
  localRetention,
} from "../../core/backup/retention/policy.js";
import { generatePassphraseFile } from "../../core/backup/passphrase.js";
import { dirs } from "../../util/paths.js";
import { fetchGateway } from "../daemon-api.js";

const USAGE = `
  ${pc.bold("talon backup")} — snapshots and checkpoints

    ${pc.cyan("now")} [--checkpoint <label>] [--pin]   take a snapshot now
    ${pc.cyan("list")} [--remote <targetId>]           list snapshots
    ${pc.cyan("show")} <id>                            everything about one snapshot
    ${pc.cyan("pin")} <id>  |  ${pc.cyan("unpin")} <id>          keep past retention, or release
    ${pc.cyan("restore")} <id> [--from <target>] [--yes] [--allow-unauthenticated]
                                       restore (daemon must be stopped)
          [--clone]                            …onto a new machine: relocate sessions + plugin paths
          [--origin-user-home <path>]          …for a --clone of a snapshot with no recorded origin
    ${pc.cyan("prune")}                                apply the local retention policy
    ${pc.cyan("targets")}                              remote targets and their readiness
    ${pc.cyan("status")}                               schedule, sizes, targets
    ${pc.cyan("keygen")} [path]                        new passphrase file (mode 600)
`;

type Flags = { values: string[]; flags: Map<string, string | true> };

/** `--from drive --yes x` → { values: ["x"], flags: { from: "drive", yes: true } } */
function parseArgs(argv: readonly string[]): Flags {
  const values: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      values.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return { values, flags };
}

async function daemonPort(): Promise<number | null> {
  const instance = await findRunningInstance();
  return instance?.port ?? null;
}

/** Run one action inside the daemon. Returns null when there is no daemon. */
async function viaDaemon(
  body: Record<string, unknown>,
): Promise<{ ok: boolean; text?: string; error?: string } | null> {
  const port = await daemonPort();
  if (port === null) return null;
  // A snapshot of a large workspace can take minutes; the default CLI
  // budget is three seconds.
  return (await fetchGateway(
    port,
    "/action",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    15 * 60_000,
  )) as { ok: boolean; text?: string; error?: string };
}

function renderResult(result: {
  ok: boolean;
  text?: string;
  error?: string;
}): void {
  if (result.ok) console.log(`  ${result.text ?? "Done."}\n`);
  else console.log(`  ${pc.red("●")} ${result.error ?? "Failed."}\n`);
}

function renderRow(snapshot: SnapshotSummary): string {
  const marks = [
    snapshot.kind === "checkpoint"
      ? pc.magenta("checkpoint")
      : pc.dim("backup"),
    snapshot.pinned ? pc.yellow("pinned") : "",
    snapshot.local ? "" : pc.dim("(remote only)"),
  ].filter(Boolean);
  const remote = Object.entries(snapshot.remote)
    .map(([id, entry]) =>
      entry.status === "uploaded"
        ? pc.green(id)
        : pc.yellow(`${id}:${entry.status}`),
    )
    .join(" ");
  return (
    `  ${pc.bold(snapshot.id)}  ${marks.join(" ")}  ${formatBytes(snapshot.sizeBytes).padStart(9)}` +
    `  ${pc.dim(formatRelative(snapshot.createdAt))}` +
    (snapshot.label ? `  ${snapshot.label}` : "") +
    (remote ? `  → ${remote}` : "")
  );
}

// ── Subcommands ─────────────────────────────────────────────────────────────

async function backupNow(flags: Flags): Promise<void> {
  const label =
    typeof flags.flags.get("checkpoint") === "string"
      ? String(flags.flags.get("checkpoint"))
      : undefined;
  const pin = flags.flags.get("pin") === true;
  const remote = await viaDaemon({ action: "backup.now", label, pin });
  if (remote) {
    renderResult(remote);
    return;
  }
  console.log(
    `  ${pc.dim("Talon is not running — taking a local snapshot (no remote upload).")}`,
  );
  const settings = resolveBackupSettings(loadConfig().backup);
  const manifest = await buildSnapshot({
    kind: label ? "checkpoint" : "backup",
    label,
    pinned: pin,
    settings,
  });
  await pruneLocal(localRetention(settings));
  console.log(
    `  ${pc.green("●")} ${manifest.id} — ${manifest.parts.length} part(s), ` +
      `${formatBytes(manifest.sizeBytes)}\n`,
  );
}

async function backupList(flags: Flags): Promise<void> {
  const target = flags.flags.get("remote");
  // The manifests on disk are authoritative: a fresh host with a copied-in
  // backups/ directory has an empty index until something reconciles it.
  await reconcileIndex();
  const snapshots = await listSnapshots();
  const filtered =
    typeof target === "string"
      ? snapshots.filter(
          (snapshot) => snapshot.remote[target]?.status === "uploaded",
        )
      : snapshots;
  if (filtered.length === 0) {
    console.log(`  ${pc.dim("No snapshots.")}\n`);
    return;
  }
  console.log("");
  for (const snapshot of filtered) console.log(renderRow(snapshot));
  const bytes = filtered.reduce((sum, snapshot) => sum + snapshot.sizeBytes, 0);
  console.log(
    `\n  ${pc.dim(`${filtered.length} snapshot(s), ${formatBytes(bytes)}`)}\n`,
  );
}

async function backupShow(id: string): Promise<void> {
  const manifest = await readManifest(id);
  if (!manifest) {
    console.log(`  ${pc.red("●")} No snapshot ${id} on this machine.\n`);
    return;
  }
  console.log(
    `\n  ${pc.bold(manifest.id)}  ${manifest.kind}${manifest.pinned ? pc.yellow(" pinned") : ""}`,
  );
  if (manifest.label) console.log(`  ${manifest.label}`);
  console.log(
    `  taken     ${new Date(manifest.createdAt).toISOString()} (${formatRelative(manifest.createdAt)})`,
  );
  console.log(
    `  host      ${manifest.host}  talon ${manifest.talonVersion}${manifest.gitHead ? ` @ ${manifest.gitHead}` : ""}`,
  );
  console.log(`  size      ${formatBytes(manifest.sizeBytes)}`);
  console.log(
    `  parts     ${manifest.parts.map((part) => `${part.name} (${formatBytes(part.bytes)})`).join(", ")}`,
  );
  console.log(`  includes  ${manifest.includes.join(", ")}`);
  if (manifest.extras?.length) {
    console.log(
      `  extras    ${manifest.extras.map((extra) => `extra/${extra.n} ← ${extra.source}`).join(", ")}`,
    );
  }
  for (const [targetId, state] of Object.entries(manifest.remote)) {
    console.log(
      `  remote    ${targetId}: ${state.status}${state.error ? ` — ${state.error}` : ""}`,
    );
  }
  console.log("");
}

async function backupPin(id: string, pinned: boolean): Promise<void> {
  const ok = await setSnapshotPinned(id, pinned);
  console.log(
    ok
      ? `  ${pc.green("●")} ${id} is ${pinned ? "pinned — retention will never prune it" : "unpinned"}\n`
      : `  ${pc.red("●")} No snapshot ${id}\n`,
  );
}

async function backupPrune(): Promise<void> {
  const settings = resolveBackupSettings(loadConfig().backup);
  const removed = await pruneLocal(localRetention(settings));
  console.log(
    removed.length === 0
      ? `  ${pc.dim(`Nothing to prune (${describeRetention(localRetention(settings))}).`)}\n`
      : `  ${pc.green("●")} Pruned ${removed.length}: ${removed.join(", ")}\n`,
  );
}

async function backupTargets(): Promise<void> {
  const result = await viaDaemon({ action: "backup.status" });
  if (!result) {
    console.log(
      `  ${pc.yellow("●")} Talon is not running — remote targets live in the daemon's plugins.\n`,
    );
    return;
  }
  renderResult(result);
}

async function backupStatus(): Promise<void> {
  const result = await viaDaemon({ action: "backup.status" });
  if (result) {
    renderResult(result);
    return;
  }
  const status = await collectBackupStatus({
    withTargets: false,
    settings: resolveBackupSettings(loadConfig().backup),
  });
  console.log(
    `\n${formatBackupStatus(status)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n")}\n`,
  );
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function backupRestore(id: string, flags: Flags): Promise<void> {
  if (!isSnapshotId(id)) {
    console.log(`  ${pc.red("●")} "${id}" is not a snapshot id.\n`);
    return;
  }
  const instance = await findRunningInstance();
  if (instance) {
    console.log(
      `  ${pc.red("●")} Talon is running (PID ${instance.pid}). A restore replaces the\n` +
        `    database and memory underneath it. Run ${pc.cyan("talon stop")} first, or use\n` +
        `    ${pc.cyan(`/backup restore ${id}`)} from chat — that stages the restore and applies\n` +
        `    it during the next boot.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const manifest = await readManifest(id);
  const from = flags.flags.get("from");
  if (!manifest && typeof from !== "string") {
    console.log(
      `  ${pc.red("●")} No snapshot ${id} on this machine (use --from <target> to fetch it).\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (flags.flags.get("yes") !== true) {
    console.log(
      `\n  This replaces config, prompts, keys, sessions, the database and memory\n` +
        `  with the contents of ${pc.bold(id)}${manifest?.label ? ` ("${manifest.label}")` : ""}.\n` +
        `  A pinned checkpoint of the current state is taken first.\n`,
    );
    if (!(await confirm(`  Type ${pc.bold("yes")} to continue: `))) {
      console.log(`  ${pc.dim("Cancelled.")}\n`);
      return;
    }
  }
  // Only the backup block: on a fresh host the real config is inside the
  // snapshot, and a full load would reject the placeholder one.
  const settings = resolveBackupSettings(loadBackupConfig());
  const target =
    typeof from === "string" ? await resolveTarget(from) : undefined;
  if (typeof from === "string" && !target) {
    process.exitCode = 1;
    return;
  }
  const clone = flags.flags.get("clone") === true;
  const originUserHome = flags.flags.get("origin-user-home");
  const report = await restoreSnapshot({
    id,
    settings,
    target,
    allowUnauthenticated: flags.flags.get("allow-unauthenticated") === true,
    clone,
    ...(typeof originUserHome === "string" ? { originUserHome } : {}),
  });
  const written = Object.entries(report.written)
    .map(([root, count]) => `${root} (${count})`)
    .join(", ");
  console.log(`\n  ${pc.green("●")} Restored ${report.id}`);
  if (report.checkpointId) {
    console.log(
      `  Previous state saved as ${pc.bold(report.checkpointId)} (pinned).`,
    );
  }
  console.log(`  Written: ${written || "nothing"}`);
  console.log(`  Removed: ${report.removed} file(s)`);
  console.log(
    `  Database: ${report.databaseReplaced ? "replaced" : "left in place"}\n`,
  );
  if (clone) {
    console.log(
      `  Clone: config.json paths ${report.configRewritten ? "rewritten for this machine" : "unchanged"}.\n` +
        `  Reinstall fetched plugins from ${pc.cyan("~/.talon/plugins-manifest.json")} (docs/backups.md).\n`,
    );
  }
}

/**
 * Find a target by id. Targets are plugins, and a restore runs with the
 * daemon stopped, so this process loads them itself — the same call
 * bootstrap makes, minus the frontends.
 */
async function resolveTarget(id: string): Promise<BackupTarget | undefined> {
  const config = loadConfig();
  const { loadPlugins } = await import("../../core/plugin/index.js");
  await loadPlugins(config.plugins, getFrontends(config));
  const targets = await discoverTargets();
  const target = targets.find((candidate) => candidate.id === id);
  if (!target) {
    console.log(
      `  ${pc.red("●")} No backup target "${id}"` +
        (targets.length > 0
          ? ` — loaded: ${targets.map((t) => t.id).join(", ")}\n`
          : " — no target plugins are configured.\n"),
    );
  }
  return target;
}

/** Write a fresh passphrase file. Prints where, never what. */
async function backupKeygen(path: string | undefined): Promise<void> {
  try {
    const dest = await generatePassphraseFile(
      path ?? join(dirs.root, "backup.key"),
    );
    console.log(
      `  ${pc.green("●")} Wrote a new backup passphrase to ${pc.bold(dest)} (mode 600).\n` +
        `    Enable it in config.json:\n` +
        `      "backup": { "encryption": { "passphraseFile": "${dest}" } }\n` +
        `    Keep a copy OFF this machine — encrypted snapshots cannot be\n` +
        `    restored without it.\n`,
    );
  } catch (err) {
    console.log(
      `  ${pc.red("●")} ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────

export async function runBackupCommand(argv: readonly string[]): Promise<void> {
  const { values, flags } = parseArgs(argv);
  const [subcommand, id] = values;
  const args: Flags = { values, flags };
  switch (subcommand) {
    case "now":
      await backupNow(args);
      return;
    case "list":
      await backupList(args);
      return;
    case "show":
      if (!id) return void console.log(USAGE);
      await backupShow(id);
      return;
    case "pin":
    case "unpin":
      if (!id) return void console.log(USAGE);
      await backupPin(id, subcommand === "pin");
      return;
    case "restore":
      if (!id) return void console.log(USAGE);
      await backupRestore(id, args);
      return;
    case "prune":
      await backupPrune();
      return;
    case "targets":
      await backupTargets();
      return;
    case "keygen":
      await backupKeygen(id);
      return;
    case "status":
    case undefined:
      await backupStatus();
      return;
    default:
      console.log(USAGE);
  }
}
