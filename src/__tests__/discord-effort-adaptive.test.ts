/**
 * Discord /effort adaptive on a model with no reasoning levels.
 *
 * The "no reasoning levels" guard ran before the adaptive branch, so a
 * model that registers no levels could never be reset to adaptive — the
 * one value that needs no levels at all. Same for the effort select.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
const setChatEffort = vi.hoisted(() => vi.fn());
vi.mock("../storage/chat-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage/chat-settings.js")>()),
  getChatSettings: vi.fn(() => ({ effort: "high" })),
  setChatEffort,
}));
vi.mock(
  "../core/engine/backend-controller/index.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../core/engine/backend-controller/index.js")
    >()),
    getBackendIdForChat: vi.fn(() => "opencode"),
    resolveChatBackend: vi.fn(() => null),
  }),
);
vi.mock(
  "../frontend/presentation/reasoning-levels.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../frontend/presentation/reasoning-levels.js")
    >()),
    getActiveReasoningLevels: vi.fn(async () => ({
      activeModel: "glm-5",
      levels: [],
    })),
  }),
);

import { handleEffort } from "../frontend/discord/commands/settings.js";
import { handleEffortComponent } from "../frontend/discord/callbacks/components/effort.js";

function slash(level: string | null) {
  const replies: string[] = [];
  const i = {
    deferred: false,
    replied: false,
    options: { getString: () => level },
    reply: vi.fn(async (o: { content: string }) => {
      replies.push(o.content);
    }),
    followUp: vi.fn(),
  };
  return { i, replies };
}

beforeEach(() => setChatEffort.mockClear());

describe("Discord /effort with no model levels", () => {
  it("resets to adaptive", async () => {
    const { i, replies } = slash("adaptive");
    await handleEffort(i as never, {} as never, {} as never, "c1");
    expect(setChatEffort).toHaveBeenCalledWith("c1", undefined);
    expect(replies[0]).toContain("adaptive");
  });

  it("still refuses a concrete level", async () => {
    const { i, replies } = slash("high");
    await handleEffort(i as never, {} as never, {} as never, "c1");
    expect(setChatEffort).not.toHaveBeenCalled();
    expect(replies[0]).toContain("No valid reasoning levels");
  });

  it("the effort select accepts adaptive", async () => {
    const update = vi.fn(async () => {});
    const interaction = {
      customId: "effort:select",
      isStringSelectMenu: () => true,
      values: ["adaptive"],
      update,
    };
    const handled = await handleEffortComponent(
      interaction as never,
      {
        config: {},
        gateway: null,
        chatId: "c1",
      } as never,
    );
    expect(handled).toBe(true);
    expect(setChatEffort).toHaveBeenCalledWith("c1", undefined);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ content: "**Effort:** adaptive" }),
    );
  });
});
