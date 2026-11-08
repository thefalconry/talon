/**
 * Claude Code's own in-process sub-agent tool (`Agent`, `Task` on older
 * builds) is disallowed for every Claude one-shot — heartbeat, dream,
 * cron/query jobs and Talon sub-agents — unless the deployment sets
 * `allowNativeSubagents`. Asserted on the options `runOneShotAgent` hands
 * the SDK's `query()`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() =>
    (async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: "",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    })(),
  ),
}));

const { runOneShotAgent, initClaudeOneShot } =
  await import("../backend/claude-sdk/one-shot.js");

async function optionsOfOneRun(): Promise<Record<string, unknown>> {
  vi.mocked(query).mockClear();
  await runOneShotAgent({
    prompt: "hello",
    systemPrompt: "you are a test",
    workspace: "/tmp",
    model: "sonnet",
    contextLabel: "heartbeat",
    abortController: new AbortController(),
    appendLog: async () => {},
  });
  const call = vi.mocked(query).mock.calls[0]?.[0] as
    { options: Record<string, unknown> } | undefined;
  if (!call) throw new Error("query() was not called");
  return call.options;
}

afterEach(() => {
  initClaudeOneShot({});
});

describe("Claude one-shot: native sub-agent tool", () => {
  it("is disallowed by default", async () => {
    initClaudeOneShot({});
    const options = await optionsOfOneRun();
    expect(options.disallowedTools).toEqual(["Agent", "Task"]);
    expect(options.tools).not.toContain("Agent");
  });

  it("is not disallowed with allowNativeSubagents: true", async () => {
    initClaudeOneShot({ allowNativeSubagents: true });
    const options = await optionsOfOneRun();
    expect(options.disallowedTools).toBeUndefined();
  });
});
