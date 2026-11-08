/**
 * Tests for shared prompt formatting.
 *
 * Every backend formats incoming user messages the same way. The format
 * is part of the public model-input contract (the system prompt teaches
 * the model what `[msg_id:N]` means etc.), so changes have to be
 * compatible across all backends.
 */

import { describe, expect, it } from "vitest";
import { formatUserPrompt } from "../backend/runtime/prompt/prompt-format.js";

// We can't easily mock `formatFullDatetime` without setting up a vitest
// spy; instead we accept the dynamic time tag and just assert the SHAPE.

// formatFullDatetime emits `YYYY-MM-DD HH:MM <weekday-3-letter> (<tz>)`,
// e.g. `2026-05-15 11:23 Fri (UTC)`. Match that shape — we don't care
// about the specific time, only the format.
const TIME_TAG_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Za-z]{3} \([^)]+\)\] /;

describe("formatUserPrompt", () => {
  it("DM with msg_id: `[time] [msg_id:N] text`", () => {
    const out = formatUserPrompt({
      text: "hello",
      senderName: "Ada",
      isGroup: false,
      messageId: 42,
    });
    expect(out).toMatch(TIME_TAG_RE);
    expect(out).toContain("[msg_id:42]");
    expect(out).toContain("hello");
  });

  it("group chat: `[time] [Name] [msg_id:N]: text`", () => {
    const out = formatUserPrompt({
      text: "hi all",
      senderName: "Paweł",
      isGroup: true,
      messageId: 99,
    });
    expect(out).toMatch(TIME_TAG_RE);
    expect(out).toContain("[Paweł] [msg_id:99]:");
    expect(out).toContain("hi all");
  });

  it("DM without msg_id: `[time] text`", () => {
    const out = formatUserPrompt({
      text: "no id here",
      senderName: "Ada",
      isGroup: false,
    });
    expect(out).toMatch(TIME_TAG_RE);
    expect(out).not.toContain("[msg_id");
    expect(out).toContain("no id here");
  });

  it("group without msg_id: `[time] [Name]: text`", () => {
    const out = formatUserPrompt({
      text: "anon group msg",
      senderName: "Risen",
      isGroup: true,
    });
    expect(out).toMatch(TIME_TAG_RE);
    expect(out).toContain("[Risen]:");
    expect(out).not.toContain("[msg_id");
  });

  it("omitTimeTag drops the leading time bracket", () => {
    const out = formatUserPrompt({
      text: "no time",
      senderName: "Ada",
      isGroup: false,
      omitTimeTag: true,
    });
    expect(out).not.toMatch(TIME_TAG_RE);
    expect(out.startsWith("[")).toBe(false);
    expect(out).toBe("no time");
  });

  it("group with a handle: `[time] [Name (@handle)] [msg_id:N]: text`", () => {
    const out = formatUserPrompt({
      text: "ping me properly",
      senderName: "Paweł",
      senderHandle: "PawiX25",
      isGroup: true,
      messageId: 7,
    });
    expect(out).toContain("[Paweł (@PawiX25)] [msg_id:7]:");
  });

  it("a handle that already carries @ is not doubled up", () => {
    const out = formatUserPrompt({
      text: "hi",
      senderName: "Risen",
      senderHandle: "@RisenID",
      isGroup: true,
    });
    expect(out).toContain("[Risen (@RisenID)]:");
    expect(out).not.toContain("@@");
  });

  it("blank handle falls back to the bare name", () => {
    const out = formatUserPrompt({
      text: "hi",
      senderName: "Risen",
      senderHandle: "   ",
      isGroup: true,
    });
    expect(out).toContain("[Risen]:");
    expect(out).not.toContain("(@");
  });

  it("DMs stay handle-free — Telegram already shows who is talking", () => {
    const out = formatUserPrompt({
      text: "dm",
      senderName: "Ada",
      senderHandle: "ada",
      isGroup: false,
      messageId: 3,
    });
    expect(out).not.toContain("@ada");
  });

  it("string messageId works (Discord snowflake)", () => {
    const out = formatUserPrompt({
      text: "snowflake",
      senderName: "Ada",
      isGroup: false,
      messageId: "1234567890123456789",
    });
    expect(out).toContain("[msg_id:1234567890123456789]");
  });
});
