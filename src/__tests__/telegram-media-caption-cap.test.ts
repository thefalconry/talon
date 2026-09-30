/**
 * Telegram media captions over 1024 visible characters are rejected by the
 * Bot API ("message caption is too long") and the media is lost with them.
 * The media actions now split an oversized caption on a clean boundary: the
 * leading part that fits rides on the media (still formatted) and the rest
 * follows as text message(s) threaded to the media.
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
  captionUnits,
  fitCaption,
  mediaHandlers,
  splitCaption,
  visibleCaptionText,
  TELEGRAM_MAX_CAPTION,
} from "../frontend/telegram/actions/media.js";
import { messagingHandlers } from "../frontend/telegram/actions/messaging.js";
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
    editMessageCaption: vi.fn(async () => true),
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

/** Every tag opened in `html` is closed, in order. */
function balanced(html: string): boolean {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/gi)) {
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else stack.push(m[2]!);
  }
  return stack.length === 0;
}

const words = (n: number, w = "word") =>
  Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");

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

  it("splits an oversized caption: formatted head on the media, rest as overflow", () => {
    const long = `**Summary** of the run\n\n${words(400)}`;
    const r = fitCaption(long);
    expect(r.parse_mode).toBe("HTML");
    expect(r.caption!.startsWith("<b>Summary</b> of the run")).toBe(true);
    expect(visibleCaptionText(r.caption!).length).toBeLessThanOrEqual(
      TELEGRAM_MAX_CAPTION,
    );
    // Nothing lost, nothing duplicated: head + rest reassemble the words.
    const headWords = visibleCaptionText(r.caption!).split(/\s+/);
    const restWords = r.overflow!.split(/\s+/);
    expect([...headWords, ...restWords].join(" ")).toBe(
      long.replace(/\*\*/g, "").split(/\s+/).join(" "),
    );
  });

  it("never cuts through a word", () => {
    const r = fitCaption(words(400));
    const head = visibleCaptionText(r.caption!);
    expect(head).toMatch(/word\d+$/);
    expect(r.overflow).toMatch(/^word\d+/);
    const n = Number(/(\d+)$/.exec(head)![1]);
    expect(r.overflow!.startsWith(`word${n + 1} `)).toBe(true);
  });

  it("keeps the head's markup balanced when splitting inside formatting", () => {
    const long = Array.from(
      { length: 60 },
      (_, i) => `- **item ${i}** — _detail_ [link](https://example.com/${i})`,
    ).join("\n");
    const r = fitCaption(long);
    expect(r.overflow).toBeTruthy();
    expect(balanced(r.caption!)).toBe(true);
    expect(visibleCaptionText(r.caption!).length).toBeLessThanOrEqual(
      TELEGRAM_MAX_CAPTION,
    );
  });

  it("closes and reopens a code fence across the split", () => {
    const code = Array.from({ length: 200 }, (_, i) => `line ${i};`).join("\n");
    const r = fitCaption(`intro\n\n\`\`\`\n${code}\n\`\`\``);
    expect(balanced(r.caption!)).toBe(true);
    expect(r.caption).toContain("<pre>");
    expect(r.overflow!.startsWith("```")).toBe(true);
    expect(r.overflow).toContain("line 199;");
  });

  it("does not split a surrogate pair", () => {
    const r = fitCaption("😀".repeat(1000));
    const cap = visibleCaptionText(r.caption!);
    const last = cap.charCodeAt(cap.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(cap.length).toBeLessThanOrEqual(TELEGRAM_MAX_CAPTION);
    expect(cap.length + r.overflow!.length).toBe(2000);
  });
});

describe("splitCaption", () => {
  it("returns the whole text as head when it fits", () => {
    expect(splitCaption("short")).toEqual({ head: "short", rest: "" });
  });

  it("respects a custom limit", () => {
    const s = splitCaption(words(50), 100)!;
    expect(captionUnits(s.head)).toBeLessThanOrEqual(100);
    expect(`${s.head} ${s.rest}`).toBe(words(50));
  });
});

describe("send_file / send_photo caption split", () => {
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

  it("sends the document with the fitting head and the remainder as a reply", async () => {
    const { ctx, api } = fakeContext();
    const long = words(300);
    const res = await mediaHandlers.send_file(
      { action: "send_file", file_id: "abc", caption: long },
      CHAT,
      ctx,
    );
    const opts = (api.sendDocument.mock.calls[0] as unknown[])[2] as {
      caption: string;
      parse_mode?: string;
    };
    expect(opts.parse_mode).toBe("HTML");
    expect(visibleCaptionText(opts.caption).length).toBeLessThanOrEqual(
      TELEGRAM_MAX_CAPTION,
    );
    expect(api.sendRichMessage).toHaveBeenCalledTimes(1);
    const [chat, content, extra] = api.sendRichMessage.mock
      .calls[0] as unknown as [
      number,
      { markdown: string },
      { reply_parameters?: { message_id: number } },
    ];
    expect(chat).toBe(CHAT);
    expect(`${opts.caption} ${content.markdown}`).toBe(long);
    expect(extra.reply_parameters?.message_id).toBe(100);
    expect(res).toEqual({
      ok: true,
      message_id: 100,
      caption_split: true,
      caption_message_ids: [101],
    });
  });

  it("chunks a remainder longer than one text message", async () => {
    const { ctx, api } = fakeContext();
    const res = await mediaHandlers.send_file(
      { action: "send_file", file_id: "abc", caption: "z ".repeat(5000) },
      CHAT,
      ctx,
    );
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
    expect(api.sendRichMessage.mock.calls.length).toBeGreaterThan(1);
    expect(res!.ok).toBe(true);
    expect(res!.caption_split).toBe(true);
  });

  it("keeps the media send ok when the follow-up fails", async () => {
    const { ctx, api } = fakeContext();
    api.sendRichMessage.mockRejectedValue(new Error("boom"));
    api.sendMessage.mockRejectedValue(new Error("boom"));
    const res = await mediaHandlers.send_photo(
      { action: "send_photo", url: "u", caption: words(300) },
      CHAT,
      ctx,
    );
    expect(res!.ok).toBe(true);
    expect(res!.message_id).toBe(100);
    expect(String(res!.warning)).toContain("rest of its caption");
  });
});

describe("send_media_group caption split", () => {
  it("splits the oversized item caption and follows up after the album", async () => {
    const { ctx, api } = fakeContext();
    const long = words(250, "w");
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
    expect(visibleCaptionText(group[0]!.caption!).length).toBeLessThanOrEqual(
      TELEGRAM_MAX_CAPTION,
    );
    expect(group[0]!.parse_mode).toBe("HTML");
    expect(group[1]).toMatchObject({ caption: "short", parse_mode: "HTML" });
    const [, content, extra] = api.sendRichMessage.mock.calls[0] as unknown as [
      number,
      { markdown: string },
      { reply_parameters?: { message_id: number } },
    ];
    expect(`${group[0]!.caption} ${content.markdown}`).toBe(long);
    expect(extra.reply_parameters?.message_id).toBe(100);
    expect(res).toMatchObject({
      ok: true,
      message_ids: [100, 101],
      caption_split: true,
    });
  });
});

describe("edit_message is_caption", () => {
  it("refuses an oversized caption edit with guidance instead of a 400", async () => {
    const { ctx, api } = fakeContext();
    const res = await messagingHandlers.edit_message(
      { message_id: 5, is_caption: true, text: "c".repeat(1500) },
      CHAT,
      ctx,
    );
    expect(res).toMatchObject({ ok: false });
    expect(String(res!.error)).toContain("max 1024");
    expect(api.editMessageCaption).not.toHaveBeenCalled();
  });

  it("edits a caption that fits", async () => {
    const { ctx, api } = fakeContext();
    const res = await messagingHandlers.edit_message(
      { message_id: 5, is_caption: true, text: "**new**" },
      CHAT,
      ctx,
    );
    expect(res).toEqual({ ok: true });
    expect(api.editMessageCaption).toHaveBeenCalledWith(CHAT, 5, {
      caption: "<b>new</b>",
      parse_mode: "HTML",
    });
  });
});
