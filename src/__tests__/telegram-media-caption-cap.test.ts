/**
 * Telegram media captions over 1024 visible characters are rejected by the
 * Bot API ("message caption is too long") and the media is lost with them.
 * The media actions now send a truncated plain-text caption and deliver the
 * full text as a follow-up text message threaded to the media.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../core/engine/gateway.js", () => ({
  withRetry: <T>(fn: () => Promise<T>) => fn(),
}));

import {
  fitCaption,
  mediaHandlers,
  visibleCaptionText,
  TELEGRAM_MAX_CAPTION,
} from "../frontend/telegram/actions/media.js";
import type { TelegramActionContext } from "../frontend/telegram/actions/types.js";

const CHAT = 4242;

function fakeContext() {
  let next = 100;
  const api = {
    sendPhoto: vi.fn(async () => ({ message_id: next++ })),
    sendDocument: vi.fn(async () => ({ message_id: next++ })),
    sendMediaGroup: vi.fn(async (_c: number, group: unknown[]) =>
      group.map(() => ({ message_id: next++ })),
    ),
    sendRichMessage: vi.fn(async () => ({ message_id: next++ })),
    sendMessage: vi.fn(async () => ({ message_id: next++ })),
  };
  const ctx = {
    bot: { api },
    InputFileClass: class {},
    botToken: "t",
    gateway: { incrementMessages: vi.fn() },
    scheduledMessages: new Map(),
  } as unknown as TelegramActionContext;
  return { ctx, api };
}

describe("fitCaption", () => {
  it("keeps short captions as HTML", () => {
    const r = fitCaption("**hi** there");
    expect(r).toEqual({ caption: "<b>hi</b> there", parse_mode: "HTML" });
  });

  it("returns nothing for an empty caption", () => {
    expect(fitCaption(undefined)).toEqual({});
    expect(fitCaption("")).toEqual({});
  });

  it("measures visible text, not markup", () => {
    // 1000 visible chars wrapped in bold: HTML is longer than 1024 but
    // Telegram counts only the 1000 visible characters.
    const r = fitCaption(`**${"a".repeat(1000)}**`);
    expect(r.parse_mode).toBe("HTML");
    expect(r.overflow).toBeUndefined();
  });

  it("counts escaped entities as one character", () => {
    expect(visibleCaptionText("a &amp; b &lt;c&gt; &#128512;")).toBe(
      "a & b <c> 😀",
    );
    const r = fitCaption("&".repeat(1000));
    expect(r.overflow).toBeUndefined();
  });

  it("truncates an oversized caption to plain text and returns the overflow", () => {
    const long = `**bold** ${"x".repeat(2000)}`;
    const r = fitCaption(long);
    expect(r.parse_mode).toBeUndefined();
    expect(r.overflow).toBe(long);
    expect(r.caption!.length).toBeLessThanOrEqual(TELEGRAM_MAX_CAPTION);
    expect(r.caption!.startsWith("bold x")).toBe(true);
    expect(r.caption!.endsWith("…")).toBe(true);
    expect(r.caption).not.toContain("<");
  });

  it("does not split a surrogate pair at the cut", () => {
    const r = fitCaption(`${"a".repeat(999)}${"😀".repeat(100)}`);
    const cut = r.caption!.slice(0, -1);
    const last = cut.charCodeAt(cut.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});

describe("send_photo caption cap", () => {
  it("sends a short caption as-is with no follow-up", async () => {
    const { ctx, api } = fakeContext();
    const res = await mediaHandlers.send_photo(
      { action: "send_photo", url: "https://x/y.jpg", caption: "hello" },
      CHAT,
      ctx,
    );
    expect(res).toEqual({ ok: true, message_id: 100 });
    expect(api.sendPhoto).toHaveBeenCalledWith(
      CHAT,
      "https://x/y.jpg",
      expect.objectContaining({ caption: "hello", parse_mode: "HTML" }),
    );
    expect(api.sendRichMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("truncates a long caption and follows up with the full text", async () => {
    const { ctx, api } = fakeContext();
    const long = "y".repeat(3000);
    const res = await mediaHandlers.send_photo(
      { action: "send_photo", url: "https://x/y.jpg", caption: long },
      CHAT,
      ctx,
    );
    const opts = (api.sendPhoto.mock.calls[0] as unknown[])[2] as {
      caption: string;
      parse_mode?: string;
    };
    expect(opts.caption.length).toBeLessThanOrEqual(TELEGRAM_MAX_CAPTION);
    expect(opts.parse_mode).toBeUndefined();
    expect(api.sendRichMessage).toHaveBeenCalledTimes(1);
    const [chat, content, extra] = api.sendRichMessage.mock
      .calls[0] as unknown as [
      number,
      { markdown: string },
      { reply_parameters?: { message_id: number } },
    ];
    expect(chat).toBe(CHAT);
    expect(content.markdown).toBe(long);
    expect(extra.reply_parameters?.message_id).toBe(100);
    expect(res).toEqual({
      ok: true,
      message_id: 100,
      caption_truncated: true,
      caption_message_ids: [101],
    });
  });

  it("chunks a caption longer than one text message", async () => {
    const { ctx, api } = fakeContext();
    const res = await mediaHandlers.send_file(
      {
        action: "send_file",
        file_id: "abc",
        caption: "z ".repeat(5000),
      },
      CHAT,
      ctx,
    );
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
    expect(api.sendRichMessage.mock.calls.length).toBeGreaterThan(1);
    expect(res!.ok).toBe(true);
    expect(res!.caption_truncated).toBe(true);
  });

  it("keeps the media send ok when the follow-up fails", async () => {
    const { ctx, api } = fakeContext();
    api.sendRichMessage.mockRejectedValue(new Error("boom"));
    api.sendMessage.mockRejectedValue(new Error("boom"));
    const res = await mediaHandlers.send_photo(
      { action: "send_photo", url: "u", caption: "q".repeat(2000) },
      CHAT,
      ctx,
    );
    expect(res!.ok).toBe(true);
    expect(res!.message_id).toBe(100);
    expect(String(res!.warning)).toContain("truncated caption");
  });
});

describe("send_media_group caption cap", () => {
  it("caps the oversized item caption and follows up after the album", async () => {
    const { ctx, api } = fakeContext();
    const long = "w".repeat(1500);
    const res = await mediaHandlers.send_media_group(
      {
        action: "send_media_group",
        media: [
          { type: "photo", url: "a", caption: long },
          { type: "photo", url: "b", caption: "short" },
        ],
      },
      CHAT,
      ctx,
    );
    const group = (api.sendMediaGroup.mock.calls[0] as unknown[])[1] as {
      caption?: string;
      parse_mode?: string;
    }[];
    expect(group[0]!.caption!.length).toBeLessThanOrEqual(TELEGRAM_MAX_CAPTION);
    expect(group[0]!.parse_mode).toBeUndefined();
    expect(group[1]).toMatchObject({ caption: "short", parse_mode: "HTML" });
    const [, content, extra] = api.sendRichMessage.mock.calls[0] as unknown as [
      number,
      { markdown: string },
      { reply_parameters?: { message_id: number } },
    ];
    expect(content.markdown).toBe(long);
    expect(extra.reply_parameters?.message_id).toBe(100);
    expect(res).toMatchObject({
      ok: true,
      message_ids: [100, 101],
      caption_truncated: true,
    });
  });
});
