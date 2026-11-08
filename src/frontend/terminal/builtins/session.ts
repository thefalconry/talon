/** `/reset`, `/resume`, `/rename` — session lifecycle. */

import pc from "picocolors";
import { formatRelativeAge } from "../../../util/time.js";
import { isTerminalChatId } from "../../../core/frontend-runtime/chat-id.js";
import { resolveModel as coreResolveModel } from "../../../core/models/catalog.js";
import {
  getAllSessions,
  getSession,
  setSessionName,
} from "../../../storage/sessions.js";
import type { Command } from "../command-registry.js";

export const resetCommand: Command = {
  name: "reset",
  description: "Start a fresh session",
  async handler(_args, ctx) {
    ctx.initNewChat();
    ctx.renderer.writeSystem("Session cleared.");
    ctx.reprompt();
  },
};

export const resumeCommand: Command = {
  name: "resume",
  description: "List & resume a past session",
  async handler(_args, ctx) {
    const sessions = getAllSessions()
      .filter(
        (s) =>
          isTerminalChatId(s.chatId) &&
          s.chatId !== ctx.chatId() &&
          s.info.turns > 0,
      )
      .sort((a, b) => b.info.lastActive - a.info.lastActive)
      .slice(0, 10);

    if (sessions.length === 0) {
      ctx.renderer.writeSystem("No previous sessions to resume.");
      ctx.reprompt();
      return;
    }

    ctx.renderer.writeln();
    ctx.renderer.writeln(`  ${pc.bold("Past sessions")}`);
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]!;
      const name = s.info.sessionName
        ? `"${s.info.sessionName}"`
        : pc.dim("(unnamed)");
      const turns = `${s.info.turns} turn${s.info.turns !== 1 ? "s" : ""}`;
      const ago = formatRelativeAge(s.info.lastActive);
      const model = s.info.lastModel
        ? (coreResolveModel(s.info.lastModel)?.displayName ?? s.info.lastModel)
        : "";
      ctx.renderer.writeln(
        `  ${pc.green(String(i + 1))}. ${name}  ${pc.dim(`${turns}  ·  ${ago}${model ? `  ·  ${model}` : ""}`)}`,
      );
    }
    ctx.renderer.writeln();
    ctx.renderer.writeln(
      `  ${pc.dim("Enter number to resume (Esc to cancel):")}`,
    );

    const input = await ctx.waitForInput();
    const num = parseInt(input, 10);
    if (num >= 1 && num <= sessions.length) {
      const selected = sessions[num - 1]!;
      ctx.initNewChat(selected.chatId);
      const name = selected.info.sessionName
        ? `"${selected.info.sessionName}"`
        : `(${selected.info.turns} turns)`;
      ctx.renderer.writeSystem(`Resumed: ${name}`);
    } else {
      ctx.renderer.writeSystem("Cancelled.");
    }
    ctx.reprompt();
  },
};

export const renameCommand: Command = {
  name: "rename",
  argHint: "[name]",
  description: "Name the current session",
  async handler(args, ctx) {
    // Ensure session exists in store (auto-creates if needed)
    getSession(ctx.chatId());
    if (!args) {
      const session = getSession(ctx.chatId());
      ctx.renderer.writeSystem(
        session.sessionName
          ? `Session name: "${session.sessionName}"`
          : "Session has no name.",
      );
    } else {
      setSessionName(ctx.chatId(), args);
      ctx.renderer.writeSystem(`Session renamed to "${args}"`);
    }
    ctx.reprompt();
  },
};
