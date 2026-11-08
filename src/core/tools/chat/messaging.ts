/**
 * Messaging tools — send, end_turn, react, edit, delete, forward, pin/unpin,
 * stop poll.
 */

import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { chatIdSchema, idSchema, snowflakeOrIdSchema } from "../schemas.js";

/**
 * Throw a typed Error when a bridge response reports failure
 * (`{ok: false, error: "..."}`).
 *
 * Used by turn-terminator tools (`end_turn`, strict `react`) so that delivery
 * failure surfaces as a real exception, fires `PostToolUseFailure` in the SDK
 * pipeline, and lets the SDK loop be preserved by the hook instead of
 * terminating silently while the model never gets to react.
 *
 * Non-terminator tools (`send`, `edit_message`, etc.) intentionally do NOT
 * use this — they return `{ok: false}` directly so the model can read the
 * failure as a regular tool result and decide what to do. The bug only bites
 * when the failing tool would otherwise short-circuit the SDK loop.
 */
function throwIfFailed(result: unknown, toolName: string): unknown {
  if (
    result != null &&
    typeof result === "object" &&
    (result as { ok?: unknown }).ok === false
  ) {
    const err = (result as { error?: unknown }).error;
    const msg = typeof err === "string" ? err : "delivery failed";
    throw new Error(`${toolName} delivery failed: ${msg}`);
  }
  return result;
}

export const messagingTools: ToolDefinition[] = [
  // ── end_turn — explicit final-reply delivery ──────────────────────────
  // Schema-typed alternative to relying on a trailing-text fallback. The
  // model is taught that this is the canonical way to deliver its final
  // reply. Functionally a thin wrapper over send(type="text") + reply_to +
  // buttons; the value is in the EXPLICIT semantic ("this ends my turn")
  // and that the model sees a single tool whose purpose is unambiguous.
  //
  // The output stream is private scratchpad by contract. If the model
  // writes trailing prose without calling end_turn or send, the handler
  // re-prompts ONCE in the same session with a flow-violation reminder
  // so the model can retry properly. Persistent violation after retry
  // results in silent drop + `scratchpad.trailing_text_dropped` counter.
  // `end_turn` is the documented happy path.
  {
    name: "end_turn",
    description: `End your current turn and deliver your final reply to the user. This is the canonical way to respond.

Call this AT MOST ONCE per turn — it should be the last tool you call. Behaves like send(type="text") with reply_to and buttons support, but the name makes the intent explicit: this is the message that ends the turn.

Examples:
  end_turn(text="Got it sur") — plain reply
  end_turn(text="On it", reply_to=12345) — reply to a specific message ID
  end_turn(text="Pick one", buttons=[[{"text":"A","callback_data":"a"}]]) — with buttons
  end_turn() — silent end (no message; useful when you already replied via earlier send/react calls)

Notes:
- For richer message types (photos, polls, voice, scheduled messages, multi-target), use the send tool — those don't fit "final reply" semantics.
- The output stream is private scratchpad. If you write prose without calling end_turn or send, the handler re-prompts you ONCE with a flow-violation reminder so you can retry properly. Persistent violation drops the prose silently. end_turn is the documented happy path.`,
    schema: {
      text: z
        .string()
        .optional()
        .describe(
          "Final reply text. Supports Markdown. Omit to end the turn silently (no message sent).",
        ),
      reply_to: snowflakeOrIdSchema
        .optional()
        .describe("Message ID to reply to (typically the user's [msg_id:N])"),
      buttons: z
        .array(
          z.array(
            z.object({
              text: z.string(),
              url: z.string().optional(),
              callback_data: z.string().optional(),
            }),
          ),
        )
        .optional()
        .describe("Inline keyboard button rows"),
    },
    execute: async (params, bridge) => {
      // Telegram path: routes to the same bridge actions as send(type="text")
      // so bridgeMessageCount, dedup, and audit logging all stay consistent.
      if (typeof params.text !== "string" || params.text.trim() === "") {
        // Silent end — no bridge call. The handler still sees the tool was
        // invoked (via deliveredTextNorms staying empty), and trailing-text
        // fallback won't fire because there was no trailing prose.
        return { ok: true, silent: true };
      }
      const result = params.buttons
        ? await bridge("send_message_with_buttons", {
            text: params.text,
            rows: params.buttons,
            reply_to_message_id: params.reply_to,
          })
        : await bridge("send_message", {
            text: params.text,
            reply_to_message_id: params.reply_to,
          });
      // Throw on delivery failure so PostToolUseFailure fires; the SDK hook
      // pair then preserves the loop instead of terminating silently. See
      // src/backend/claude-sdk/options.ts:turnTerminatorHook.
      return throwIfFailed(result, "end_turn");
    },
    frontends: ["telegram", "teams", "discord", "native", "whatsapp"],
    tag: "messaging",
    endsTurn: true,
    delivery: true,
  },

  // ── Telegram unified send ─────────────────────────────────────────────
  {
    name: "send",
    description: `Send content to the current chat. Supports text, photos, videos, files, audio, voice, stickers, polls, locations, contacts, dice, and GIFs.

Media (photo/video/animation/file/audio/voice) can come from a workspace file_path, a public URL (fetched by the platform — ideal for images/GIFs found online), or a file_id seen earlier in chat.

Examples:
  Text: send(type="text", text="Hello!")
  Reply: send(type="text", text="Yes!", reply_to=12345)
  With buttons: send(type="text", text="Pick one", buttons=[[{"text":"A","callback_data":"a"}]])
  Photo: send(type="photo", file_path="/path/to/img.jpg", caption="Look!")
  GIF: send(type="animation", url="https://example.com/funny.gif")
  File: send(type="file", file_path="/path/to/report.pdf")
  Audio: send(type="audio", file_path="/path/to/song.mp3", title="Song Name", performer="Artist")
  Poll: send(type="poll", question="Best language?", options=["Rust","Go","TS"])
  Dice: send(type="dice")
  Location: send(type="location", latitude=37.7749, longitude=-122.4194)
  Sticker by feeling: send(type="sticker", emoji="😂") — picks a matching sticker from your saved packs (add set_name to pin one pack)
  Sticker by id: send(type="sticker", file_id="CAACAgI...")
  Album: send(type="album", media=[{"type":"photo","file_path":"a.jpg"},{"type":"photo","url":"https://…/b.jpg","caption":"the good one"}]) — 2-10 photos/videos as one grouped message
  Round video: send(type="video_note", file_path="/path/clip.mp4") — circular video bubble (square video, ≤60s)
  Venue: send(type="venue", latitude=53.34, longitude=-6.26, title="The Long Hall", address="51 South Great George's St")`,
    schema: {
      type: z
        .enum([
          "text",
          "photo",
          "file",
          "video",
          "voice",
          "audio",
          "animation",
          "sticker",
          "poll",
          "location",
          "contact",
          "dice",
          "album",
          "video_note",
          "venue",
        ])
        .describe("Content type to send"),
      text: z
        .string()
        .optional()
        .describe("Message text (for type=text). Supports Markdown."),
      reply_to: snowflakeOrIdSchema
        .optional()
        .describe("Message ID to reply to"),
      file_path: z
        .string()
        .optional()
        .describe("Workspace file path (for photo/file/video/voice/animation)"),
      url: z
        .string()
        .optional()
        .describe(
          "Public URL of media to send (photo/video/animation/file/audio/voice; .webp for sticker) — fetched by the platform, no download needed. Great for GIFs.",
        ),
      file_id: z
        .string()
        .optional()
        .describe(
          "Platform file_id to send media already seen in chat (stickers, GIFs, photos, ...)",
        ),
      set_name: z
        .string()
        .optional()
        .describe(
          "Sticker pack to pick from when sending a sticker by emoji (default: all saved packs)",
        ),
      caption: z.string().optional().describe("Caption for media"),
      buttons: z
        .array(
          z.array(
            z.object({
              text: z.string(),
              url: z.string().optional(),
              callback_data: z.string().optional(),
            }),
          ),
        )
        .optional()
        .describe("Inline keyboard button rows"),
      question: z.string().optional().describe("Poll question"),
      options: z.array(z.string()).optional().describe("Poll options"),
      is_anonymous: z.boolean().optional().describe("Anonymous poll"),
      correct_option_id: z
        .number()
        .optional()
        .describe("Quiz correct answer index"),
      explanation: z.string().optional().describe("Quiz explanation"),
      latitude: z.number().optional().describe("Location latitude"),
      longitude: z.number().optional().describe("Location longitude"),
      phone_number: z.string().optional().describe("Contact phone"),
      first_name: z.string().optional().describe("Contact first name"),
      last_name: z.string().optional().describe("Contact last name"),
      title: z
        .string()
        .optional()
        .describe("Audio title (type=audio) or venue name (type=venue)"),
      address: z
        .string()
        .optional()
        .describe("Venue street address (for type=venue)"),
      media: z
        .array(
          z.object({
            type: z
              .enum(["photo", "video", "document", "audio"])
              .describe("Kind of this album item"),
            file_path: z.string().optional(),
            url: z.string().optional(),
            file_id: z.string().optional(),
            caption: z.string().optional(),
          }),
        )
        .optional()
        .describe(
          "Album items (for type=album): 2-10 entries, each sourced from file_path, url, or file_id. Photos and videos mix; documents/audio group only with their own kind.",
        ),
      performer: z
        .string()
        .optional()
        .describe("Audio performer/artist (for type=audio)"),
      emoji: z
        .string()
        .optional()
        .describe(
          "For type=sticker: pick a saved sticker matching this emoji. For type=dice: the dice style (🎲🎯🏀⚽🎳🎰).",
        ),
      delay_seconds: z
        .number()
        .optional()
        .describe(
          "Schedule: delay before sending, in seconds (1-86400). Scheduled sends persist across restarts; manage with list_scheduled / cancel_scheduled.",
        ),
      chat_id: chatIdSchema
        .optional()
        .describe(
          "Target chat ID. Omit to send to the current chat (chat mode). Required from heartbeat mode where there is no ambient chat — use list_chats or known IDs from memory. Telegram supergroup/channel IDs are negative (e.g. -1009876543210); user DMs are positive.",
        ),
      silent: z
        .boolean()
        .optional()
        .describe("Send without a notification sound (Telegram)"),
      protect: z
        .boolean()
        .optional()
        .describe("Protect content from forwarding and saving (Telegram)"),
      spoiler: z
        .boolean()
        .optional()
        .describe(
          "Blur photo/video/animation behind a spoiler tap-to-reveal (Telegram)",
        ),
      no_link_preview: z
        .boolean()
        .optional()
        .describe("Disable the link preview for type=text (Telegram)"),
      thread_id: z
        .union([z.number(), z.literal("general")])
        .optional()
        .describe(
          'Forum topic to post into (Telegram supergroups with topics). Defaults to the topic the conversation is happening in; pass "general" to force the General topic.',
        ),
    },
    execute: async (params, bridge) => {
      const { type } = params;
      // Delivery modifiers every Telegram send action understands. Harmless
      // on frontends that don't (handlers read only the fields they know).
      const mods = {
        silent: params.silent,
        protect: params.protect,
        spoiler: params.spoiler,
        thread_id: params.thread_id,
      };
      // Thread chat_id through to every bridge call so heartbeat / dream
      // outbound (no ambient chat) gets routed by the explicit chat_id.
      // `createBridge` at src/core/tools/bridge.ts:29 reads
      // `params.chat_id` from the bridge payload (NOT from the
      // tool-input params) and promotes it to `_chatId` for the
      // gateway. If we don't include chat_id here, the bridge falls
      // back to the spawn-time TALON_CHAT_ID env (the "heartbeat"
      // sentinel) and the gateway rejects with "No active chat
      // context and no explicit numeric chat_id".
      const chat_id = params.chat_id;
      switch (type) {
        case "text": {
          if (params.delay_seconds) {
            // Buttons and reply threading survive the delay — the
            // schedule handler replays them at fire time.
            return bridge("schedule_message", {
              text: params.text,
              delay_seconds: params.delay_seconds,
              rows: params.buttons,
              reply_to_message_id: params.reply_to,
              ...mods,
              chat_id,
            });
          }
          if (params.buttons) {
            return bridge("send_message_with_buttons", {
              text: params.text,
              rows: params.buttons,
              reply_to_message_id: params.reply_to,
              ...mods,
              chat_id,
            });
          }
          return bridge("send_message", {
            text: params.text,
            reply_to_message_id: params.reply_to,
            no_link_preview: params.no_link_preview,
            ...mods,
            chat_id,
          });
        }
        case "photo":
          return bridge("send_photo", {
            file_path: params.file_path,
            url: params.url,
            file_id: params.file_id,
            caption: params.caption,
            reply_to: params.reply_to,
            ...mods,
            chat_id,
          });
        case "file":
          return bridge("send_file", {
            file_path: params.file_path,
            url: params.url,
            file_id: params.file_id,
            caption: params.caption,
            reply_to: params.reply_to,
            ...mods,
            chat_id,
          });
        case "video":
          return bridge("send_video", {
            file_path: params.file_path,
            url: params.url,
            file_id: params.file_id,
            caption: params.caption,
            reply_to: params.reply_to,
            ...mods,
            chat_id,
          });
        case "voice":
          return bridge("send_voice", {
            file_path: params.file_path,
            url: params.url,
            file_id: params.file_id,
            caption: params.caption,
            reply_to: params.reply_to,
            ...mods,
            chat_id,
          });
        case "audio":
          return bridge("send_audio", {
            file_path: params.file_path,
            url: params.url,
            file_id: params.file_id,
            caption: params.caption,
            title: params.title,
            performer: params.performer,
            reply_to: params.reply_to,
            ...mods,
            chat_id,
          });
        case "animation":
          return bridge("send_animation", {
            file_path: params.file_path,
            url: params.url,
            file_id: params.file_id,
            caption: params.caption,
            reply_to: params.reply_to,
            ...mods,
            chat_id,
          });
        case "sticker":
          return bridge("send_sticker", {
            file_id: params.file_id,
            url: params.url,
            emoji: params.emoji,
            set_name: params.set_name,
            reply_to: params.reply_to,
            ...mods,
            chat_id,
          });
        case "poll":
          return bridge("send_poll", {
            question: params.question,
            options: params.options,
            is_anonymous: params.is_anonymous,
            correct_option_id: params.correct_option_id,
            explanation: params.explanation,
            type: params.correct_option_id !== undefined ? "quiz" : "regular",
            reply_to: params.reply_to,
            ...mods,
            chat_id,
          });
        case "location":
          return bridge("send_location", {
            latitude: params.latitude,
            longitude: params.longitude,
            reply_to: params.reply_to,
            ...mods,
            chat_id,
          });
        case "contact":
          return bridge("send_contact", {
            phone_number: params.phone_number,
            first_name: params.first_name,
            last_name: params.last_name,
            reply_to: params.reply_to,
            ...mods,
            chat_id,
          });
        case "dice":
          return bridge("send_dice", {
            emoji: params.emoji,
            reply_to: params.reply_to,
            ...mods,
            chat_id,
          });
        case "album":
          return bridge("send_media_group", {
            media: params.media,
            reply_to: params.reply_to,
            ...mods,
            chat_id,
          });
        case "video_note":
          return bridge("send_video_note", {
            file_path: params.file_path,
            url: params.url,
            file_id: params.file_id,
            reply_to: params.reply_to,
            ...mods,
            chat_id,
          });
        case "venue":
          return bridge("send_venue", {
            latitude: params.latitude,
            longitude: params.longitude,
            title: params.title,
            address: params.address,
            reply_to: params.reply_to,
            ...mods,
            chat_id,
          });
        default:
          return { ok: false, error: `Unknown type: ${type}` };
      }
    },
    frontends: ["telegram", "discord", "whatsapp"],
    tag: "messaging",
    delivery: true,
  },

  // ── Native send_message ────────────────────────────────────────────────
  {
    name: "send_message",
    description: `Send a message to the native chat bridge. Supports Markdown formatting.

Examples:
  send_message(text="Hello!")
  send_message(text="Here's a **bold** message with \`code\`")`,
    schema: {
      text: z.string().describe("Message text. Supports Markdown."),
    },
    execute: (params, bridge) => bridge("send_message", params),
    frontends: ["teams", "native", "whatsapp"],
    tag: "messaging",
    delivery: true,
  },

  // ── Native send_message_with_buttons ──────────────────────────────────
  {
    name: "send_message_with_buttons",
    description: `Send a message with clickable link buttons. Buttons appear below the message in the native client.

Example: send_message_with_buttons(text="Choose:", rows=[[{"text":"Docs","url":"https://..."}]])`,
    schema: {
      text: z.string().describe("Message text"),
      rows: z
        .array(
          z.array(
            z.object({
              text: z.string().describe("Button label"),
              url: z.string().optional().describe("URL to open when clicked"),
            }),
          ),
        )
        .describe("Button rows"),
    },
    execute: (params, bridge) => bridge("send_message_with_buttons", params),
    frontends: ["teams", "native", "whatsapp"],
    tag: "messaging",
    delivery: true,
  },

  // ── react ─────────────────────────────────────────────────────────────
  // Reacting is itself a final delivery action — the user sees the emoji
  // appear on their own message, same as receiving a reply. In practice
  // most react calls are acknowledgement-only and end the turn naturally.
  //
  // Soft-terminator design: react is declared `endsTurn: true` so a
  // react-only batch closes the SDK loop cleanly (no separate end_turn()
  // needed, no typing-indicator race). BUT the model can pass
  // `end_turn: false` if it wants to react and keep the turn alive — e.g.
  // "let me look at that 🤔" then a subsequent fetch_url / search /
  // analysis. The PostToolBatch hook honours that param: if every
  // terminator in the batch is a react with `end_turn: false`, the loop
  // continues; if a "real" terminator (end_turn) or a default react is
  // also in the batch, it terminates as usual.
  {
    name: "react",
    description: `Add an emoji reaction to a message. By default this also ends your turn (a reaction is usually a complete acknowledgement — no separate end_turn() needed).

Pass \`end_turn: false\` if you want to react now and keep working on something afterwards (e.g. "🤔" then look something up, then respond). Use this sparingly — most reacts are turn-final.

Valid emoji: 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷 🤷‍♂ 🤷‍♀ 😡`,
    schema: {
      message_id: snowflakeOrIdSchema.describe("Message ID"),
      emoji: z.string().describe("Reaction emoji"),
      end_turn: z
        .boolean()
        .optional()
        .describe(
          "Whether this reaction ends the turn. Defaults to true (omit). Pass false to keep the turn alive after reacting.",
        ),
      chat_id: chatIdSchema
        .optional()
        .describe(
          "Target chat ID. Omit in chat mode (uses ambient chat). Required from heartbeat mode. Supergroup/channel IDs are negative; user DMs are positive.",
        ),
    },
    // Strip end_turn before bridging — it's a hook-level signal, the
    // backend action handler doesn't need to know about it. chat_id stays
    // in the body; bridge.ts promotes it to the gateway's routing key.
    //
    // Throw on `{ok: false}` regardless of the soft-terminator opt-out
    // (`end_turn: false`). When react is acting as a strict terminator
    // (the default), the throw triggers the SDK's PostToolUseFailure pipe
    // and the hook preserves the loop. When react is soft (`end_turn:false`)
    // the loop was going to stay alive anyway — throwing still gives the
    // model a clear error signal in the next assistant turn rather than a
    // silent `{ok:false}` it has to remember to inspect.
    execute: async (params, bridge) => {
      const { end_turn: _endTurn, ...rest } = params;
      const result = await bridge("react", rest);
      return throwIfFailed(result, "react");
    },
    frontends: ["telegram", "discord", "native", "whatsapp"],
    tag: "messaging",
    endsTurn: true,
    delivery: true,
  },

  // ── edit_message ──────────────────────────────────────────────────────
  {
    name: "edit_message",
    description:
      "Edit a previously sent message. For a media message (photo/video/file), pass is_caption=true to edit its caption instead of message text.",
    schema: {
      message_id: snowflakeOrIdSchema,
      text: z.string(),
      is_caption: z
        .boolean()
        .optional()
        .describe("Edit the media caption rather than message text (Telegram)"),
    },
    execute: (params, bridge) => bridge("edit_message", params),
    frontends: ["telegram", "discord", "native", "whatsapp"],
    tag: "messaging",
  },

  // ── delete_message ────────────────────────────────────────────────────
  {
    name: "delete_message",
    description:
      "Delete a message — or several at once via message_ids (Telegram; ids the bot can't delete are skipped).",
    schema: {
      message_id: snowflakeOrIdSchema.optional(),
      message_ids: z
        .array(snowflakeOrIdSchema)
        .optional()
        .describe("Bulk delete these message IDs (Telegram)"),
    },
    execute: (params, bridge) => bridge("delete_message", params),
    frontends: ["telegram", "discord", "native", "whatsapp"],
    tag: "messaging",
  },

  // ── forward_message ───────────────────────────────────────────────────
  {
    name: "forward_message",
    description:
      "Forward a message. Defaults to within the current chat; from_chat_id / to_chat_id forward across chats the bot is in, and message_ids forwards a batch (albums stay grouped) (Telegram).",
    schema: {
      message_id: snowflakeOrIdSchema.optional(),
      message_ids: z
        .array(snowflakeOrIdSchema)
        .optional()
        .describe("Forward these messages as a batch (Telegram)"),
      from_chat_id: chatIdSchema
        .optional()
        .describe("Source chat (default: current chat)"),
      to_chat_id: chatIdSchema
        .optional()
        .describe("Destination chat (default: current chat)"),
    },
    execute: (params, bridge) => bridge("forward_message", params),
    frontends: ["telegram", "discord", "whatsapp"],
    tag: "messaging",
  },

  // ── copy_message ──────────────────────────────────────────────────────
  {
    name: "copy_message",
    description:
      "Repost a message without the 'forwarded from' header. Same cross-chat and batch semantics as forward_message (Telegram).",
    schema: {
      message_id: snowflakeOrIdSchema.optional(),
      message_ids: z.array(snowflakeOrIdSchema).optional(),
      from_chat_id: chatIdSchema.optional(),
      to_chat_id: chatIdSchema.optional(),
    },
    execute: (params, bridge) => bridge("copy_message", params),
    frontends: ["telegram", "whatsapp"],
    tag: "messaging",
  },

  // ── pin_message ───────────────────────────────────────────────────────
  {
    name: "pin_message",
    description: "Pin a message.",
    schema: { message_id: snowflakeOrIdSchema },
    execute: (params, bridge) => bridge("pin_message", params),
    frontends: ["telegram", "discord", "whatsapp"],
    tag: "messaging",
  },

  // ── unpin_message ─────────────────────────────────────────────────────
  {
    name: "unpin_message",
    description: "Unpin a message.",
    schema: { message_id: snowflakeOrIdSchema.optional() },
    execute: (params, bridge) => bridge("unpin_message", params),
    frontends: ["telegram", "discord", "whatsapp"],
    tag: "messaging",
  },

  // ── stop_poll ─────────────────────────────────────────────────────────
  {
    name: "stop_poll",
    description:
      "Stop an active poll and get the final results. Returns vote counts for each option.",
    schema: {
      message_id: idSchema.describe("Message ID of the poll to stop"),
    },
    execute: (params, bridge) => bridge("stop_poll", params),
    // No WhatsApp equivalent: its polls run until the message is deleted.
    frontends: ["telegram"],
    tag: "messaging",
  },
];
