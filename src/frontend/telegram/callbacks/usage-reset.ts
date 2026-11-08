/**
 * `ureset:*` callbacks — spending a banked usage-limit reset from /usage.
 *
 *   ureset:ask:<backend>  show the confirmation for that backend's next grant
 *   ureset:ok:<token>     spend it (or retry an unconfirmed claim)
 *   ureset:no:<token>     drop the confirmation
 *
 * A reset is one-off and belongs to the operator, so every step is gated on
 * the configured admin in a private chat, and nothing is spent without the
 * explicit Confirm press. The confirmation's idempotency key is minted once
 * and reused by every retry of it, and a press that lands while a claim is
 * in flight is ignored — a double tap can never spend two resets.
 */

import { randomBytes } from "node:crypto";
import type { Context } from "grammy";
import type {
  BankedResetClaim,
  BankedResetControl,
  BankedResetOffer,
} from "../../../core/agent-runtime/capabilities.js";
import { getPooledBackend } from "../../../core/engine/backend-controller/index.js";
import type { BackendUsageEntry } from "../../presentation/plan-usage-report.js";
import { formatSmartTimestamp } from "../../../util/time.js";
import { escapeHtml } from "../formatting.js";
import { isConfiguredAdmin } from "../commands/state.js";
import { answerCallbackQuerySafe } from "./query.js";

type Button = { text: string; callback_data: string };

const PENDING_TTL_MS = 10 * 60_000;
const RETRYABLE: ReadonlySet<BankedResetClaim["result"]> = new Set([
  "unavailable",
  "rate_limited",
  "error",
]);

interface Pending {
  chatId: number;
  userId: number;
  backendId: string;
  grantId: string;
  /** Idempotency key: one per confirmation, shared by all its retries. */
  requestId: string;
  clears: string[];
  claiming: boolean;
  /** A claim was sent and its outcome is unconfirmed. */
  attempted: boolean;
  createdAt: number;
}

const pending = new Map<string, Pending>();

function newToken(): string {
  return randomBytes(6).toString("hex");
}

function newRequestId(): string {
  return randomBytes(16).toString("hex");
}

/** Test hook: forget every open confirmation. */
export function resetUsageResetState(): void {
  pending.clear();
}

/** Who may spend a reset: the configured admin, in a DM. */
export function canUseReset(ctx: Context): boolean {
  return isConfiguredAdmin(ctx) && ctx.chat?.type === "private";
}

function controlFor(backendId: string): BankedResetControl | undefined {
  return getPooledBackend(backendId)?.usage?.bankedResets;
}

/**
 * The "Use a reset" row for a /usage reply, or undefined when this viewer
 * mustn't see it or no backend has a reset to spend.
 */
export function usageResetKeyboard(
  ctx: Context,
  entries: BackendUsageEntry[],
): Button[][] | undefined {
  if (!canUseReset(ctx)) return undefined;
  const offers = entries.filter(
    (e) => (e.plan?.resetsAvailable ?? 0) > 0 && controlFor(e.id),
  );
  if (offers.length === 0) return undefined;
  return offers.map((e) => [
    {
      text: offers.length === 1 ? "Use a reset" : `Use a ${e.label} reset`,
      callback_data: `ureset:ask:${e.id}`,
    },
  ]);
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_overage_included: "weekly (incl. overage)",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
};

function windowName(key: string): string {
  return WINDOW_NAMES[key] ?? key.replace(/_/g, " ");
}

function when(iso: string | undefined): string | undefined {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? formatSmartTimestamp(t) : undefined;
}

function plural(n: number): string {
  return `${n} reset${n === 1 ? "" : "s"}`;
}

/** The confirmation text for spending `offer`. */
export function renderResetConfirmation(
  offer: BankedResetOffer,
  now = Date.now(),
): string {
  const { grant } = offer;
  const lines = [
    "<b>Use a usage-limit reset?</b>",
    `<i>${escapeHtml(grant.label)}</i>`,
    "",
  ];
  if (grant.clears.length > 0) {
    lines.push(`Clears: ${grant.clears.map(windowName).join(", ")}`);
    const current = grant.clears
      .filter((k) => grant.percentUsed[k] !== undefined)
      .map((k) => `${windowName(k)} ${grant.percentUsed[k]}%`);
    if (current.length > 0) lines.push(`Right now: ${current.join(" · ")}`);
  }
  const by = when(grant.endsAt);
  if (by) lines.push(`Use by: ${escapeHtml(by)}`);
  lines.push(`Resets left: ${offer.totalResetsLeft}`);

  const warnings: string[] = [];
  if (grant.useRequiresLimit && !offer.atLimit)
    warnings.push(
      "⚠️ This reset only works while you're at a limit, and you aren't — " +
        "the claim will be refused and the reset kept.",
    );
  const cooldown = offer.cooldownUntil ? Date.parse(offer.cooldownUntil) : NaN;
  if (Number.isFinite(cooldown) && cooldown > now)
    warnings.push(
      `⚠️ A cooldown is running until ${escapeHtml(when(offer.cooldownUntil) ?? "")} — ` +
        "the claim will likely be refused.",
    );
  if (warnings.length > 0) lines.push("", ...warnings);
  lines.push("", "This spends a one-off reset and can't be undone.");
  return lines.join("\n");
}

/** A claim's outcome in plain words. */
export function describeClaim(
  claim: BankedResetClaim,
  clears: string[] = [],
): string {
  const left =
    claim.resetsLeft !== undefined ? ` ${plural(claim.resetsLeft)} left.` : "";
  const cleared = claim.cleared.length > 0 ? claim.cleared : clears;
  switch (claim.result) {
    case "reset":
      return (
        "✅ Reset used — " +
        (cleared.length > 0
          ? `your ${cleared.map(windowName).join(", ")} limits are clear again.`
          : "your limits are clear again.") +
        left
      );
    case "already_used":
      return `That reset was already used, so nothing more was spent.${left}`;
    case "not_limited":
      return "Nothing to reset — you aren't at a limit, and this reset only works when you are. It's still banked.";
    case "cooldown": {
      const until = when(claim.cooldownUntil);
      return `A reset was used recently, so this one is on cooldown${until ? ` until ${escapeHtml(until)}` : ""}. Nothing was spent.`;
    }
    case "ineligible":
      return `This account can't use that reset right now${claim.reason ? ` (${escapeHtml(claim.reason)})` : ""}. Nothing was spent.`;
    case "rate_limited":
      return "Too many attempts — wait a minute, then tap Retry. The retry reuses this request, so it can't spend twice.";
    case "auth_error":
      return "Couldn't sign in to Claude with the stored credentials, so nothing was sent.";
    default:
      return "Couldn't confirm whether the reset went through. Tap Retry — it reuses the same request, so it can't spend twice.";
  }
}

function confirmKeyboard(token: string, retry = false): Button[][] {
  return [
    [
      {
        text: retry ? "Retry" : "Confirm",
        callback_data: `ureset:ok:${token}`,
      },
      { text: "Cancel", callback_data: `ureset:no:${token}` },
    ],
  ];
}

/**
 * Look up what a claim would spend and reply with the confirmation. Shared
 * by the /usage button and `/usage reset`.
 */
export async function sendResetConfirmation(
  ctx: Context,
  backendId: string,
): Promise<void> {
  const control = controlFor(backendId);
  const offer = await control?.getOffer().catch(() => undefined);
  if (!offer) {
    await ctx.reply("No usage-limit reset is available to use right now.");
    return;
  }
  const chatId = ctx.chat?.id ?? 0;
  // One open confirmation per chat: a newer one retires the older buttons.
  for (const [token, p] of pending)
    if (p.chatId === chatId && !p.claiming) pending.delete(token);
  const token = newToken();
  pending.set(token, {
    chatId,
    userId: ctx.from?.id ?? 0,
    backendId,
    grantId: offer.grant.id,
    requestId: newRequestId(),
    clears: offer.grant.clears,
    claiming: false,
    attempted: false,
    createdAt: Date.now(),
  });
  await ctx.reply(renderResetConfirmation(offer), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: confirmKeyboard(token) },
  });
}

function live(token: string, ctx: Context): Pending | undefined {
  const p = pending.get(token);
  if (!p) return undefined;
  if (Date.now() - p.createdAt > PENDING_TTL_MS && !p.claiming) {
    pending.delete(token);
    return undefined;
  }
  if (p.chatId !== ctx.chat?.id || p.userId !== ctx.from?.id) return undefined;
  return p;
}

async function confirm(ctx: Context, token: string): Promise<void> {
  const p = live(token, ctx);
  if (!p) {
    await answerCallbackQuerySafe(ctx, {
      text: "This confirmation has expired — run /usage again.",
    });
    return;
  }
  if (p.claiming) {
    await answerCallbackQuerySafe(ctx, { text: "Already on it…" });
    return;
  }
  p.claiming = true;
  await answerCallbackQuerySafe(ctx, { text: "Using the reset…" });
  await ctx.editMessageText("⏳ Using the reset…").catch(() => {});

  let claim: BankedResetClaim;
  try {
    const control = controlFor(p.backendId);
    claim = control
      ? await control.claim(p.grantId, p.requestId)
      : { result: "error", cleared: [] };
  } catch {
    claim = { result: "error", cleared: [] };
  }

  const text = describeClaim(claim, p.clears);
  if (RETRYABLE.has(claim.result)) {
    // Keep the confirmation (and its request id) so Retry is idempotent.
    p.claiming = false;
    p.attempted = true;
    await ctx
      .editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: confirmKeyboard(token, true) },
      })
      .catch(() => {});
    return;
  }
  pending.delete(token);
  await ctx.editMessageText(text, { parse_mode: "HTML" }).catch(() => {});
}

async function cancel(ctx: Context, token: string): Promise<void> {
  const p = live(token, ctx);
  if (p?.claiming) {
    await answerCallbackQuerySafe(ctx, { text: "Already being claimed." });
    return;
  }
  pending.delete(token);
  await answerCallbackQuerySafe(ctx, { text: "Cancelled." });
  await ctx
    .editMessageText(
      p?.attempted
        ? "Closed. If the last attempt went through, /usage will show one reset fewer."
        : "No reset used.",
    )
    .catch(() => {});
}

export async function handleUsageResetCallback(
  ctx: Context,
  data: string,
): Promise<void> {
  if (!canUseReset(ctx)) {
    await answerCallbackQuerySafe(ctx, { text: "Not authorized." });
    return;
  }
  const [, action, arg] = data.split(":");
  if (!arg || !/^[A-Za-z0-9_-]{1,40}$/.test(arg)) {
    await answerCallbackQuerySafe(ctx, { text: "Invalid callback data" });
    return;
  }
  if (action === "ask") {
    await answerCallbackQuerySafe(ctx);
    await sendResetConfirmation(ctx, arg);
    return;
  }
  if (action === "ok") return confirm(ctx, arg);
  if (action === "no") return cancel(ctx, arg);
  await answerCallbackQuerySafe(ctx, { text: "Invalid callback data" });
}
