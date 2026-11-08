/**
 * Backend conformance: every backend either enforces the guest tool scope
 * or refuses guest-scoped turns.
 *
 * The guest scope is enforced in the MCP hub, but a backend's own
 * built-ins (Claude Code's Bash/Read/Write, Codex's shell, the OpenAI
 * Agents file tools, OpenCode/Kilo's server tools) live outside it. A
 * backend that can't drop them for a guest turn must not get the turn.
 *
 * What would reveal a regression: a backend registered without an explicit
 * `guestToolScope`, a backend declaring "enforced" that still hands a guest
 * turn its built-ins, or the weaver running a guest turn on a backend that
 * declared "refused".
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { BACKEND_IDS } from "../core/agent-runtime/model-ref.js";
import {
  backendEnforcesGuestScope,
  clearBackends,
  getBackend,
  registerBackend,
} from "../core/agent-runtime/backend-registry.js";
import { createRemoteBackendFactory } from "../backend/remote-server/factory.js";
import {
  kiloProfile,
  opencodeProfile,
} from "../backend/remote-server/profiles/index.js";
import { initGuestDmScope, isGuestTurn } from "../core/mcp-hub/guest-scope.js";
import { Weaver } from "../core/weaver/index.js";
import type { ExecuteParams } from "../core/types.js";
import type { BackendId } from "../core/agent-runtime/model-ref.js";
import { stubBackend, stubResolveActiveModel } from "./helpers/stub-backend.js";

/** Backends whose guest enforcement is verified in claude-sdk-options.test.ts. */
const VERIFIED_ENFORCING = new Set(["claude"]);

beforeAll(async () => {
  clearBackends();
  await import("../backend/claude-sdk/factory.js");
  registerBackend(createRemoteBackendFactory(kiloProfile));
  registerBackend(createRemoteBackendFactory(opencodeProfile));
  await import("../backend/codex/factory.js");
  await import("../backend/agy/factory.js");
  await import("../backend/openai-agents/factory.js");
}, 30_000);

describe("every backend declares its guest tool scope", () => {
  for (const id of BACKEND_IDS) {
    it(`${id} declares "enforced" or "refused" explicitly`, () => {
      const factory = getBackend(id);
      expect(factory, `backend ${id} registered`).toBeDefined();
      expect(["enforced", "refused"]).toContain(factory?.guestToolScope);
    });

    it(`${id} only claims enforcement when it is verified`, () => {
      expect(backendEnforcesGuestScope(id)).toBe(VERIFIED_ENFORCING.has(id));
    });
  }

  it("fails closed for an undeclared or unknown backend", () => {
    expect(backendEnforcesGuestScope("no-such-backend")).toBe(false);
  });
});

// ── The weaver honours the declaration ──────────────────────────────────────

const ADMIN = 424242420;
const GROUP = "-1009876543210";

function groupTurn(senderId: number, onEvent = vi.fn()): ExecuteParams {
  return {
    chatId: GROUP,
    numericChatId: -1009876543210,
    prompt: "hi",
    senderName: "S",
    senderKeys: [String(senderId)],
    isGroup: true,
    source: "message",
    onEvent,
  };
}

function weaverOn(id: BackendId, sawGuest: boolean[]) {
  const backend = stubBackend({
    id,
    query: vi.fn(async (q) => {
      sawGuest.push(isGuestTurn(q.chatId));
      return {
        text: "ok",
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
    }),
  });
  return new Weaver({
    getBackend: () => backend,
    resolveActiveModel: stubResolveActiveModel(id),
    context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
    sendTyping: vi.fn(async () => {}),
  });
}

describe("weaver: guest turns only reach enforcing backends", () => {
  beforeEach(() => {
    initGuestDmScope(undefined, ADMIN);
  });

  for (const id of BACKEND_IDS.filter((b) => !VERIFIED_ENFORCING.has(b))) {
    it(`refuses a non-operator's turn on ${id}, with a message`, async () => {
      const seen: boolean[] = [];
      const onEvent = vi.fn();
      await weaverOn(id, seen).runTurn(groupTurn(777, onEvent));
      expect(seen).toEqual([]);
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "assistant_message",
          text: expect.stringMatching(/can't enforce/),
        }),
      );
    });

    it(`still runs the operator's turn on ${id}`, async () => {
      const seen: boolean[] = [];
      await weaverOn(id, seen).runTurn(groupTurn(ADMIN));
      expect(seen).toEqual([false]);
    });
  }

  it("runs a non-operator's turn guest-scoped on claude, and clears it after", async () => {
    const seen: boolean[] = [];
    await weaverOn("claude", seen).runTurn(groupTurn(777));
    expect(seen).toEqual([true]);
    expect(isGuestTurn(GROUP)).toBe(false);
  });

  it("runs the operator's turn on claude with the full scope", async () => {
    const seen: boolean[] = [];
    await weaverOn("claude", seen).runTurn(groupTurn(ADMIN));
    expect(seen).toEqual([false]);
  });
});
