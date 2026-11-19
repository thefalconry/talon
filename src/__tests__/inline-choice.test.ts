/**
 * Core inline-button questions (core/engine/inline-choice.ts):
 * the message goes out through a frontend's action handler, a click comes
 * back through `resolveInlineChoice`, and the message is edited after.
 */

import { describe, expect, it, vi } from "vitest";
import type { FrontendActionHandler } from "../core/types.js";
import {
  askInlineChoice,
  resolveInlineChoice,
  sendInlineChoice,
} from "../core/engine/inline-choice.js";

const BUTTONS = [
  { id: "wait", label: "Wait" },
  { id: "abort", label: "Stop" },
];

function fakeHandler(ok = true) {
  const calls: Record<string, unknown>[] = [];
  const handler = vi.fn<FrontendActionHandler>(async (body) => {
    calls.push(body);
    return ok ? { ok: true, message_id: 42 } : { ok: false, error: "no" };
  });
  return { handler, calls };
}

function callbackOf(body: Record<string, unknown>, index: number): string {
  const rows = body.rows as { callback_data: string }[][];
  return rows[0]![index]!.callback_data;
}

describe("sendInlineChoice", () => {
  it("sends one row of buttons and resolves the clicked choice", async () => {
    const h = fakeHandler();
    const signal = new AbortController().signal;
    const handle = await sendInlineChoice(h.handler, 7, {
      text: "Q?",
      buttons: BUTTONS,
      signal,
    });
    expect(h.calls[0]).toMatchObject({
      action: "send_message_with_buttons",
      text: "Q?",
    });
    const data = callbackOf(h.calls[0]!, 1);
    expect(data).toMatch(/^ichoice:[0-9a-f]+:abort$/);
    expect(resolveInlineChoice(data)).toBe(true);
    expect(await handle!.choice).toBe("abort");
    // Answered: a second click is stale.
    expect(resolveInlineChoice(data)).toBe(false);

    await handle!.update("done");
    expect(h.calls[1]).toEqual({
      action: "edit_message",
      message_id: 42,
      text: "done",
    });
  });

  it("resolves undefined once the signal aborts (timeout / moot)", async () => {
    const h = fakeHandler();
    const ac = new AbortController();
    const handle = await sendInlineChoice(h.handler, 7, {
      text: "Q?",
      buttons: BUTTONS,
      signal: ac.signal,
    });
    ac.abort();
    expect(await handle!.choice).toBeUndefined();
    expect(resolveInlineChoice(callbackOf(h.calls[0]!, 0))).toBe(false);
  });

  it("answers undefined when the send failed", async () => {
    const h = fakeHandler(false);
    expect(
      await sendInlineChoice(h.handler, 7, {
        text: "Q?",
        buttons: BUTTONS,
        signal: new AbortController().signal,
      }),
    ).toBeUndefined();
  });

  it("rejects malformed and unknown callback data", () => {
    expect(resolveInlineChoice("ichoice:")).toBe(false);
    expect(resolveInlineChoice("ichoice:nope:wait")).toBe(false);
    expect(resolveInlineChoice("model:x")).toBe(false);
  });
});

describe("askInlineChoice", () => {
  it("asks nothing on a frontend that does not route the clicks back", async () => {
    expect(
      await askInlineChoice("discord", 7, {
        text: "Q?",
        buttons: BUTTONS,
        signal: new AbortController().signal,
      }),
    ).toBeUndefined();
  });
});
