/**
 * The orphan sweep issues SIGKILL, so its victim-selection rule gets its own
 * test. Regression: matching on `TALON_CHAT_ID` alone also selected the
 * chat's trigger watchers, which carry the same env var. Every sweep killed
 * them, the warden respawned them, and the next sweep killed them again —
 * the trigger just showed "errored" with no output.
 */

import { describe, expect, it } from "vitest";
import { isEvictableOrphan } from "../backend/claude-sdk/one-shot.js";

const CHAT = "-1001426819337";
const TARGET = `TALON_CHAT_ID=${CHAT}`;
const CLAUDE_ARGV = [
  "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
  "--output-format",
  "stream-json",
];

describe("isEvictableOrphan", () => {
  it("evicts a claude SDK subprocess carrying the chat id", () => {
    expect(
      isEvictableOrphan(["PATH=/usr/bin", TARGET], CLAUDE_ARGV, TARGET),
    ).toBe(true);
  });

  it("spares a trigger watcher even though it carries the chat id", () => {
    const env = [TARGET, "TALON_TRIGGER_ID=trig_abc", "TALON_TRIGGER_NAME=x"];
    expect(
      isEvictableOrphan(env, ["/usr/bin/python3", "watch.py"], TARGET),
    ).toBe(false);
  });

  it("spares a claude run spawned by another daemon that is still alive", () => {
    // The parent test runner stands in for a live daemon that is not us.
    const env = [TARGET, `TALON_DAEMON_PID=${process.ppid}`];
    expect(isEvictableOrphan(env, CLAUDE_ARGV, TARGET)).toBe(false);
  });

  it("evicts a claude run whose daemon is gone", () => {
    const env = [TARGET, "TALON_DAEMON_PID=2147483646"];
    expect(isEvictableOrphan(env, CLAUDE_ARGV, TARGET)).toBe(true);
  });

  it("spares a trigger's descendant, which inherits both vars", () => {
    const env = [TARGET, "TALON_TRIGGER_ID=trig_abc"];
    expect(isEvictableOrphan(env, CLAUDE_ARGV, TARGET)).toBe(false);
  });

  it("spares a chat-scoped plugin child that is not the claude binary", () => {
    const env = [TARGET, "TALON_PLUGIN=brave-search"];
    expect(
      isEvictableOrphan(env, ["node", "/app/plugins/brave/index.js"], TARGET),
    ).toBe(false);
  });

  it("ignores a process belonging to a different chat", () => {
    expect(isEvictableOrphan(["TALON_CHAT_ID=999"], CLAUDE_ARGV, TARGET)).toBe(
      false,
    );
  });

  it("does not match a chat id embedded in another variable's value", () => {
    const env = [`LOG_PATH=/logs/${CHAT}/run.log`];
    expect(isEvictableOrphan(env, CLAUDE_ARGV, TARGET)).toBe(false);
  });
});
