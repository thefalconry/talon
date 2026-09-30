/**
 * The native bridge's slash commands — the single list `/help` prints,
 * `GET /commands` serves for client autocomplete, and the parser matches
 * against. A name not in this list is never intercepted: `/etc/hosts`,
 * `/shrug` or a typo reaches the model as ordinary text.
 *
 * `admin` marks what needs the `operator` scope — the same scope the
 * bridge demands for `POST /control` and `POST /config` — so a
 * client-only credential cannot restart the daemon or restore a snapshot
 * by typing what it could not POST.
 */

import type { ClientCommand } from "../protocol.js";

export const NATIVE_COMMANDS = [
  {
    name: "help",
    description: "All commands",
  },
  {
    name: "status",
    description: "Session info, context usage and stats",
  },
  {
    name: "settings",
    description: "This chat's model, backend, effort and pulse",
  },
  {
    name: "model",
    description: "List models; pick one or switch backend",
    args: "[<n>|<id>|<backend>|default|backend default]",
  },
  {
    name: "effort",
    description: "Show or set thinking effort",
    args: "[off|low|medium|high|max|adaptive]",
  },
  {
    name: "pulse",
    description: "Periodic check-ins: on, off, or an interval",
    args: "[on|off|<interval>]",
  },
  {
    name: "stop",
    description: "Stop the current response",
  },
  {
    name: "reset",
    description: "Clear the session and start fresh",
  },
  {
    name: "ping",
    description: "Health check",
  },
  {
    name: "usage",
    description: "Plan limits across every backend",
  },
  {
    name: "mesh",
    description: "Ping and list mesh devices",
  },
  {
    name: "plugins",
    description: "List loaded plugins",
  },
  {
    name: "memory",
    description: "What Talon remembers — list, search, why <id>",
    args: "[<query>|why <id>|kind <kind>]",
  },
  {
    name: "metrics",
    description: "Aggregate performance metrics",
    args: "[all]",
    admin: true,
  },
  {
    name: "doctor",
    description: "Environment and native-module health",
    admin: true,
  },
  {
    name: "dream",
    description: "Force memory consolidation",
    admin: true,
  },
  {
    name: "restart",
    description: "Restart the daemon",
    admin: true,
  },
  {
    name: "backup",
    description: "Snapshots and checkpoints; restore <id>",
    args: "[status|now|checkpoint <label>|list|show <id>|pin <id>|unpin <id>|restore <id>]",
    admin: true,
  },
] as const satisfies readonly ClientCommand[];

export type NativeCommandName = (typeof NATIVE_COMMANDS)[number]["name"];

/** The command list as the wire carries it (a fresh copy per call). */
export function listNativeCommands(): ClientCommand[] {
  return NATIVE_COMMANDS.map((c) => ({ ...c }));
}

/** The definition for a name, when it is one of ours. */
export function findNativeCommand(name: string): ClientCommand | undefined {
  return (NATIVE_COMMANDS as readonly ClientCommand[]).find(
    (c) => c.name === name,
  );
}
