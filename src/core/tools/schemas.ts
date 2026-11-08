/**
 * Shared zod schema fragments for tool input definitions.
 */

import { z } from "zod";

/**
 * Telegram-style positive integer ID (message_id, user_id, reply_to,
 * offset_id, etc.).
 *
 * Accepts:
 *   - actual numbers that are positive integers (`2081`)
 *   - digit-only strings (`"2081"`) which are transformed into numbers
 *
 * Rejects:
 *   - non-numeric strings (`"abc"`, `"2081abc"`, `""`, `"   "`)
 *   - booleans, `null`, `undefined` (would otherwise coerce to 0/1)
 *   - non-integer numbers (`1.5`)
 *   - zero and negatives
 *
 * Use this instead of `z.number()` or `z.coerce.number()` for any ID
 * field on tool input schemas. The plain coercion path was too lax —
 * `z.coerce.number().int()` happily turns `null`/`""` into `0` and
 * `true` into `1`, both of which the Telegram bot API would then
 * dispatch to. The strict union avoids that.
 */
export const idSchema = z.union([
  z.number().int().positive(),
  z
    .string()
    .regex(/^\d+$/, "must be a positive integer")
    .transform((s) => Number(s))
    .pipe(z.number().int().positive()),
]);

/**
 * Telegram-style chat ID. Unlike message/user IDs, chat IDs can be
 * NEGATIVE: supergroups and channels use `-100xxxxxxxxxx`, basic
 * groups use `-xxxxxxxxxx`, and private chats / DMs use the
 * positive user ID. Zero is never a valid chat ID and is the
 * sentinel the gateway already treats as falsy/unrouted.
 *
 * Accepts:
 *   - actual non-zero integer numbers (`424242420`, `-1009876543210`)
 *   - integer strings with optional leading minus (`"-1009876543210"`)
 *
 * Rejects:
 *   - zero (`0`, `"0"`, `"-0"`)
 *   - non-integer numbers (`1.5`)
 *   - non-numeric strings, booleans, null, undefined
 *
 * Use this for `chat_id` fields on tool input schemas. The bare
 * `idSchema` is for message/user/reply IDs (always positive) and
 * would reject the negative IDs Telegram uses for groups/channels
 * before the gateway ever sees the request.
 */
const nonZeroInt = z
  .number()
  .int()
  .refine((n) => n !== 0, "chat_id cannot be zero");

export const chatIdSchema = z.union([
  nonZeroInt,
  z
    .string()
    .regex(/^-?\d+$/, "must be an integer (negative for supergroups)")
    .transform((s) => Number(s))
    .pipe(nonZeroInt),
]);

/**
 * Snowflake-or-numeric ID schema. Accepts either:
 *   - a positive integer (Telegram-style numeric IDs, up to 2^53)
 *   - a digit-only string (Discord snowflakes — 17–19 digits exceed
 *     2^53, so they must stay as strings: `Number(snowflake)` rounds
 *     silently to the nearest float and drops the last digit, after
 *     which Discord's REST API rejects the result as "Unknown Message")
 *
 * No transform to number — the string passes through to the bridge
 * untouched. Frontend action handlers coerce with `String(...)` anyway,
 * so the loose union is safe for both Telegram and Discord call sites.
 *
 * Use this for `message_id` / `user_id` / `reply_to` / `offset_id` on
 * tool input schemas whose tool definition includes "discord" in its
 * `frontends:[]` list. The strict `idSchema` is still appropriate for
 * Telegram-only tools.
 */
// STRING-typed on purpose. Discord snowflakes are 17–19 digits and exceed 2^53,
// so an unquoted JSON number loses precision at parse time and Zod's `.int()`
// rejects it as too_big. A `union([number, string])` generates an `anyOf` JSON
// schema, so the model still passes a (corrupt) number — a description hint
// isn't enough to stop it. `z.coerce.string()` generates a `{ type: "string" }`
// schema, so the model quotes the ID (exact digits survive), while still
// accepting a number at runtime by coercing it to a string. Everything is
// normalized to a digit-string at the boundary; the bridge/handlers consume the
// string directly (Discord) or `Number()` it (Telegram).
export const snowflakeOrIdSchema = z.coerce
  .string()
  .regex(/^[1-9]\d*$/, "must be a positive integer")
  .describe(
    'ID as a string, e.g. "1497549923779084388". Discord IDs exceed the JS ' +
      "safe-integer range, so pass them double-quoted to preserve precision.",
  );
