/**
 * Slash commands on the native bridge.
 *
 * `/send` hands every message here first. Text that names one of the
 * commands in definitions.ts is answered by the daemon — the command and
 * its reply land in the chat as ordinary messages, persisted like
 * WhatsApp's so a reload keeps them — and never reaches the model. Any
 * other text, including `/something` that is not ours, returns false and
 * runs a turn exactly as before.
 *
 * Commands run even while a turn is in flight (that is what `/stop` is
 * for) and are never queued behind one.
 */

import { logError } from "../../../util/log.js";
import type { ChatEntry } from "../chats/chats.js";
import type { NativeRuntime } from "../runtime.js";
import { emitNotice, emitUser } from "../turn/emit.js";
import { adminCommands } from "./admin.js";
import { backupCommand } from "./backup.js";
import { secretCommandReply } from "../../../core/secrets/index.js";
import { findNativeCommand, type NativeCommandName } from "./definitions.js";
import { infoCommands } from "./info.js";
import { sessionCommands } from "./session.js";
import type { NativeCommandContext, NativeCommandHandler } from "./types.js";

export { listNativeCommands } from "./definitions.js";

const HANDLERS: Record<NativeCommandName, NativeCommandHandler> = {
  ...infoCommands,
  ...sessionCommands,
  ...adminCommands,
  backup: backupCommand,
  // Native chats are one operator's own surface: never a group.
  secret: async (ctx) =>
    ctx.reply(
      secretCommandReply({
        arg: ctx.arg,
        chatKey: ctx.entry.id,
        frontend: "native",
        isOperator: ctx.operator,
        isGroup: false,
      }),
    ),
};

export type ParsedNativeCommand = { name: NativeCommandName; arg: string };

/**
 * Parse a slash command out of message text. Null for anything that is
 * not one of ours — a path (`/etc/hosts`), a fraction, an unknown `/foo`.
 */
export function parseNativeCommand(text: string): ParsedNativeCommand | null {
  const match = /^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const def = findNativeCommand(match[1]!.toLowerCase());
  if (!def) return null;
  return {
    name: def.name as NativeCommandName,
    arg: (match[2] ?? "").trim(),
  };
}

/** Who sent the command, as far as authorisation is concerned. */
export type NativeCommandCaller = {
  /** The bridge credential holds the `operator` scope. */
  operator: boolean;
};

async function runCommand(
  runtime: NativeRuntime,
  entry: ChatEntry,
  cmd: ParsedNativeCommand,
  caller: NativeCommandCaller,
): Promise<void> {
  const ctx: NativeCommandContext = {
    runtime,
    entry,
    arg: cmd.arg,
    operator: caller.operator,
    deps: { config: runtime.config, gateway: runtime.gateway },
    reply: (text) => {
      emitNotice(runtime, entry, text);
    },
  };
  if (findNativeCommand(cmd.name)?.admin && !caller.operator) {
    ctx.reply(
      `Not authorized — \`/${cmd.name}\` needs an operator credential, and this device's credential does not have that scope.`,
    );
    return;
  }
  try {
    await HANDLERS[cmd.name](ctx);
  } catch (err) {
    logError("native", `/${cmd.name} failed`, err);
    ctx.reply(
      `⚠️ /${cmd.name} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Handle `text` as a slash command if it is one. True when it was — the
 * caller then skips the agent turn. The command runs in the background:
 * `/send` is fire-and-forget, and replies stream back as `message` events.
 */
export function handleNativeCommand(
  runtime: NativeRuntime,
  entry: ChatEntry,
  text: string,
  caller: NativeCommandCaller,
): boolean {
  const cmd = parseNativeCommand(text);
  if (!cmd) return false;
  emitUser(runtime, entry, text.trim(), [], { autoTitle: false });
  void runCommand(runtime, entry, cmd, caller);
  return true;
}
