/**
 * /usage "Use a reset" — who sees the button, and the confirm/cancel flow.
 * The backend control is a mock; nothing here can reach the claim endpoint.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Bot, Context } from "grammy";
import type {
  BankedResetClaim,
  BankedResetOffer,
} from "../core/agent-runtime/capabilities.js";
import type { BackendUsageEntry } from "../frontend/presentation/plan-usage-report.js";

const control = {
  getOffer: vi.fn<() => Promise<BankedResetOffer | undefined>>(),
  claim: vi.fn<(g: string, r: string) => Promise<BankedResetClaim>>(),
};
let pooled = true;

vi.mock("../core/engine/backend-controller/index.js", async (orig) => ({
  ...(await orig<object>()),
  getPooledBackend: (id: string) =>
    pooled && id === "claude" ? { usage: { bankedResets: control } } : null,
}));

const entries: BackendUsageEntry[] = [];
vi.mock("../frontend/presentation/plan-usage-report.js", () => ({
  collectPlanUsage: vi.fn(async () => entries),
}));

const {
  canUseReset,
  describeClaim,
  handleUsageResetCallback,
  renderResetConfirmation,
  resetUsageResetState,
  usageResetKeyboard,
} = await import("../frontend/telegram/callbacks/usage-reset.js");
const { setAdminUserId } =
  await import("../frontend/telegram/commands/state.js");
const { registerAdminCommands } =
  await import("../frontend/telegram/commands/admin.js");

const ADMIN = 111;
const OTHER = 222;

const OFFER: BankedResetOffer = {
  grant: {
    id: "opus55-launch",
    label: "Launch reset",
    resetsLeft: 1,
    endsAt: "2026-10-22T16:00:00Z",
    clears: ["five_hour", "seven_day"],
    percentUsed: { five_hour: 9, seven_day: 82 },
    useRequiresLimit: false,
  },
  atLimit: false,
  totalResetsLeft: 1,
};

function claudeEntry(resets: number | undefined): BackendUsageEntry {
  return {
    id: "claude",
    label: "Anthropic",
    plan: {
      plan: "max",
      windows: [],
      resetsAvailable: resets,
      ageLabel: undefined,
    },
    headroom: {} as BackendUsageEntry["headroom"],
    headroomLabel: "",
  };
}

type Ctx = Context & {
  reply: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  answerCallbackQuery: ReturnType<typeof vi.fn>;
};

function makeCtx(from = ADMIN, chatType = "private", match = ""): Ctx {
  return {
    chat: { id: from, type: chatType },
    from: { id: from, first_name: "T" },
    match,
    reply: vi.fn().mockResolvedValue({ message_id: 5 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
  } as unknown as Ctx;
}

/** The callback_data of the n-th button in the last reply. */
function lastButtons(ctx: Ctx): string[] {
  const opts = ctx.reply.mock.calls.at(-1)?.[1] as
    | { reply_markup?: { inline_keyboard: { callback_data: string }[][] } }
    | undefined;
  return (opts?.reply_markup?.inline_keyboard ?? [])
    .flat()
    .map((b) => b.callback_data);
}

async function openConfirmation(ctx: Ctx): Promise<{ ok: string; no: string }> {
  await handleUsageResetCallback(ctx, "ureset:ask:claude");
  const [ok, no] = lastButtons(ctx);
  return { ok: ok!, no: no! };
}

beforeEach(() => {
  resetUsageResetState();
  setAdminUserId(ADMIN);
  pooled = true;
  control.getOffer.mockReset().mockResolvedValue(OFFER);
  control.claim.mockReset();
  entries.length = 0;
});

describe("button visibility", () => {
  it("shows for the admin in a DM when a reset is banked", () => {
    expect(usageResetKeyboard(makeCtx(), [claudeEntry(1)])).toEqual([
      [{ text: "Use a reset", callback_data: "ureset:ask:claude" }],
    ]);
  });

  it("is hidden in groups, from non-admins, and without resets", () => {
    expect(
      usageResetKeyboard(makeCtx(ADMIN, "group"), [claudeEntry(1)]),
    ).toBeUndefined();
    expect(
      usageResetKeyboard(makeCtx(ADMIN, "supergroup"), [claudeEntry(1)]),
    ).toBeUndefined();
    expect(
      usageResetKeyboard(makeCtx(OTHER), [claudeEntry(1)]),
    ).toBeUndefined();
    expect(usageResetKeyboard(makeCtx(), [claudeEntry(0)])).toBeUndefined();
    expect(
      usageResetKeyboard(makeCtx(), [claudeEntry(undefined)]),
    ).toBeUndefined();
    pooled = false;
    expect(usageResetKeyboard(makeCtx(), [claudeEntry(1)])).toBeUndefined();
  });

  it("needs a configured admin — no admin id means nobody", () => {
    setAdminUserId(undefined);
    expect(canUseReset(makeCtx())).toBe(false);
  });

  it("/usage attaches the button only for the admin DM", async () => {
    const handlers: Record<string, (ctx: Context) => Promise<void>> = {};
    const bot = {
      command: (name: string, fn: (ctx: Context) => Promise<void>) => {
        handlers[name] = fn;
      },
      on: vi.fn(),
    } as unknown as Bot;
    registerAdminCommands(bot, { config: {} as never });
    entries.push(claudeEntry(1));

    const admin = makeCtx();
    await handlers.usage!(admin);
    expect(lastButtons(admin)).toEqual(["ureset:ask:claude"]);

    const group = makeCtx(ADMIN, "group");
    await handlers.usage!(group);
    expect(lastButtons(group)).toEqual([]);

    const other = makeCtx(OTHER);
    await handlers.usage!(other);
    expect(lastButtons(other)).toEqual([]);

    // Text form: same confirmation, same gate.
    const text = makeCtx(ADMIN, "private", "reset");
    await handlers.usage!(text);
    expect(String(text.reply.mock.calls[0]?.[0])).toContain(
      "Use a usage-limit reset?",
    );
    expect(lastButtons(text)[0]).toMatch(/^ureset:ok:/);

    const textGroup = makeCtx(ADMIN, "group", "reset");
    await handlers.usage!(textGroup);
    expect(String(textGroup.reply.mock.calls[0]?.[0])).toContain(
      "Only the admin",
    );
    expect(control.claim).not.toHaveBeenCalled();
  });
});

describe("confirmation", () => {
  it("names the grant, what it clears, the percentages and the deadline", () => {
    const text = renderResetConfirmation(
      OFFER,
      Date.parse("2026-09-24T00:00:00Z"),
    );
    expect(text).toContain("Launch reset");
    expect(text).toContain("Clears: 5-hour, weekly");
    expect(text).toContain("Right now: 5-hour 9% · weekly 82%");
    expect(text).toContain("Use by:");
    expect(text).not.toContain("⚠️");
  });

  it("warns when the reset needs a limit you aren't at, or a cooldown runs", () => {
    const text = renderResetConfirmation(
      {
        ...OFFER,
        grant: { ...OFFER.grant, useRequiresLimit: true },
        cooldownUntil: "2026-09-24T05:00:00Z",
      },
      Date.parse("2026-09-24T00:00:00Z"),
    );
    expect(text).toContain("only works while you're at a limit");
    expect(text).toContain("cooldown is running");
    expect(
      renderResetConfirmation({
        ...OFFER,
        grant: { ...OFFER.grant, useRequiresLimit: true },
        atLimit: true,
      }),
    ).not.toContain("⚠️");
  });

  it("says so when there is nothing to use", async () => {
    control.getOffer.mockResolvedValue(undefined);
    const ctx = makeCtx();
    await handleUsageResetCallback(ctx, "ureset:ask:claude");
    expect(ctx.reply).toHaveBeenCalledWith(
      "No usage-limit reset is available to use right now.",
    );
  });
});

describe("confirm and cancel", () => {
  it("Confirm claims the offered grant and reports the result", async () => {
    control.claim.mockResolvedValue({
      result: "reset",
      resetsLeft: 0,
      cleared: [],
    });
    const ctx = makeCtx();
    const { ok } = await openConfirmation(ctx);
    expect(control.claim).not.toHaveBeenCalled();
    await handleUsageResetCallback(ctx, ok);
    expect(control.claim).toHaveBeenCalledTimes(1);
    expect(control.claim.mock.calls[0]?.[0]).toBe("opus55-launch");
    expect(control.claim.mock.calls[0]?.[1]).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    const final = String(ctx.editMessageText.mock.calls.at(-1)?.[0]);
    expect(final).toContain("Reset used");
    expect(final).toContain("5-hour, weekly");
    expect(final).toContain("0 resets left");
  });

  it("Cancel spends nothing and retires the Confirm button", async () => {
    const ctx = makeCtx();
    const { ok, no } = await openConfirmation(ctx);
    await handleUsageResetCallback(ctx, no);
    expect(ctx.editMessageText).toHaveBeenLastCalledWith("No reset used.");
    await handleUsageResetCallback(ctx, ok);
    expect(control.claim).not.toHaveBeenCalled();
  });

  it("a double press while claiming sends one request", async () => {
    let finish!: (c: BankedResetClaim) => void;
    control.claim.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const ctx = makeCtx();
    const { ok } = await openConfirmation(ctx);
    const first = handleUsageResetCallback(ctx, ok);
    await handleUsageResetCallback(ctx, ok);
    finish({ result: "reset", cleared: [] });
    await first;
    expect(control.claim).toHaveBeenCalledTimes(1);
    // And a press after it settled doesn't claim again either.
    await handleUsageResetCallback(ctx, ok);
    expect(control.claim).toHaveBeenCalledTimes(1);
  });

  it("Retry after an unconfirmed claim reuses the same request_id", async () => {
    control.claim
      .mockResolvedValueOnce({ result: "unavailable", cleared: [] })
      .mockResolvedValueOnce({ result: "rate_limited", cleared: [] })
      .mockResolvedValueOnce({ result: "reset", cleared: [] });
    const ctx = makeCtx();
    const { ok } = await openConfirmation(ctx);
    await handleUsageResetCallback(ctx, ok);
    expect(String(ctx.editMessageText.mock.calls.at(-1)?.[0])).toContain(
      "Retry",
    );
    await handleUsageResetCallback(ctx, ok);
    await handleUsageResetCallback(ctx, ok);
    const ids = control.claim.mock.calls.map((c) => c[1]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
  });

  it("a new confirmation gets a new request_id and retires the old one", async () => {
    control.claim.mockResolvedValue({ result: "not_limited", cleared: [] });
    const ctx = makeCtx();
    const first = await openConfirmation(ctx);
    const second = await openConfirmation(ctx);
    await handleUsageResetCallback(ctx, first.ok);
    expect(control.claim).not.toHaveBeenCalled();
    await handleUsageResetCallback(ctx, second.ok);
    expect(control.claim).toHaveBeenCalledTimes(1);
  });

  it("refuses presses from a non-admin or in a group", async () => {
    const ctx = makeCtx();
    const { ok } = await openConfirmation(ctx);
    const intruder = makeCtx(OTHER);
    await handleUsageResetCallback(intruder, ok);
    await handleUsageResetCallback(makeCtx(ADMIN, "group"), ok);
    await handleUsageResetCallback(makeCtx(OTHER), "ureset:ask:claude");
    expect(intruder.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Not authorized.",
    });
    expect(control.claim).not.toHaveBeenCalled();
    expect(control.getOffer).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed callback data", async () => {
    const ctx = makeCtx();
    await handleUsageResetCallback(ctx, "ureset:ok:../../x");
    await handleUsageResetCallback(ctx, "ureset:ok:");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Invalid callback data",
    });
    expect(control.claim).not.toHaveBeenCalled();
  });
});

describe("describeClaim", () => {
  it.each<[BankedResetClaim["result"], string]>([
    ["reset", "Reset used"],
    ["already_used", "already used"],
    ["not_limited", "aren't at a limit"],
    ["cooldown", "cooldown"],
    ["ineligible", "can't use that reset"],
    ["unavailable", "Couldn't confirm"],
    ["rate_limited", "Too many attempts"],
    ["auth_error", "Couldn't sign in"],
    ["error", "Couldn't confirm"],
  ])("%s reads in plain words", (result, phrase) => {
    expect(describeClaim({ result, cleared: [] })).toContain(phrase);
  });
});
