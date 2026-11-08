/**
 * Unit tests for the `end_turn` tool and the cross-tool dedup helpers used to
 * suppress duplicate deliveries when the model calls both `end_turn` and
 * `send(type="text")` with similar content in the same turn.
 *
 * Covers:
 *   - normalizeForDedupe / isDuplicateOfDelivered (dedup math)
 *   - end_turn tool definition (schema, dispatch, silent path)
 *   - StreamState carries lastTrailingText and deliveredTextNorms
 */

import { describe, it, expect, vi } from "vitest";
import {
  normalizeForDedupe,
  isDuplicateOfDelivered,
  createStreamState,
  processAssistantMessage,
} from "../backend/claude-sdk/stream.js";
import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { messagingTools } from "../core/tools/chat/messaging.js";
import {
  isDeliveryTool,
  isTurnTerminator,
  stripMcpPrefix,
  ALL_TOOLS,
} from "../core/tools/index.js";

describe("normalizeForDedupe", () => {
  it("trims, lowercases, and collapses whitespace", () => {
    expect(normalizeForDedupe("  Hello   World  ")).toBe("hello world");
    expect(normalizeForDedupe("HELLO\n\tWORLD")).toBe("hello world");
  });

  it("strips emoji so prose-with-emoji matches messaging-tool-text", () => {
    expect(normalizeForDedupe("Got it 👍")).toBe("got it");
    expect(normalizeForDedupe("Done ✅ and dusted")).toBe("done and dusted");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeForDedupe("   \n\t  ")).toBe("");
  });
});

describe("isDuplicateOfDelivered", () => {
  it("returns false when nothing has been delivered yet", () => {
    expect(isDuplicateOfDelivered("hello there", [])).toBe(false);
  });

  it("returns false for very short candidates (below dedup threshold)", () => {
    // Below MIN_DEDUP_LENGTH (10) — short replies like "ok" / "sure" should
    // never be deduped, even if they happened to coincide with a longer
    // delivered text containing them.
    expect(isDuplicateOfDelivered("ok", ["ok thanks pal"])).toBe(false);
  });

  it("matches when normalized candidate is a substring of delivered", () => {
    const delivered = [normalizeForDedupe("Got it sur, pushing now")];
    expect(isDuplicateOfDelivered("Got it sur, pushing now", delivered)).toBe(
      true,
    );
  });

  it("matches when normalized delivered is a substring of candidate", () => {
    // Model called end_turn(text="Pushing now") then wrote prose
    // "I'm pushing now and back in a sec." — fuzzy match catches this.
    const delivered = [normalizeForDedupe("Pushing now")];
    expect(
      isDuplicateOfDelivered("I'm pushing now and back in a sec.", delivered),
    ).toBe(true);
  });

  it("does not match unrelated content", () => {
    const delivered = [normalizeForDedupe("PR #106 merged")];
    expect(
      isDuplicateOfDelivered("Got it, I'll look at the docker logs", delivered),
    ).toBe(false);
  });

  it("ignores emoji differences when comparing", () => {
    // Model wrote "Done 🎉" as prose, also called end_turn(text="Done")
    const delivered = [normalizeForDedupe("Done")];
    expect(isDuplicateOfDelivered("Done 🎉", delivered)).toBe(false);
    // Above is false because "done" (3 chars) < MIN_DEDUP_LENGTH (10).
    // For a longer match:
    const longDelivered = [normalizeForDedupe("All set, pushing now")];
    expect(
      isDuplicateOfDelivered("All set, pushing now 🚀", longDelivered),
    ).toBe(true);
  });
});

describe("createStreamState", () => {
  it("initializes lastTrailingText and deliveredTextNorms", () => {
    const state = createStreamState();
    expect(state.lastTrailingText).toBe("");
    expect(state.deliveredTextNorms).toEqual([]);
  });

  it("initializes turnTerminated to false", () => {
    const state = createStreamState();
    expect(state.turnTerminated).toBe(false);
  });
});

describe("turn-terminator declaration", () => {
  it("end_turn is declared with endsTurn: true", () => {
    const endTurn = messagingTools.find((t) => t.name === "end_turn");
    expect(endTurn?.endsTurn).toBe(true);
  });

  it("react is declared with endsTurn: true (default terminator)", () => {
    // Reacting is itself a final delivery — the user sees the emoji land on
    // their message, equivalent to receiving a reply. Marking react as a
    // terminator collapses the (react + silent end_turn) pattern into a
    // single tool call and fixes a bug where react+end_turn batches could
    // leave the SDK loop running past the terminator. The soft-terminator
    // override (`end_turn: false`) lets the model opt out — see the
    // isTurnTerminator tests below.
    const react = messagingTools.find((t) => t.name === "react");
    expect(react?.endsTurn).toBe(true);
  });

  it("react schema includes optional end_turn boolean for soft opt-out", () => {
    // The opt-out param is what makes react a SOFT terminator — model can
    // pass end_turn: false to react and keep the turn alive.
    const react = messagingTools.find((t) => t.name === "react");
    expect(react?.schema).toBeDefined();
    expect(react?.schema.end_turn).toBeDefined();
  });

  it("send is NOT declared as a turn terminator", () => {
    // `send` is for mid-turn rich content (photos, polls, scheduled messages,
    // etc.) — calling it does NOT mean the model is done. Only end_turn
    // and react declare the turn finished.
    const send = messagingTools.find((t) => t.name === "send");
    expect(send?.endsTurn).toBeFalsy();
  });

  it("isTurnTerminator returns true for end_turn", () => {
    expect(isTurnTerminator("end_turn")).toBe(true);
  });

  it("isTurnTerminator returns true for react (name-only, no input)", () => {
    expect(isTurnTerminator("react")).toBe(true);
  });

  it("isTurnTerminator returns true for react with end_turn omitted (defaults true)", () => {
    expect(isTurnTerminator("react", { message_id: 1, emoji: "👍" })).toBe(
      true,
    );
  });

  it("isTurnTerminator returns true for react with end_turn: true (explicit)", () => {
    expect(
      isTurnTerminator("react", {
        message_id: 1,
        emoji: "👍",
        end_turn: true,
      }),
    ).toBe(true);
  });

  it("isTurnTerminator returns FALSE for react with end_turn: false (soft opt-out)", () => {
    // The whole point of the soft-terminator design: model can react and
    // keep the turn alive (e.g. react with 🤔, then look something up).
    expect(
      isTurnTerminator("react", {
        message_id: 1,
        emoji: "🤔",
        end_turn: false,
      }),
    ).toBe(false);
    // Same with the MCP-prefixed form.
    expect(
      isTurnTerminator("mcp__telegram-tools__react", {
        message_id: 1,
        emoji: "🤔",
        end_turn: false,
      }),
    ).toBe(false);
  });

  it("isTurnTerminator ignores end_turn: false on end_turn itself", () => {
    // end_turn is a strict terminator — there's no opt-out for it.
    // (Defensive: the soft override is react-only by design.)
    expect(isTurnTerminator("end_turn", { end_turn: false })).toBe(true);
  });

  it("isTurnTerminator returns false for non-terminator tools", () => {
    expect(isTurnTerminator("send")).toBe(false);
    expect(isTurnTerminator("fetch_url")).toBe(false);
    expect(isTurnTerminator("edit_message")).toBe(false);
    expect(isTurnTerminator("nonexistent_tool")).toBe(false);
  });

  it("isTurnTerminator handles MCP-prefixed names", () => {
    // Tools served through MCP arrive with a `mcp__<server>__` prefix.
    // The check must normalize the prefix so the SDK's actual tool names
    // match the registry. Without this, downstream branches gated on
    // `state.turnTerminated` silently never fire — the flow-violation
    // re-prompt skip and trailing-prose dedup both break.
    expect(isTurnTerminator("mcp__telegram-tools__end_turn")).toBe(true);
    expect(isTurnTerminator("mcp__teams-tools__end_turn")).toBe(true);
    // react is also a terminator — same prefix-strip logic must catch it.
    expect(isTurnTerminator("mcp__telegram-tools__react")).toBe(true);
    // Non-terminators with the same prefix shape still return false
    expect(isTurnTerminator("mcp__telegram-tools__send")).toBe(false);
    expect(isTurnTerminator("mcp__telegram-tools__edit_message")).toBe(false);
    // Server name with hyphen + underscore must still match the boundary
    expect(isTurnTerminator("mcp__some-server-name__end_turn")).toBe(true);
  });

  it("stripMcpPrefix strips the mcp__<server>__ prefix when present", () => {
    expect(stripMcpPrefix("mcp__telegram-tools__end_turn")).toBe("end_turn");
    expect(stripMcpPrefix("mcp__brave-search__brave_web_search")).toBe(
      "brave_web_search",
    );
    // Non-greedy match takes the FIRST `__` after `mcp__` as the boundary
    expect(stripMcpPrefix("mcp__a__b__c")).toBe("b__c");
  });

  it("stripMcpPrefix returns input unchanged when no prefix matches", () => {
    expect(stripMcpPrefix("end_turn")).toBe("end_turn");
    expect(stripMcpPrefix("send")).toBe("send");
    expect(stripMcpPrefix("Read")).toBe("Read");
    // Looks like a prefix but missing the trailing `__`
    expect(stripMcpPrefix("mcp__incomplete")).toBe("mcp__incomplete");
  });

  it("stripMcpPrefix handles Kilo's `<server>_<bare>` convention", () => {
    // Kilo / OpenCode use `<server-name>_<tool>` instead of MCP's
    // canonical `mcp__<server>__<tool>`. Without this branch every
    // tool-delivered reply was being duplicated by the handler's
    // text-part fallback because `captureDeliveredText` failed to
    // recognise the tool as a delivery tool. Walk underscore boundaries
    // from the right and match against the registered tool catalog.
    expect(stripMcpPrefix("talon-tools-424242420_send")).toBe("send");
    expect(stripMcpPrefix("talon-tools-424242420_end_turn")).toBe("end_turn");
    expect(stripMcpPrefix("talon-tools-heartbeat_react")).toBe("react");
    // Bare-name suffix `turn` is NOT a tool — must NOT mis-resolve
    // `..._end_turn` as `turn`.
    expect(stripMcpPrefix("foo_end_turn")).toBe("end_turn");
  });

  it("stripMcpPrefix leaves unknown Kilo-style names alone", () => {
    // No `_<bare>` suffix that matches the registered tool set →
    // return the input unchanged so callers can decide what to do.
    expect(stripMcpPrefix("talon-tools-424242420_unknown_tool")).toBe(
      "talon-tools-424242420_unknown_tool",
    );
  });

  it("turn terminators are exactly: end_turn, react", () => {
    // If a future change adds a third terminator, this test should fail
    // and the author should document why a new terminator is necessary.
    // Current set:
    //   - end_turn: explicit final-reply tool, the documented happy path
    //   - react: emoji reaction IS the delivery; user sees the emoji land
    //     on their message and that's a complete acknowledgement turn
    const terminators = ALL_TOOLS.filter((t) => t.endsTurn).map((t) => t.name);
    expect(terminators.sort()).toEqual(["end_turn", "react"]);
  });
});

describe("end_turn tool definition", () => {
  const endTurn = messagingTools.find((t) => t.name === "end_turn");

  it("is registered in messagingTools", () => {
    expect(endTurn).toBeDefined();
    expect(endTurn?.tag).toBe("messaging");
    expect(endTurn?.frontends).toEqual([
      "telegram",
      "teams",
      "discord",
      "native",
      "whatsapp",
    ]);
  });

  it("has text, reply_to, and buttons schema fields", () => {
    expect(endTurn?.schema).toBeDefined();
    expect(endTurn?.schema.text).toBeDefined();
    expect(endTurn?.schema.reply_to).toBeDefined();
    expect(endTurn?.schema.buttons).toBeDefined();
  });

  it("dispatches plain text via send_message bridge", async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    await endTurn!.execute({ text: "Hello sur" }, bridge);
    expect(bridge).toHaveBeenCalledWith("send_message", {
      text: "Hello sur",
      reply_to_message_id: undefined,
    });
  });

  it("dispatches text + reply_to via send_message bridge", async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    await endTurn!.execute({ text: "Yep", reply_to: 12345 }, bridge);
    expect(bridge).toHaveBeenCalledWith("send_message", {
      text: "Yep",
      reply_to_message_id: 12345,
    });
  });

  it("dispatches text + buttons via send_message_with_buttons bridge", async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    const buttons = [[{ text: "Click", callback_data: "x" }]];
    await endTurn!.execute({ text: "Pick", buttons }, bridge);
    expect(bridge).toHaveBeenCalledWith("send_message_with_buttons", {
      text: "Pick",
      rows: buttons,
      reply_to_message_id: undefined,
    });
  });

  it("ends silently with no bridge call when text is omitted", async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    const result = await endTurn!.execute({}, bridge);
    expect(bridge).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, silent: true });
  });

  it("ends silently with no bridge call when text is whitespace-only", async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    const result = await endTurn!.execute({ text: "   \n\t  " }, bridge);
    expect(bridge).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, silent: true });
  });

  // Delivery-failure throw: when the bridge returns {ok:false}, end_turn.execute
  // throws so the SDK fires PostToolUseFailure and the hook pair preserves the
  // loop. Returning {ok:false} silently would let the PostToolBatch hook
  // terminate the turn while the model never gets to react. Regression for
  // the 4096-char overflow incident (2026-05-13 13:11Z).
  it("throws when bridge returns {ok:false} on plain text", async () => {
    const bridge = vi.fn(async () => ({
      ok: false,
      error: "Message too long (4326 chars, max 4096)",
    }));
    await expect(
      endTurn!.execute({ text: "x".repeat(4326) }, bridge),
    ).rejects.toThrow(/end_turn delivery failed/);
    await expect(
      endTurn!.execute({ text: "x".repeat(4326) }, bridge),
    ).rejects.toThrow(/Message too long/);
  });

  it("throws when bridge returns {ok:false} on buttons path", async () => {
    const bridge = vi.fn(async () => ({ ok: false, error: "Bad Request" }));
    await expect(
      endTurn!.execute(
        {
          text: "Pick",
          buttons: [[{ text: "X", callback_data: "x" }]],
        },
        bridge,
      ),
    ).rejects.toThrow(/end_turn delivery failed/);
  });

  it("throws with generic message when bridge returns {ok:false} without error field", async () => {
    const bridge = vi.fn(async () => ({ ok: false }));
    await expect(
      endTurn!.execute({ text: "anything" }, bridge),
    ).rejects.toThrow(/delivery failed/);
  });

  it("does NOT throw when bridge returns {ok:true} — success path preserved", async () => {
    const bridge = vi.fn(async () => ({ ok: true, message_id: 42 }));
    const result = await endTurn!.execute({ text: "Got it" }, bridge);
    expect(result).toEqual({ ok: true, message_id: 42 });
  });
});

describe("react tool — delivery failure throws", () => {
  const react = messagingTools.find((t) => t.name === "react");

  it("throws when bridge returns {ok:false} on strict-terminator call", async () => {
    const bridge = vi.fn(async () => ({
      ok: false,
      error: "REACTION_INVALID",
    }));
    await expect(
      react!.execute({ message_id: 100, emoji: "👍" }, bridge),
    ).rejects.toThrow(/react delivery failed/);
    await expect(
      react!.execute({ message_id: 100, emoji: "👍" }, bridge),
    ).rejects.toThrow(/REACTION_INVALID/);
  });

  it("throws when bridge returns {ok:false} even with end_turn:false (soft)", async () => {
    // Soft-terminator react still gets the delivery-failure throw — the
    // model sees the failure as an error in the next turn either way, which
    // is more useful than a silent {ok:false} it has to remember to inspect.
    const bridge = vi.fn(async () => ({ ok: false, error: "Bad" }));
    await expect(
      react!.execute({ message_id: 100, emoji: "👍", end_turn: false }, bridge),
    ).rejects.toThrow(/react delivery failed/);
  });

  it("does NOT throw when bridge returns {ok:true} — success path preserved", async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    const result = await react!.execute(
      { message_id: 100, emoji: "❤" },
      bridge,
    );
    expect(result).toEqual({ ok: true });
  });

  it("strips end_turn before bridging (existing contract)", async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    await react!.execute(
      { message_id: 200, emoji: "🎯", end_turn: false },
      bridge,
    );
    expect(bridge).toHaveBeenCalledWith("react", {
      message_id: 200,
      emoji: "🎯",
    });
  });
});

// ── Production wire-shape contract ──────────────────────────────────────────
//
// These tests pin the integration between the SDK's actual emitted tool
// names (always MCP-prefixed when served via MCP) and the registry checks
// the handler runs against them. They are the tests that would have caught
// the bug fixed in this PR — strict-equality `isTurnTerminator("end_turn")`
// passed in unit tests but the production code path called
// `isTurnTerminator("mcp__telegram-tools__end_turn")` and silently failed.
//
// Auto-derived from ALL_TOOLS so adding a new endsTurn tool or a new MCP
// frontend stays covered without manually adding cases.

describe("turn-terminator integration with SDK production tool name shapes", () => {
  // Built-in MCP server names that the SDK is known to wire Talon's tools
  // through. Keep this list in sync with the actual MCP server registration
  // in src/core/tools/mcp-server.ts and frontend wiring.
  const KNOWN_MCP_SERVERS = ["telegram-tools", "teams-tools"];

  for (const tool of ALL_TOOLS.filter((t) => t.endsTurn)) {
    for (const server of KNOWN_MCP_SERVERS) {
      const sdkName = `mcp__${server}__${tool.name}`;

      it(`isTurnTerminator(${sdkName}) === true`, () => {
        // The SDK never emits bare names for MCP-served tools — it always
        // includes the `mcp__<server>__` prefix. Strict equality against the
        // registry's bare name was the production bug.
        expect(isTurnTerminator(sdkName)).toBe(true);
      });

      it(`processAssistantMessage + isTurnTerminator: ${sdkName} flips state.turnTerminated`, () => {
        // End-to-end check of the exact two-step the handler does:
        //   block.name -> tools[].name (via processAssistantMessage)
        //   tools[].name -> isTurnTerminator
        // If either step normalizes inconsistently, this breaks.
        const state = createStreamState();
        const msg = {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool_1",
                name: sdkName,
                input: { text: "Hello sur" },
              },
            ],
          },
        } as unknown as SDKAssistantMessage;

        const result = processAssistantMessage(msg, state);
        expect(result.tools).toHaveLength(1);
        expect(result.tools[0].name).toBe(sdkName);

        // This is the exact line in handler.ts (with soft-terminator input):
        //     if (isTurnTerminator(tool.name, tool.input)) state.turnTerminated = true;
        if (isTurnTerminator(result.tools[0].name, result.tools[0].input)) {
          state.turnTerminated = true;
        }
        expect(state.turnTerminated).toBe(true);
      });
    }
  }

  it("non-terminator tools stay non-terminator under MCP prefixing", () => {
    // Make sure prefix-stripping doesn't accidentally promote arbitrary
    // tools to terminators.
    const nonTerminators = ALL_TOOLS.filter((t) => !t.endsTurn);
    expect(nonTerminators.length).toBeGreaterThan(0);
    for (const tool of nonTerminators.slice(0, 5)) {
      for (const server of KNOWN_MCP_SERVERS) {
        expect(isTurnTerminator(`mcp__${server}__${tool.name}`)).toBe(false);
      }
    }
  });

  it("react with end_turn:false through processAssistantMessage keeps state alive", () => {
    // End-to-end check that the soft-terminator path threads input
    // through processAssistantMessage → isTurnTerminator → state.
    // The bug this guards against: if either step drops the `input`
    // payload, react-with-end_turn:false would silently terminate.
    const state = createStreamState();
    const msg = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "mcp__telegram-tools__react",
            input: {
              message_id: 12345,
              emoji: "🤔",
              end_turn: false,
            },
          },
        ],
      },
    } as unknown as SDKAssistantMessage;

    const result = processAssistantMessage(msg, state);
    expect(result.tools).toHaveLength(1);

    if (isTurnTerminator(result.tools[0].name, result.tools[0].input)) {
      state.turnTerminated = true;
    }
    // Soft-opt-out wins: state stays open for follow-up tool calls.
    expect(state.turnTerminated).toBe(false);
  });
});

describe("delivery-tool classification (isDeliveryTool)", () => {
  it("the registry flags exactly the reply-delivery family", () => {
    const flagged = ALL_TOOLS.filter((t) => t.delivery).map((t) => t.name);
    expect(flagged.sort()).toEqual([
      "end_turn",
      "react",
      "send",
      "send_message",
      "send_message_with_buttons",
    ]);
  });

  it("matches bare names", () => {
    expect(isDeliveryTool("end_turn")).toBe(true);
    expect(isDeliveryTool("send_message")).toBe(true);
    expect(isDeliveryTool("react")).toBe(true);
  });

  it("matches every prefixed shape backends emit", () => {
    // Claude SDK / MCP canonical.
    expect(isDeliveryTool("mcp__desktop-tools__end_turn")).toBe(true);
    expect(isDeliveryTool("mcp__telegram-tools__send")).toBe(true);
    // Kilo / OpenCode `<server>_<bare>` form.
    expect(isDeliveryTool("desktop-tools_end_turn")).toBe(true);
    expect(isDeliveryTool("talon-tools-424242420_send_message")).toBe(true);
  });

  it("leaves visible work alone — bridge tools, backend-native tools", () => {
    // Bridge tools whose activity IS worth showing in a timeline.
    expect(isDeliveryTool("edit_message")).toBe(false);
    expect(isDeliveryTool("fetch_url")).toBe(false);
    expect(isDeliveryTool("mcp__desktop-tools__edit_message")).toBe(false);
    // Backend-native tools (Claude Code's own).
    expect(isDeliveryTool("Bash")).toBe(false);
    expect(isDeliveryTool("Read")).toBe(false);
    // Names that merely resemble a delivery tool.
    expect(isDeliveryTool("resend")).toBe(false);
    expect(isDeliveryTool("end_turn_report")).toBe(false);
  });
});
