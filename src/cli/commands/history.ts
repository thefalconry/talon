/**
 * `talon history` — the operator's view of chat history the daemon keeps.
 *
 * Talon never deletes chat history on its own: /reset is a soft reset
 * (a context marker), backend switches leave history alone, and deleting a
 * chat in the app only hides it. `purge` is the one way to delete rows for
 * real — host access only (it is not reachable from any chat), and it asks
 * for the chat id to be typed back before touching anything.
 */

import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import {
  getChatHistoryState,
  getHistoryStats,
  listHiddenChats,
  purgeChatHistory,
} from "../../storage/history.js";
import { clearTurnMeta } from "../../storage/turn-meta.js";

const USAGE = [
  `  Usage: ${pc.cyan("talon history <command>")}`,
  "",
  "  Commands:",
  `    ${pc.cyan("show <chatId>")}           Row count, date range, reset/hidden state`,
  `    ${pc.cyan("hidden")}                  Chats deleted in a client (rows kept)`,
  `    ${pc.cyan("purge <chatId> [--yes]")}  PERMANENTLY delete a chat's history`,
  "",
  "  Resets, backend switches and chat deletion never delete history;",
  `  ${pc.cyan("purge")} is the only command that does. Take a checkpoint first:`,
  `  ${pc.cyan('talon backup now --checkpoint "before purge"')}`,
  "",
].join("\n");

/** Reads one line from stdin; injectable so tests can answer the prompt. */
export type HistoryCliIo = {
  ask: (question: string) => Promise<string>;
  print: (line: string) => void;
};

const defaultIo: HistoryCliIo = {
  ask: async (question) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  print: (line) => console.log(line),
};

function date(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString() : "—";
}

function cmdShow(chatId: string, io: HistoryCliIo): void {
  const stats = getHistoryStats(chatId);
  const state = getChatHistoryState(chatId);
  io.print(`  ${pc.bold(chatId)}`);
  io.print(
    `    ${stats.totalMessages} message(s), ${stats.uniqueUsers} sender(s), ` +
      `${date(stats.oldestTimestamp || undefined)} → ${date(stats.newestTimestamp || undefined)}`,
  );
  if (state?.clearedAt !== undefined) {
    io.print(`    context reset at ${date(state.clearedAt)} (rows kept)`);
  }
  if (state?.hiddenAt !== undefined) {
    io.print(`    deleted in a client at ${date(state.hiddenAt)} (rows kept)`);
  }
  io.print("");
}

function cmdHidden(io: HistoryCliIo): void {
  const chats = listHiddenChats();
  if (chats.length === 0) {
    io.print(`  ${pc.dim("No hidden chats.")}\n`);
    return;
  }
  for (const chat of chats) {
    io.print(
      `  ${pc.bold(chat.chatId)}  ${chat.total} message(s)  ${pc.dim(`hidden ${date(chat.hiddenAt)}`)}`,
    );
  }
  io.print("");
}

/**
 * Delete a chat's history for good. Without `--yes` the operator must type
 * the chat id back; anything else aborts. Returns rows deleted (0 when
 * aborted or empty).
 */
async function cmdPurge(
  chatId: string,
  yes: boolean,
  io: HistoryCliIo,
): Promise<number> {
  const { totalMessages } = getHistoryStats(chatId);
  if (totalMessages === 0 && getChatHistoryState(chatId) === undefined) {
    io.print(`  ${pc.dim(`No history stored for ${chatId}.`)}\n`);
    return 0;
  }
  if (!yes) {
    io.print(
      `\n  This PERMANENTLY deletes ${pc.bold(String(totalMessages))} message(s) of chat ${pc.bold(chatId)}.\n` +
        `  It cannot be undone except from a backup. Take a checkpoint first:\n` +
        `    ${pc.cyan('talon backup now --checkpoint "before purge"')}\n`,
    );
    const answer = (await io.ask(`  Type the chat id to confirm: `)).trim();
    if (answer !== chatId) {
      io.print(`  ${pc.yellow("●")} Aborted — nothing deleted.\n`);
      return 0;
    }
  }
  const deleted = purgeChatHistory(chatId);
  clearTurnMeta(chatId);
  io.print(`  ${pc.green("●")} Purged ${deleted} message(s) from ${chatId}.\n`);
  return deleted;
}

/** Route a `talon history <command>` invocation. */
export async function runHistoryCommand(
  args: readonly string[],
  io: HistoryCliIo = defaultIo,
): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const yes = args.includes("--yes");
  const chatId = positional[1];
  try {
    switch (positional[0]) {
      case "show":
        if (!chatId) io.print(`  ${pc.red("✖")} show needs a chat id\n`);
        else cmdShow(chatId, io);
        break;
      case "hidden":
        cmdHidden(io);
        break;
      case "purge":
        if (!chatId) io.print(`  ${pc.red("✖")} purge needs a chat id\n`);
        else await cmdPurge(chatId, yes, io);
        break;
      default:
        io.print(USAGE);
    }
  } catch (err) {
    io.print(`  ${pc.red("✖")} ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
