import { describe, it, expect, vi } from "vitest";

vi.mock("telegram", () => ({ TelegramClient: class {}, Api: {} }));
vi.mock("telegram/sessions/index.js", () => ({ StringSession: class {} }));

const { withTimeout } = await import("../frontend/telegram/userbot.js");

describe("userbot withTimeout", () => {
  it("resolves with the inner value when it settles in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "x")).resolves.toBe(42);
  });

  it("rejects with a named timeout when the inner promise hangs (the reconnect wedge)", async () => {
    const hang = new Promise<never>(() => {});
    await expect(withTimeout(hang, 20, "reconnect")).rejects.toThrow(
      "reconnect timed out after 20ms",
    );
  });

  it("propagates the inner rejection", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("boom")), 1000, "x"),
    ).rejects.toThrow("boom");
  });
});
