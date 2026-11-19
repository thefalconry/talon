/**
 * Inbound WhatsApp documents, end to end: a PDF/docx a user sends is
 * downloaded, saved under uploads/ with its real name and extension, and
 * reaches the model as text — because a turn from anyone but the
 * operator has no file tools to open the saved path with.
 *
 * Regression: a document sent with a caption arrives wrapped in
 * `documentWithCaptionMessage`; the media store only looked at top-level
 * fields, so the file was never downloaded and the model saw the caption
 * alone. And a PDF that did download reached a guest turn as a bare path
 * it could not open ("I can't open files here, only text").
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../util/watchdog.js", () => ({
  recordMessageProcessed: vi.fn(),
  recordMessageReceived: vi.fn(),
}));
vi.mock("../storage/daily-log.js", () => ({ appendDailyLog: vi.fn() }));
const execute = vi.fn(async (_params: { prompt: string }) => {});
vi.mock("../core/engine/dispatcher.js", () => ({
  execute: (...args: unknown[]) => execute(...(args as [{ prompt: string }])),
}));
const downloadMediaMessage = vi.fn(async (): Promise<unknown> =>
  Buffer.from(""),
);
vi.mock("baileys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("baileys")>()),
  downloadMediaMessage: () => downloadMediaMessage(),
}));
type ExecCb = (err: Error | null, stdout: string) => void;
const pdftotext = vi.fn((_args: string[], cb: ExecCb) => cb(null, ""));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    execFile: (...args: unknown[]) =>
      args[0] === "pdftotext"
        ? pdftotext(args[1] as string[], args[3] as ExecCb)
        : (real.execFile as (...a: unknown[]) => unknown)(...args),
  };
});

import { historyHandlers } from "../frontend/whatsapp/actions/history.js";
import { handleInbound } from "../frontend/whatsapp/messages/inbound.js";
import {
  inboundMediaFileName,
  saveInboundMedia,
} from "../frontend/whatsapp/messages/media-store.js";
import { resetMessageStore } from "../frontend/whatsapp/messages/message-store.js";
import { resetWhatsAppRegistry } from "../frontend/whatsapp/registry.js";
import { getRecentHistory } from "../storage/history.js";
import { purgeChat as deleteChat } from "../storage/repositories/history-repo.js";
import { dirs } from "../util/paths.js";

const CHAT = "wa_dm_100";
const PDF_MIME = "application/pdf";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function runtime() {
  return {
    config: { botDisplayName: "Talon" },
    gateway: { backend: null, incrementMessages: vi.fn() },
    settings: {
      respondMode: "mention",
      groupPolicy: "listed",
      sendReadReceipts: false,
    },
    allowedDms: new Set(["100"]),
    allowedGroups: new Set<string>(),
    groupAllowCache: new Map(),
    selfIds: ["999"],
    sock: {
      sendMessage: vi.fn(async () => ({ key: { id: "S", remoteJid: "x" } })),
    },
    stopping: false,
    reconnectDelay: 0,
    unpairedNotified: false,
  };
}

let seq = 0;
function waMessage(message: Record<string, unknown>) {
  seq += 1;
  return {
    key: { remoteJid: "100@s.whatsapp.net", id: `DOC${seq}`, fromMe: false },
    message,
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Alice",
  } as never;
}

/** A document the way current WhatsApp clients send one with a caption. */
function captionedDocument(
  fileName: string,
  mimetype: string,
  caption: string,
) {
  return waMessage({
    documentWithCaptionMessage: {
      message: {
        documentMessage: {
          url: "https://mmg.whatsapp.net/x",
          mimetype,
          fileName,
          caption,
          fileLength: 97902,
        },
      },
    },
  });
}

function lastPrompt(): string {
  const call = execute.mock.calls.at(-1);
  return call?.[0].prompt ?? "";
}

beforeEach(() => {
  resetMessageStore();
  resetWhatsAppRegistry();
  deleteChat(CHAT);
  execute.mockClear();
  downloadMediaMessage.mockReset();
  pdftotext.mockReset();
  pdftotext.mockImplementation((_a, cb) => cb(null, ""));
});

describe("inboundMediaFileName", () => {
  it("keeps the sender's name and a real extension", () => {
    expect(
      inboundMediaFileName(
        CHAT,
        7,
        { fileName: "Play pedagogy (final).pdf" },
        "bin",
      ),
    ).toBe("wa_dm_100_7-Play_pedagogy_final_.pdf");
  });

  it("maps Office MIME types to their extension when the name has none", () => {
    expect(
      inboundMediaFileName(
        CHAT,
        8,
        { fileName: "Essay", mimetype: DOCX_MIME },
        "bin",
      ),
    ).toBe("wa_dm_100_8-Essay.docx");
    expect(inboundMediaFileName(CHAT, 9, { mimetype: PDF_MIME }, "bin")).toBe(
      "wa_dm_100_9.pdf",
    );
  });

  it("cannot be steered out of the uploads dir", () => {
    const name = inboundMediaFileName(
      CHAT,
      10,
      { fileName: "../../.ssh/authorized_keys.txt" },
      "bin",
    );
    expect(name).toBe("wa_dm_100_10-authorized_keys.txt");
    expect(name).not.toContain("/");
  });
});

describe("saveInboundMedia", () => {
  it("downloads a document wrapped in documentWithCaptionMessage", async () => {
    downloadMediaMessage.mockResolvedValueOnce(Buffer.from("%PDF-1.4 essay"));
    const saved = await saveInboundMedia(
      captionedDocument("Essay.pdf", PDF_MIME, "my essay"),
      CHAT,
      42,
      "Alice",
    );
    expect(saved).toMatchObject({
      type: "document",
      fileName: "Essay.pdf",
      mimetype: PDF_MIME,
      caption: "my essay",
      size: 14,
    });
    expect(basename(saved!.filePath)).toBe("wa_dm_100_42-Essay.pdf");
    expect(saved!.filePath.startsWith(dirs.uploads)).toBe(true);
    expect(readFileSync(saved!.filePath, "utf8")).toBe("%PDF-1.4 essay");
  });
});

describe("a document reaching the model", () => {
  it("puts a captioned PDF's text and exact word count in the prompt", async () => {
    downloadMediaMessage.mockResolvedValueOnce(Buffer.from("%PDF-1.4"));
    pdftotext.mockImplementationOnce((_a, cb) =>
      cb(null, "Defining play pedagogy\fBenefits of play for children\f"),
    );
    await handleInbound(
      runtime() as never,
      captionedDocument("Essay.pdf", PDF_MIME, "can you count the words"),
    );

    const prompt = lastPrompt();
    expect(prompt).toContain("can you count the words");
    expect(prompt).toMatch(
      /\[attached document: "Essay\.pdf" \(application\/pdf, 8 B\), saved to: \S+wa_dm_100_\d+-Essay\.pdf\]/,
    );
    expect(prompt).toContain("8 words");
    expect(prompt).toContain("the full text is below");
    expect(prompt).toContain(
      "<document>\n--- page 1 ---\nDefining play pedagogy\n\n--- page 2 ---\nBenefits of play for children\n</document>",
    );
    // The file itself is on disk for tools that can read it.
    const path = /saved to: (\S+)\]/.exec(prompt)?.[1];
    expect(path && existsSync(path)).toBe(true);
    // History keeps the caption as the message text, plus the file.
    const [row] = getRecentHistory(CHAT, 1);
    expect(row).toMatchObject({
      text: "can you count the words",
      mediaType: "document",
    });
  });

  it("handles an uncaptioned document and says when there's no text", async () => {
    downloadMediaMessage.mockResolvedValueOnce(Buffer.from("%PDF-1.4"));
    pdftotext.mockImplementationOnce((_a, cb) => cb(null, "\f\f"));
    await handleInbound(
      runtime() as never,
      waMessage({
        documentMessage: { url: "u", mimetype: PDF_MIME, fileName: "scan.pdf" },
      }),
    );
    const prompt = lastPrompt();
    expect(prompt).toContain('[attached document: "scan.pdf"');
    expect(prompt).toMatch(/could not be extracted: the PDF has no text layer/);
  });

  it("attaches a word count to a long pasted message", async () => {
    const paste = Array.from({ length: 246 }, (_, i) => `w${i}`).join(" ");
    await handleInbound(runtime() as never, waMessage({ conversation: paste }));
    expect(lastPrompt()).toContain("[this message is 246 words");

    await handleInbound(
      runtime() as never,
      waMessage({ conversation: "short one" }),
    );
    expect(lastPrompt()).not.toContain("this message is");
  });
});

describe("download_media for a document", () => {
  it("returns the extracted text with the path", async () => {
    downloadMediaMessage.mockResolvedValueOnce(Buffer.from("one two three"));
    await handleInbound(
      runtime() as never,
      captionedDocument("notes.txt", "text/plain", "notes"),
    );
    const msgId = getRecentHistory(CHAT, 1)[0]!.msgId;
    const result = await historyHandlers.download_media(
      { message_id: msgId },
      900001,
      {
        sock: { updateMediaMessage: vi.fn() },
        gateway: { incrementMessages: vi.fn() },
        chat: {
          chatId: CHAT,
          numericChatId: 900001,
          jid: "100@s.whatsapp.net",
          isGroup: false,
        },
        scheduledMessages: new Map(),
      } as never,
    );
    expect(result).toMatchObject({ ok: true });
    expect(result?.text).toContain('[attached document: "notes.txt"');
    expect(result?.text).toContain("3 words");
    expect(result?.text).toContain("<document>\none two three\n</document>");
  });
});
