import { describe, it, expect } from "vitest";
import { ALL_TOOLS, composeTools } from "../core/tools/index.js";
import type { ToolFrontend, ToolTag } from "../core/tools/types.js";

/**
 * The exact tool list, in order, as the model sees it.
 *
 * `ALL_TOOLS` is serialised into every request's tool block, which sits
 * in the prompt-cache prefix: reordering it — or adding/removing an
 * entry anywhere but the end — invalidates the cached prefix of every
 * live chat and re-bills the whole system prompt. Grouping the catalogue
 * into `chat/`, `ops/` and `content/` was meant to be a pure file move,
 * so this list is pinned here. A deliberate catalogue change updates it
 * in the same commit and accepts the cache miss; an accidental regroup
 * fails here instead of silently on everyone's next turn.
 */
const ALL_TOOLS_ORDER = [
  "end_turn",
  "send",
  "send_message",
  "send_message_with_buttons",
  "react",
  "edit_message",
  "delete_message",
  "forward_message",
  "copy_message",
  "pin_message",
  "unpin_message",
  "stop_poll",
  "get_chat_info",
  "get_chat_admins",
  "get_chat_member_count",
  "set_chat_title",
  "set_chat_description",
  "read_chat_history",
  "search_chat_history",
  "get_user_messages",
  "get_message_by_id",
  "download_media",
  "list_chat_members",
  "get_member_info",
  "online_count",
  "get_pinned_messages",
  "list_media",
  "get_sticker_pack",
  "download_sticker",
  "save_sticker_pack",
  "create_sticker_set",
  "add_sticker_to_set",
  "delete_sticker_from_set",
  "set_sticker_set_title",
  "delete_sticker_set",
  "cancel_scheduled",
  "list_scheduled",
  "create_cron_job",
  "list_cron_jobs",
  "edit_cron_job",
  "run_cron_job",
  "delete_cron_job",
  "trigger_create",
  "trigger_list",
  "trigger_cancel",
  "trigger_logs",
  "trigger_delete",
  "add_goal",
  "list_goals",
  "update_goal",
  "delete_goal",
  "remember",
  "recall",
  "forget",
  "save_script",
  "list_scripts",
  "run_script",
  "delete_script",
  "save_skill",
  "list_skills",
  "find_skills",
  "read_skill",
  "delete_skill",
  "fetch_url",
  "reload_plugins",
  "list_models",
  "plan_usage",
  "list_backends",
  "list_devices",
  "get_device_location",
  "get_device_history",
  "ring_device",
  "remove_device",
  "get_device_status",
  "device_exec",
  "device_computer",
  "device_list_dir",
  "device_read_file",
  "device_write_file",
  "device_pull_file",
  "device_push_file",
  "update_device",
  "update_node",
  "get_node_binary",
  "make_node_install_link",
  // Companion pairing (the agent twin of /mesh pair) sits beside the node
  // installer it mirrors: one deliberate cache miss, taken with a release
  // that restarts the daemon (and so cools every live prefix) anyway.
  "make_companion_pair_link",
  "send_via",
  "whatsapp_account",
  "moderate",
  "get_user_profile_photos",
  // Sub-agents (#feat/sub-agents) — appended, so the cached prefix of every
  // live chat stays valid.
  "spawn_agent",
  "list_agents",
  "agent_status",
  "wait_for_agent",
  "send_to_agent",
  "kill_agent",
  "report_result",
  "message_parent",
  // Peer channel (2026-09-25). Inserted beside the other agent-side tools
  // rather than appended at the end of the catalogue: grouping is worth one
  // deliberate cache miss, and the release that ships it restarts the daemon
  // anyway, so every live prefix is cold at that point regardless.
  "list_peers",
  "message_peer",
  "check_inbox",
  // Appended for the backup subsystem — at the END, so the prompt-cache
  // prefix of every live chat survives the addition.
  "create_checkpoint",
  "list_checkpoints",
  "backup_status",
  // Pre-flight lane (feat/agent-preflight) — appended at the end.
  "run_preflight",
  // Secret drop (feat/secret-drop) — appended at the end.
  "request_secret",
];

describe("ALL_TOOLS registry", () => {
  it("keeps the exact prompt-cache prefix order", () => {
    expect(ALL_TOOLS.map((t) => t.name)).toEqual(ALL_TOOLS_ORDER);
  });

  it("contains tools from every domain", () => {
    const tags = new Set(ALL_TOOLS.map((t) => t.tag));
    expect(tags).toContain("messaging");
    expect(tags).toContain("chat");
    expect(tags).toContain("history");
    expect(tags).toContain("members");
    expect(tags).toContain("media");
    expect(tags).toContain("stickers");
    expect(tags).toContain("scheduling");
    expect(tags).toContain("triggers");
    expect(tags).toContain("goals");
    expect(tags).toContain("memory");
    expect(tags).toContain("web");
  });

  it("has no duplicate tool names", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every tool has required fields", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.schema).toBeDefined();
      expect(typeof tool.execute).toBe("function");
      expect(tool.tag).toBeTruthy();
    }
  });
});

describe("composeTools()", () => {
  it("returns all tools when no options are given", () => {
    const tools = composeTools();
    expect(tools).toHaveLength(ALL_TOOLS.length);
  });

  it("returns a new array (not a reference to ALL_TOOLS)", () => {
    const tools = composeTools();
    expect(tools).not.toBe(ALL_TOOLS);
  });

  // ── Frontend filtering ────────────────────────────────────────────────

  it("filters tools by telegram frontend", () => {
    const tools = composeTools({ frontend: "telegram" });
    // Should include telegram-specific and universal tools
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.length).toBeLessThan(ALL_TOOLS.length);

    for (const t of tools) {
      const f = t.frontends;
      expect(!f || f.includes("all") || f.includes("telegram")).toBe(true);
    }
  });

  it("filters tools by teams frontend", () => {
    const tools = composeTools({ frontend: "teams" });
    expect(tools.length).toBeGreaterThan(0);

    for (const t of tools) {
      const f = t.frontends;
      expect(!f || f.includes("all") || f.includes("teams")).toBe(true);
    }
  });

  it("excludes telegram-only tools from teams", () => {
    const teamsTools = composeTools({ frontend: "teams" });
    const teamsNames = new Set(teamsTools.map((t) => t.name));

    // react is telegram-only
    expect(teamsNames.has("react")).toBe(false);
    // send_message is teams-only — should be present
    expect(teamsNames.has("send_message")).toBe(true);
  });

  it("excludes teams-only tools from telegram", () => {
    const tgTools = composeTools({ frontend: "telegram" });
    const tgNames = new Set(tgTools.map((t) => t.name));

    // send_message is teams-only
    expect(tgNames.has("send_message")).toBe(false);
    // send is telegram-only — should be present
    expect(tgNames.has("send")).toBe(true);
  });

  it("includes universal tools (no frontends set) for any frontend", () => {
    const universalTools = ALL_TOOLS.filter((t) => !t.frontends);
    expect(universalTools.length).toBeGreaterThan(0);

    for (const frontend of [
      "telegram",
      "teams",
      "terminal",
    ] as ToolFrontend[]) {
      const tools = composeTools({ frontend });
      const names = new Set(tools.map((t) => t.name));
      for (const ut of universalTools) {
        expect(names.has(ut.name)).toBe(true);
      }
    }
  });

  it("includes tools with frontends: ['all'] for any frontend", () => {
    const allFrontendTools = ALL_TOOLS.filter((t) =>
      t.frontends?.includes("all"),
    );
    // Even if there are none right now, the filter logic is tested via universal tools
    for (const frontend of [
      "telegram",
      "teams",
      "terminal",
    ] as ToolFrontend[]) {
      const tools = composeTools({ frontend });
      const names = new Set(tools.map((t) => t.name));
      for (const t of allFrontendTools) {
        expect(names.has(t.name)).toBe(true);
      }
    }
  });

  // ── Tag filtering ─────────────────────────────────────────────────────

  it("filters by tags (include)", () => {
    const tools = composeTools({ tags: ["web"] });
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.tag).toBe("web");
    }
  });

  it("filters by multiple tags", () => {
    const tools = composeTools({ tags: ["web", "scheduling"] });
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(["web", "scheduling"]).toContain(t.tag);
    }
  });

  it("filters by excludeTags", () => {
    const tools = composeTools({ excludeTags: ["stickers", "media"] });
    for (const t of tools) {
      expect(t.tag).not.toBe("stickers");
      expect(t.tag).not.toBe("media");
    }
    expect(tools.length).toBeLessThan(ALL_TOOLS.length);
  });

  // ── Name exclusion ────────────────────────────────────────────────────

  it("excludes tools by name", () => {
    const tools = composeTools({ excludeNames: ["send", "react"] });
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("send")).toBe(false);
    expect(names.has("react")).toBe(false);
    expect(tools.length).toBe(ALL_TOOLS.length - 2);
  });

  // ── Combined filters ──────────────────────────────────────────────────

  it("combines frontend + tag filters", () => {
    const tools = composeTools({ frontend: "telegram", tags: ["messaging"] });
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.tag).toBe("messaging");
      const f = t.frontends;
      expect(!f || f.includes("all") || f.includes("telegram")).toBe(true);
    }
    // Should NOT include teams send_message
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("send_message")).toBe(false);
  });

  it("combines frontend + excludeTags", () => {
    const tools = composeTools({
      frontend: "telegram",
      excludeTags: ["stickers"],
    });
    for (const t of tools) {
      expect(t.tag).not.toBe("stickers");
    }
  });

  it("combines frontend + excludeNames", () => {
    const tools = composeTools({
      frontend: "telegram",
      excludeNames: ["fetch_url"],
    });
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("fetch_url")).toBe(false);
    expect(names.has("send")).toBe(true);
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it("returns empty array when tags match nothing", () => {
    const tools = composeTools({ tags: ["nonexistent" as ToolTag] });
    expect(tools).toEqual([]);
  });

  it("returns all tools when excludeNames is empty", () => {
    const tools = composeTools({ excludeNames: [] });
    expect(tools).toHaveLength(ALL_TOOLS.length);
  });

  it("returns all tools when excludeTags is empty", () => {
    const tools = composeTools({ excludeTags: [] });
    expect(tools).toHaveLength(ALL_TOOLS.length);
  });
});
