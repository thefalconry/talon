/**
 * Guest DM scope: a DM from someone who isn't an operator gets a
 * conversation-only tool surface, enforced in the hub.
 *
 * What would reveal a regression: a guest session that can list `bash`,
 * `send_via` or `create_cron_job`, or one whose `send` still accepts a
 * local `file_path` or another chat's id (the bridge honours an explicit
 * `chat_id`, so without the guard a guest could make the bot post
 * anywhere or send any readable file).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  initGuestDmScope,
  isGuestPluginAllowed,
  resolveTurnScope,
  guestParamViolation,
  GUEST_TOOL_ALLOWLIST,
} from "../core/mcp-hub/guest-scope.js";
import { buildTalonToolServer } from "../core/mcp-hub/talon-server.js";

const ADMIN = 111;

async function listToolsFor(guest: boolean, chatId = "999") {
  const server = buildTalonToolServer({
    frontend: "telegram",
    chatId,
    bridgeUrl: "http://127.0.0.1:1", // never reached in these tests
    includeNativeTools: true,
    guest,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  return { client, names: tools.map((t) => t.name) };
}

describe("DM classification", () => {
  beforeEach(() => {
    initGuestDmScope(
      { enabled: true, operatorChats: ["wa_dm_353000000001"] },
      ADMIN,
    );
  });

  const dm = (chatId: string, sender?: string) =>
    resolveTurnScope({
      chatId,
      isGroup: false,
      source: "message",
      senderKeys: sender ? [sender] : undefined,
    });

  it("treats the admin and operator chats as full access", () => {
    expect(dm(String(ADMIN), String(ADMIN))).toBe("operator");
    expect(dm("wa_dm_353000000001")).toBe("operator");
  });

  it("treats every other DM as a guest", () => {
    expect(dm("999", "999")).toBe("guest");
    expect(dm("wa_dm_353000000002", "wa_dm_353000000002")).toBe("guest");
  });

  it("is on by default, and off only when explicitly disabled", () => {
    initGuestDmScope(undefined, ADMIN);
    expect(dm("999", "999")).toBe("guest");
    initGuestDmScope({ enabled: false }, ADMIN);
    expect(dm("999", "999")).toBe("operator");
  });

  it("allows only the configured plugin servers", () => {
    expect(isGuestPluginAllowed("brave-search")).toBe(true);
    expect(isGuestPluginAllowed("extras-tools")).toBe(true);
    expect(isGuestPluginAllowed("email-tools")).toBe(false);
    expect(isGuestPluginAllowed("ssh-tools")).toBe(false);
    expect(isGuestPluginAllowed("mempalace-tools")).toBe(false);
  });
});

describe("guest parameter guard", () => {
  it("allows the guest's own chat and no chat at all", () => {
    expect(guestParamViolation("999", { text: "hi" })).toBeNull();
    expect(guestParamViolation("999", { chat_id: 999 })).toBeNull();
  });

  it("refuses another chat", () => {
    expect(guestParamViolation("999", { chat_id: -1009876543210 })).toMatch(
      /chat_id/,
    );
    expect(guestParamViolation("999", { to_chat_id: "111" })).toMatch(
      /to_chat_id/,
    );
  });

  it("refuses local files, including inside albums", () => {
    expect(
      guestParamViolation("999", {
        type: "file",
        file_path: "/home/user/.talon/config.json",
      }),
    ).toMatch(/file_path/);
    expect(
      guestParamViolation("999", {
        type: "album",
        media: [
          { type: "photo", url: "https://x/y.jpg" },
          { type: "photo", file_path: "/etc/passwd" },
        ],
      }),
    ).toMatch(/file_path/);
    expect(
      guestParamViolation("999", { type: "photo", url: "https://x/y.jpg" }),
    ).toBeNull();
  });
});

describe("hub tool server", () => {
  it("gives a guest only the allowlist", async () => {
    const { names } = await listToolsFor(true);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(GUEST_TOOL_ALLOWLIST.has(n)).toBe(true);
    for (const n of [
      "bash",
      "read",
      "write",
      "send_via",
      "forward_message",
      "create_cron_job",
      "remember",
      "recall",
      "spawn_agent",
      "device_exec",
      "fetch_url",
      "trigger_create",
    ]) {
      expect(names).not.toContain(n);
    }
    expect(names).toContain("end_turn");
    expect(names).toContain("send");
  });

  it("leaves the operator surface untouched", async () => {
    const { names } = await listToolsFor(false, String(ADMIN));
    expect(names).toContain("bash");
    expect(names).toContain("send_via");
    expect(names).toContain("create_cron_job");
  });

  it("refuses a guest send with a local file before it reaches the bridge", async () => {
    const { client } = await listToolsFor(true);
    const res = await client.callTool({
      name: "send",
      arguments: { type: "file", file_path: "/home/user/.talon/config.json" },
    });
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toMatch(/Not available in this chat: file_path/);
  });

  it("refuses a guest send to another chat", async () => {
    const { client } = await listToolsFor(true);
    const res = await client.callTool({
      name: "send",
      arguments: { type: "text", text: "hi", chat_id: "-1009876543210" },
    });
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toMatch(/Not available in this chat: chat_id/);
  });
});
