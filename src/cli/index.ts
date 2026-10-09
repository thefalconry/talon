/**
 * Talon CLI — interactive setup, management, and monitoring.
 *
 * The entry point (`src/cli.ts`) handles the must-run-first hidden subcommand
 * dispatch, then delegates to `runCli()` here. Each user-facing command lives
 * in its own module:
 *
 *   - `config`      — config model + load/save/format + banner
 *   - `setup`       — guided setup wizard
 *   - `status`      — health / stats summary
 *   - `config-view` — print + edit configuration
 *   - `logs`        — tail the log file
 *   - `doctor`      — environment + native-module checks
 *   - `chat`        — terminal chat mode
 *   - `daemon`      — start/stop/restart outcome rendering
 *   - `menu`        — interactive main menu (no-subcommand default)
 *   - `commands/`   — one module per command; new commands land here
 *                     (docs/structure.md worklist item 8)
 */

import pc from "picocolors";
// Imported (not read from disk) so `--version` works in a standalone
// `bun build --compile` binary, which has no package.json on disk — bun
// inlines the JSON at compile time; tsx/node resolve it from the package.
import pkg from "../../package.json" with { type: "json" };
import { PKG_ROOT } from "./context.js";
import { printBanner, ConfigFileError } from "./config.js";
import { runSetup } from "./setup.js";
import { showStatus } from "./status.js";
import { viewConfig } from "./config-view.js";
import { runLogsCommand } from "./logs.js";
import { runDoctor } from "./doctor.js";
import { startChat } from "./chat.js";
import { daemonStart, daemonStop, daemonRestart } from "./daemon.js";
import { showTasks, killTask } from "./tasks.js";
import { showEvents } from "./events.js";
import { runPluginCommand } from "./plugin.js";
import { runSkillCommand } from "./skill.js";
import { runMemoryCommand } from "./memory.js";
import { runHistoryCommand } from "./commands/history.js";
import { mainMenu } from "./menu.js";
import { runBackupCommand } from "./commands/backup.js";
import { runMeshCommand } from "./commands/mesh.js";
import { runAccountsCommand } from "./commands/accounts.js";

export * from "./context.js";
export * from "./config.js";

/** Every dispatchable subcommand — the unknown-command suggester's vocabulary. */
const CLI_COMMANDS = [
  "setup",
  "status",
  "config",
  "logs",
  "start",
  "stop",
  "restart",
  "run",
  "chat",
  "doctor",
  "ps",
  "kill",
  "events",
  "plugin",
  "skill",
  "memory",
  "history",
  "backup",
  "mesh",
  "accounts",
];

/** `talon events [-f] [--history [N]]` → the tail options. */
function eventsOptions(args: string[]): {
  follow: boolean;
  history?: number;
} {
  const historyAt = args.findIndex((a) => a === "--history");
  const next = historyAt >= 0 ? Number(args[historyAt + 1]) : NaN;
  return {
    follow: args.includes("-f") || args.includes("--follow"),
    ...(historyAt >= 0
      ? { history: Number.isInteger(next) && next > 0 ? next : 100 }
      : {}),
  };
}

/** The `talon --help` sheet. Its own function: `runCli` is a router. */
function printHelp(): void {
  printBanner();
  console.log("  Usage: talon [command]\n");
  console.log("  Commands:");
  console.log(`    ${pc.cyan("setup")}      Guided setup wizard`);
  console.log(`    ${pc.cyan("start")}      Start as background daemon`);
  console.log(`    ${pc.cyan("stop")}       Stop the daemon`);
  console.log(`    ${pc.cyan("restart")}    Restart the daemon`);
  console.log(`    ${pc.cyan("run")}        Run in foreground (attached)`);
  console.log(`    ${pc.cyan("chat")}       Terminal chat mode`);
  console.log(`    ${pc.cyan("status")}     Show bot health`);
  console.log(
    `    ${pc.cyan("ps")}         List agent tasks (--all includes journal history)`,
  );
  console.log(`    ${pc.cyan("kill")}       Abort a killable task by id`);
  console.log(
    `    ${pc.cyan("events")}     Tail the event bus (-f follows, --history [N] reads the journal)`,
  );
  console.log(
    `    ${pc.cyan("plugin")}     Manage plugins (install/enable/disable)`,
  );
  console.log(
    `    ${pc.cyan("skill")}      Manage skills (install/enable/disable)`,
  );
  console.log(
    `    ${pc.cyan("memory")}     Read/edit the memory store (list/search/import/render)`,
  );
  console.log(
    `    ${pc.cyan("history")}    Chat history kept by Talon (show/hidden/purge)`,
  );
  console.log(
    `    ${pc.cyan("backup")}     Snapshots and checkpoints (now/list/show/pin/restore)`,
  );
  console.log(
    `    ${pc.cyan("mesh")}       Device credentials + command audit (list/revoke/rotate/scopes/audit)`,
  );
  console.log(
    `    ${pc.cyan("accounts")}   Claude accounts (list/add/remove/login)`,
  );
  console.log(`    ${pc.cyan("config")}     View/edit configuration`);
  console.log(
    `    ${pc.cyan("logs")}       Tail log file (--errors, --since 1h, --component, --grep, --turn)`,
  );
  console.log(`    ${pc.cyan("doctor")}     Validate environment`);
  console.log(`    ${pc.cyan("--version")}  Print the package version`);
  console.log();
  console.log(`  Run ${pc.cyan("talon")} with no args for interactive menu.\n`);
}

/** Route a `talon <command>` invocation. Called by the entry point. */
export async function runCli(): Promise<void> {
  const command = process.argv[2];
  try {
    await dispatch(command);
  } catch (err) {
    // A present-but-invalid config.json: say so and exit non-zero, rather
    // than a stack trace — or, for the main menu, a first-run wizard that
    // would save defaults over the operator's real file.
    if (err instanceof ConfigFileError) {
      console.error(`\n  ${pc.red("✖")} ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

type CommandHandler = (args: string[]) => void | Promise<void>;

/** Every `talon <command>`, keyed by name. Handlers get the argv after the command. */
const COMMANDS: Record<string, CommandHandler> = {
  setup: () => runSetup(),
  status: () => showStatus(),
  config: () => viewConfig(),
  logs: (args) => runLogsCommand(args),
  start: async () => {
    printBanner();
    await daemonStart();
  },
  stop: async () => {
    printBanner();
    await daemonStop();
  },
  restart: async () => {
    printBanner();
    await daemonRestart();
  },
  run: () => {
    process.chdir(PKG_ROOT);
    void import("../index.js");
  },
  chat: () => {
    process.chdir(PKG_ROOT);
    startChat();
  },
  doctor: () => runDoctor(),
  ps: (args) => showTasks(args[0] === "--all" || args[0] === "-a"),
  kill: (args) => killTask(args[0]),
  events: (args) => showEvents(eventsOptions(args)),
  backup: (args) => runBackupCommand(args),
  mesh: (args) => runMeshCommand(args),
  accounts: (args) => runAccountsCommand(args),
  plugin: (args) => runPluginCommand(args),
  skill: (args) => runSkillCommand(args),
  memory: (args) => runMemoryCommand(args),
  history: (args) => runHistoryCommand(args),
  "--version": () => console.log(pkg.version),
  "-v": () => console.log(pkg.version),
  "--help": () => printHelp(),
  "-h": () => printHelp(),
};

async function unknownCommand(command: string): Promise<never> {
  // "did you mean ...?" via the native similarity core (native/strsim-wasm).
  const { closestMatch } = await import("../native/strsim.js");
  const suggestion = closestMatch(command, CLI_COMMANDS);
  const hint = suggestion
    ? `Did you mean ${pc.cyan(`talon ${suggestion.value}`)}?`
    : `Run ${pc.cyan("talon --help")} for usage.`;
  console.error(`  Unknown command: ${command}\n  ${hint}\n`);
  process.exit(1);
}

async function dispatch(command: string | undefined): Promise<void> {
  if (command === undefined) {
    await mainMenu();
    return;
  }
  const handler = Object.hasOwn(COMMANDS, command)
    ? COMMANDS[command]
    : undefined;
  if (!handler) return unknownCommand(command);
  await handler(process.argv.slice(3));
}
