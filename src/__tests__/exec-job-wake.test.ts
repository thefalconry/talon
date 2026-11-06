import { describe, it, expect, vi } from "vitest";
import { makeExecJobWake } from "../core/mesh/devices/exec-job-wake.js";
import { numericChatIdFor } from "../core/frontend-runtime/chat-id.js";

const logError = vi.hoisted(() => vi.fn());
vi.mock("../util/log.js", async (orig) => ({
  ...(await orig<typeof import("../util/log.js")>()),
  logError,
}));

describe("makeExecJobWake", () => {
  it("runs a turn in the job's own chat, keeping a string id", () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    makeExecJobWake(execute)("native_abc", "job done");
    expect(execute).toHaveBeenCalledWith({
      chatId: "native_abc",
      numericChatId: numericChatIdFor("native_abc"),
      prompt: "job done",
      senderName: "Device",
      isGroup: false,
      source: "agent",
    });
  });

  it("logs a failed wake turn instead of rejecting", async () => {
    logError.mockClear();
    const execute = vi.fn().mockRejectedValue(new Error("backend down"));
    makeExecJobWake(execute)("42", "job done");
    await vi.waitFor(() => expect(logError).toHaveBeenCalledOnce());
    expect(logError.mock.calls[0]?.[1]).toContain("chat 42");
  });
});
