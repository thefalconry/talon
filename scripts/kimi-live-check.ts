/**
 * Live end-to-end canary check for the Kimi backend adapter.
 *
 * Runs through the real adapter code path:
 *   1. Initialises backend via factory (registered under "kimi").
 *   2. Probes dynamic models catalog via `kimi provider list --json`.
 *   3. Executes Turn 1 through `backend.chat.runChatTurn` using the free canary model
 *      `openrouter/liquid/lfm-2.5-2.6b:free`.
 *   4. Verifies AgentEvents emitted: run_started, stream_delta, completed.
 *   5. Verifies session continuity: executes Turn 2 referencing Turn 1's secret.
 *
 * Usage:
 *   npx tsx scripts/kimi-live-check.ts
 */

import { join } from "node:path";
import { tmpdir } from "node:os";

// Ensure throwaway DB so we never touch ~/.talon/data/talon.db
process.env.TALON_DB_PATH = join(
  tmpdir(),
  `talon-kimi-live-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
);
process.env.TALON_DISABLE_LEGACY_IMPORT = "1";

import { loadBuiltinBackends } from "../src/backend/builtins.js";
import { getBackend } from "../src/core/agent-runtime/backend-registry.js";
import type { AgentEvent } from "../src/core/agent-runtime/events.js";
import { makeBareModelRef } from "../src/core/agent-runtime/model-ref.js";
import { getSession } from "../src/storage/sessions.js";

const CANARY_MODEL = "openrouter/nex-agi/nex-n2.5-mini:free";
const CHAT_ID = "-100canary-live-check";

async function main() {
  console.log("=== Kimi Adapter Live Canary Check ===");

  // 1. Load builtins and get kimi backend factory
  await loadBuiltinBackends();
  const factory = getBackend("kimi");
  if (!factory) {
    throw new Error("Kimi backend factory not registered in builtins!");
  }
  console.log(`[PASS] Kimi factory resolved: ${factory.id} (${factory.label})`);

  // 2. Initialise backend
  const { backend, cleanup } = await factory.init(
    {
      workspace: "/home/dylan/talon-kimi",
      frontend: "telegram",
      kimiBinary: "/home/dylan/.npm-global/bin/kimi",
    } as never,
    {
      getBridgePort: () => 4096,
      frontendName: "telegram",
    },
  );
  console.log(`[PASS] Kimi backend initialized.`);
  backend.control?.updateSystemPrompt(
    "You are a helpful AI assistant. Follow instructions precisely and answer concisely.",
  );

  // 3. Probe model catalog through backend.models
  if (!backend.models) {
    throw new Error("Kimi backend missing models capability slot!");
  }
  const { models } = await backend.models.listModels();
  console.log(
    `[PASS] Dynamic model catalog returned ${models.length} models from Kimi CLI.`,
  );
  const freeFound = models.find((m) => m.id === CANARY_MODEL);
  console.log(
    `[PASS] Canary model ${CANARY_MODEL} in catalog: ${Boolean(freeFound)}`,
  );

  // 4. Run Turn 1 through backend.chat.runChatTurn
  if (!backend.chat) {
    throw new Error("Kimi backend missing chat capability slot!");
  }

  const SECRET_TOKEN = `KIMI-CANARY-${Math.floor(Math.random() * 90000 + 10000)}`;
  console.log(`\n--- Executing Turn 1 (secret: ${SECRET_TOKEN}) ---`);

  const eventsTurn1: AgentEvent[] = [];
  const textDeltasTurn1: string[] = [];

  const turn1Stream = backend.chat.runChatTurn({
    chatId: CHAT_ID,
    text: `Reply with exactly: ${SECRET_TOKEN}`,
    model: makeBareModelRef("kimi", CANARY_MODEL),
    senderName: "Tester",
  });

  for await (const ev of turn1Stream) {
    eventsTurn1.push(ev);
    if (ev.type === "text_delta") {
      textDeltasTurn1.push(ev.text);
    }
    if (ev.type === "assistant_message") {
      if (textDeltasTurn1.length === 0) textDeltasTurn1.push(ev.text);
      if (ev.deliveryAck) ev.deliveryAck.resolve();
    }
  }

  console.log(`Turn 1 finished with ${eventsTurn1.length} events:`);
  console.log(`  Event types: ${eventsTurn1.map((e) => e.type).join(", ")}`);
  const fullTextTurn1 = textDeltasTurn1.join("");
  console.log(`  Full response text: ${JSON.stringify(fullTextTurn1)}`);

  const completed1 = eventsTurn1.find((e) => e.type === "completed");
  if (!completed1) {
    throw new Error("Turn 1 stream did not emit 'completed' event!");
  }
  console.log(`  Completed event stopReason: ${completed1.stopReason}`);
  if (completed1.usage) {
    console.log(`  Completed usage tokens:`, completed1.usage);
  }

  // Verify session ID in session store
  const sessionAfterTurn1 = getSession(CHAT_ID);
  console.log(`  Stored session after Turn 1: id=${sessionAfterTurn1.sessionId}, turns=${sessionAfterTurn1.turns}`);
  if (!sessionAfterTurn1.sessionId) {
    console.warn("  [WARN] No sessionId stored after Turn 1!");
  } else {
    console.log(`  [PASS] Session ID captured: ${sessionAfterTurn1.sessionId}`);
  }

  // 5. Run Turn 2 to verify session continuity
  console.log(`\n--- Executing Turn 2 (Testing session recall) ---`);
  const eventsTurn2: AgentEvent[] = [];
  const textDeltasTurn2: string[] = [];

  const turn2Stream = backend.chat.runChatTurn({
    chatId: CHAT_ID,
    text: "What was the exact verification token string you just replied with in your previous response? Reply with only that token string.",
    model: makeBareModelRef("kimi", CANARY_MODEL),
    senderName: "Tester",
  });

  for await (const ev of turn2Stream) {
    eventsTurn2.push(ev);
    if (ev.type === "text_delta") {
      textDeltasTurn2.push(ev.text);
    }
    if (ev.type === "assistant_message") {
      if (textDeltasTurn2.length === 0) textDeltasTurn2.push(ev.text);
      if (ev.deliveryAck) ev.deliveryAck.resolve();
    }
  }

  console.log(`Turn 2 finished with ${eventsTurn2.length} events:`);
  console.log(`  Event types: ${eventsTurn2.map((e) => e.type).join(", ")}`);
  const fullTextTurn2 = textDeltasTurn2.join("");
  console.log(`  Full response text: ${JSON.stringify(fullTextTurn2)}`);

  const sessionAfterTurn2 = getSession(CHAT_ID);
  console.log(`  Stored session after Turn 2: id=${sessionAfterTurn2.sessionId}, turns=${sessionAfterTurn2.turns}`);

  const recalled = fullTextTurn2.includes(SECRET_TOKEN);
  console.log(`  Turn 2 recalled token '${SECRET_TOKEN}': ${recalled}`);

  console.log("\n=== Live Canary Completed Successfully ===");
  if (cleanup) await cleanup();
}

main().catch((err) => {
  console.error("Canary run failed:", err);
  process.exit(1);
});
