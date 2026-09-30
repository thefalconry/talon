/**
 * `talon history purge` is the one path that deletes chat history: it is
 * operator-only (host CLI, unreachable from any chat) and asks for the
 * chat id to be typed back unless `--yes` is given.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { runHistoryCommand } from "../cli/commands/history.js";
import {
  getHistoryStats,
  hideChatHistory,
  markContextCleared,
  pushMessage,
} from "../storage/history.js";
import { getTurnMeta, recordTurnMeta } from "../storage/turn-meta.js";

let seq = 0;
function seeded(): string {
  const id = `purge-${process.pid}-${++seq}`;
  for (const msgId of [1, 2, 3]) {
    pushMessage(id, {
      msgId,
      senderId: 1,
      senderName: "Ada",
      text: `m${msgId}`,
      timestamp: Date.now(),
    });
  }
  return id;
}

function io(answer: string) {
  const lines: string[] = [];
  return {
    lines,
    ask: vi.fn(async () => answer),
    print: (line: string) => {
      lines.push(line);
    },
  };
}

describe("talon history purge", () => {
  it("aborts on anything but the chat id typed back", async () => {
    const id = seeded();
    for (const answer of ["", "yes", "y", `${id}x`]) {
      const cli = io(answer);
      await runHistoryCommand(["purge", id], cli);
      expect(cli.ask).toHaveBeenCalledOnce();
      expect(cli.lines.join("\n")).toContain("Aborted");
    }
    expect(getHistoryStats(id).totalMessages).toBe(3);
  });

  it("deletes the rows (and turn meta) once confirmed", async () => {
    const id = seeded();
    markContextCleared(id);
    recordTurnMeta(id, "3", { durationMs: 1 });
    const cli = io(id);
    await runHistoryCommand(["purge", id], cli);
    expect(cli.lines.join("\n")).toContain("PERMANENTLY deletes");
    expect(cli.lines.join("\n")).toContain("Purged 3 message(s)");
    expect(getHistoryStats(id).totalMessages).toBe(0);
    expect(getTurnMeta(id, "3")).toBeNull();
  });

  it("--yes skips the prompt", async () => {
    const id = seeded();
    const cli = io("");
    await runHistoryCommand(["purge", id, "--yes"], cli);
    expect(cli.ask).not.toHaveBeenCalled();
    expect(getHistoryStats(id).totalMessages).toBe(0);
  });

  it("needs a chat id", async () => {
    const cli = io("");
    await runHistoryCommand(["purge"], cli);
    expect(cli.lines.join("\n")).toContain("purge needs a chat id");
  });

  it("lists hidden chats and shows a chat's state", async () => {
    const id = seeded();
    hideChatHistory(id);
    const hidden = io("");
    await runHistoryCommand(["hidden"], hidden);
    expect(hidden.lines.join("\n")).toContain(id);
    const show = io("");
    await runHistoryCommand(["show", id], show);
    const out = show.lines.join("\n");
    expect(out).toContain("3 message(s)");
    expect(out).toContain("deleted in a client");
  });
});

describe("purge is reachable only from the operator CLI", () => {
  const SRC = join(import.meta.dirname, "..");

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === "__tests__" || name === "node_modules") return [];
      if (statSync(path).isDirectory()) return sources(path);
      return name.endsWith(".ts") ? [path] : [];
    });
  }

  it("no chat-facing module calls purgeChatHistory or the repo purge", () => {
    const callers = sources(SRC)
      .filter((path) =>
        /\bpurgeChatHistory\(|\brepo\.purgeChat\(|historySql\.purgeChat\b/.test(
          readFileSync(path, "utf8"),
        ),
      )
      .map((path) => relative(SRC, path).replaceAll("\\", "/"))
      .sort();
    expect(callers).toEqual([
      "cli/commands/history.ts",
      "storage/history.ts",
      "storage/repositories/history-repo.ts",
    ]);
  });
});
