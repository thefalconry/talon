/**
 * `/memory` — the Telegram read of the typed memory store.
 *
 * Covers the four shapes (list / search / why / kind), the three empty
 * cases (nothing remembered, no search hit, unknown id), the bad-kind
 * reply, and the thing that breaks a listing in production: a row whose
 * text contains HTML-special characters. Every line reaches an
 * HTML-parsed send, so an unescaped `<` in one remembered claim would
 * 400 the whole command — the same bug class as `/plugins` and the
 * model menu.
 *
 * Runs against the real (per-worker throwaway) SQLite store, so the
 * subject of every case is unique — the database is shared across the
 * tests in this file.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Bot } from "grammy";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { registerMemoryCommand } from "../frontend/telegram/commands/memory.js";
import { setAdminUserId } from "../frontend/telegram/commands/state.js";

const ADMIN = 111;
setAdminUserId(ADMIN);
import { assertMemory, supersedeMemory } from "../storage/memory.js";

let seq = 0;
/** Unique subject per test — the worker-shared DB persists across tests. */
function freshSubject(): string {
  return `tg-mem-${++seq}-${Date.now()}`;
}

type Reply = { text: string; opts?: { parse_mode?: string } };

function captureHandler(): (ctx: unknown) => Promise<void> {
  let handler: ((ctx: unknown) => Promise<void>) | undefined;
  const bot = {
    command: (name: string, fn: (ctx: unknown) => Promise<void>) => {
      if (name === "memory") handler = fn;
    },
  } as unknown as Bot;
  registerMemoryCommand(bot);
  return handler!;
}

/** Run `/memory <arg>` and return the replies it produced. */
async function runMemory(
  arg: string,
  who: { fromId?: number; chatId?: number; chatType?: string } = {},
): Promise<Reply[]> {
  const replies: Reply[] = [];
  const fromId = who.fromId ?? ADMIN;
  const ctx = {
    chat: { id: who.chatId ?? fromId, type: who.chatType ?? "private" },
    from: { id: fromId, first_name: "T" },
    match: arg,
    reply: async (text: string, opts?: { parse_mode?: string }) => {
      replies.push({ text, opts });
    },
  };
  await captureHandler()(ctx);
  return replies;
}

/** The whole reply as one string (the helper chunks long listings). */
async function memoryText(arg: string): Promise<string> {
  const replies = await runMemory(arg);
  for (const reply of replies) expect(reply.opts?.parse_mode).toBe("HTML");
  return replies.map((r) => r.text).join("");
}

let subject: string;
beforeEach(() => {
  subject = freshSubject();
});

describe("/memory with an empty store", () => {
  // Declared first on purpose: the per-file throwaway database starts
  // empty, and every case below writes to it.
  it("says nothing is remembered yet", async () => {
    expect(await memoryText("")).toBe("Nothing remembered yet.");
  });
});

describe("/memory listing", () => {
  it("lists live rows, one line each", async () => {
    const { id } = assertMemory({
      kind: "directive",
      subject,
      text: `Deploy on ${subject} only`,
      trust: "operator",
      salience: 99,
    });
    const text = await memoryText("");
    expect(text).toContain(`#${id} [directive] ${subject}:`);
    expect(text).toContain(`Deploy on ${subject} only`);
  });

  it("escapes HTML-special characters in a row's text", async () => {
    assertMemory({
      kind: "fact",
      subject,
      text: `Ops & <diagnostics> for ${subject}`,
      trust: "operator",
      salience: 99,
    });
    const text = await memoryText("");
    expect(text).not.toContain("<diagnostics>");
    expect(text).toContain("&lt;diagnostics&gt;");
    expect(text).toContain("&amp;");
  });

  it("says so when a kind holds nothing", async () => {
    const text = await memoryText("kind reflection");
    expect(text).toBe("Nothing remembered under reflection.");
  });
});

describe("/memory search", () => {
  it("returns the matching rows", async () => {
    const { id } = assertMemory({
      kind: "fact",
      subject,
      text: `The kestrel roosts at ${subject}`,
      trust: "operator",
    });
    const text = await memoryText("kestrel");
    expect(text).toContain(`#${id}`);
    expect(text).toContain("kestrel roosts");
  });

  it("reports a miss with the query quoted back", async () => {
    // The quotes are entity-escaped like everything else in an
    // HTML-parsed send; Telegram renders them back as " .
    const text = await memoryText("zzznotarealtoken");
    expect(text).toBe("No memories matching &quot;zzznotarealtoken&quot;.");
  });

  it("escapes the query in the miss message", async () => {
    const text = await memoryText("<script>");
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });
});

describe("/memory kind", () => {
  it("narrows the listing to one kind", async () => {
    assertMemory({
      kind: "episode",
      subject,
      text: `Something happened at ${subject}`,
      trust: "agent",
      salience: 99,
    });
    const text = await memoryText("kind episode");
    expect(text).toContain(`[episode] ${subject}`);
    expect(text).not.toContain("[directive]");
  });

  it("lists the valid kinds for a bad one", async () => {
    const text = await memoryText("kind nonsense");
    expect(text).toContain("No such kind &quot;nonsense&quot;");
    expect(text).toContain("directive, fact, state, episode");
  });
});

describe("/memory why", () => {
  it("shows the row, its ranking numbers and its audit trail", async () => {
    const { id } = assertMemory({
      kind: "fact",
      subject,
      text: `First claim about ${subject}`,
      trust: "operator",
      confidence: 0.5,
    });
    supersedeMemory(id, `Second claim about ${subject}`, "it changed");

    const text = await memoryText(`why ${id}`);
    expect(text).toContain(`#${id}`);
    expect(text).toContain("trust operator");
    expect(text).toContain("confidence 0.5");
    expect(text).toContain("hits 0");
    expect(text).toContain("salience 0");
    expect(text).toContain("created ");
    expect(text).toContain("last seen ");
    expect(text).toContain("<b>History</b>");
    expect(text).toContain("assert");
    expect(text).toContain("supersede — it changed");
  });

  it("reports an unknown id", async () => {
    const text = await memoryText("why 987654321");
    expect(text).toBe("No memory with id 987654321.");
  });
});

describe("/memory access", () => {
  it("refuses a non-admin in a DM", async () => {
    const replies = await runMemory("", { fromId: 999 });
    expect(replies.map((r) => r.text).join("")).toBe("Not authorized.");
  });

  it("refuses a non-admin in a group, without hinting at DMs", async () => {
    const replies = await runMemory("", {
      fromId: 999,
      chatId: -1002193667550,
      chatType: "supergroup",
    });
    expect(replies.map((r) => r.text).join("")).toBe("Not authorized.");
  });

  it("refuses even the admin in a group — every member would see it", async () => {
    const replies = await runMemory("", {
      chatId: -1002193667550,
      chatType: "supergroup",
    });
    expect(replies.map((r) => r.text).join("")).toMatch(/DM/);
  });
});
