import { z } from "zod";
import type { ToolDefinition } from "../types.js";

/**
 * Cross-frontend send. Deliberately NOT frontend-restricted (the meshTools
 * pattern): the whole point is reaching a DIFFERENT enabled frontend than
 * the one the session lives on — a Telegram chat messaging a WhatsApp
 * number, the heartbeat reaching WhatsApp when only telegram-tools is
 * mounted. The gateway serves it as a chat-free action (see
 * engine/gateway-actions/cross-send.ts), so it works from background runs
 * with no ambient chat, and the target frontend is named EXPLICITLY —
 * never inferred from the shape of a numeric id.
 */
export const crossSendTools: ToolDefinition[] = [
  {
    name: "send_via",
    description: `Send a message — text, or a photo/video/file/voice note — through ANY enabled messaging frontend, including one this chat does not live on. Use it to reach someone on another platform (e.g. from Telegram or a heartbeat run, message a WhatsApp number). For the current chat, keep using the normal delivery tools (end_turn / send / send_message).

Target forms:
- whatsapp: a phone number with country code ("+353871234567" or "353871234567"), a wa_dm_<number>/wa_group_<id> chat id, or a raw JID; a bare numeric chat id works only for chats already seen since startup
- telegram / discord / teams / native: the numeric chat id, as a string (Telegram supergroups/channels are negative, DMs positive)

Media: give file_path (a workspace file) or url (a public URL, fetched by the platform); text becomes the caption. The kind is inferred from the extension — pass media_type to override (e.g. send a .webp as a sticker rather than a photo). file_id is Telegram-only; other platforms have no equivalent and will say so.

Examples:
  send_via(frontend="whatsapp", target="+353871234567", text="On my way")
  send_via(frontend="whatsapp", target="+353871234567", file_path="media/plot.png", text="here's the chart")
  send_via(frontend="telegram", target="-1009876543210", text="Build is green")

Fails with a clear error when the named frontend is not enabled or not connected.`,
    schema: {
      frontend: z
        .enum(["telegram", "whatsapp", "discord", "teams", "native"])
        .describe("Messaging frontend to deliver through."),
      target: z
        .string()
        .describe(
          "Destination chat: numeric chat id as a string; for WhatsApp also a phone number with country code or a wa_dm_/wa_group_ id.",
        ),
      text: z
        .string()
        .optional()
        .describe(
          "Message text, or the caption when media is attached. Markdown supported where the platform supports it. Required unless a media source is given.",
        ),
      file_path: z
        .string()
        .optional()
        .describe("Workspace file to send as media."),
      url: z
        .string()
        .optional()
        .describe(
          "Public URL of media to send — fetched by the target platform.",
        ),
      file_id: z
        .string()
        .optional()
        .describe(
          "Platform file_id for media already seen in chat (Telegram only).",
        ),
      media_type: z
        .enum([
          "photo",
          "video",
          "animation",
          "voice",
          "audio",
          "sticker",
          "video_note",
          "file",
        ])
        .optional()
        .describe(
          "Override the media kind. Default: inferred from the file extension, falling back to a document.",
        ),
    },
    execute: (params, bridge) => bridge("send_via", params),
    tag: "messaging",
  },
];
