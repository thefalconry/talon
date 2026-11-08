/**
 * Rich Messages (Bot API 10.2) come back to the MTProto user client as
 * `messageMediaUnsupported` with no text, because gramjs negotiates an older
 * layer. Before this, every message the bot sent read back to the agent as
 * "[MessageMediaUnsupported]: (media)" — it could not see its own half of the
 * conversation, quote itself, or answer "which message did you mean?".
 *
 * The discriminator: a message with unsupported media and no text renders as
 * the text we recorded when we sent it, and an unsupported message we did NOT
 * send says so rather than claiming to be media.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  recordOutgoingText,
  outgoingText,
  resetOutgoingLog,
} from "../frontend/telegram/actions/outgoing-log.js";
import { messageBody, mediaTagFor } from "../frontend/telegram/userbot.js";

const richMessage = (id: number) => ({
  id,
  text: "",
  media: { className: "MessageMediaUnsupported" },
});

describe("rich message read-back", () => {
  beforeEach(() => resetOutgoingLog());

  it("renders a rich message we sent as the text we sent", () => {
    recordOutgoingText(-100123, 4242, "Branch is built and green.");
    expect(messageBody(richMessage(4242))).toBe("Branch is built and green.");
  });

  it("drops the media tag once the text is recovered", () => {
    recordOutgoingText(-100123, 4242, "Branch is built and green.");
    expect(mediaTagFor(richMessage(4242))).toBe("");
  });

  it("says what an unrecoverable rich message is, rather than 'media'", () => {
    const body = messageBody(richMessage(999));
    expect(body).toContain("rich message");
    expect(body).not.toBe("(media)");
    expect(mediaTagFor(richMessage(999))).toContain("MessageMediaUnsupported");
  });

  it("leaves real media alone", () => {
    const photo = {
      id: 7,
      text: "",
      media: { className: "MessageMediaPhoto" },
    };
    expect(messageBody(photo)).toBe("(media)");
    expect(mediaTagFor(photo)).toBe(" [MessageMediaPhoto]");
  });

  it("prefers the message's own text when Telegram gave us one", () => {
    recordOutgoingText(-100123, 5, "recorded");
    expect(messageBody({ id: 5, text: "actual", media: undefined })).toBe(
      "actual",
    );
  });

  it("evicts oldest first and keeps recent sends", () => {
    for (let i = 1; i <= 450; i++) recordOutgoingText(-1, i, `m${i}`);
    expect(outgoingText(1)).toBeUndefined();
    expect(outgoingText(450)).toBe("m450");
  });
});
