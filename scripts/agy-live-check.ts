/**
 * Live end-to-end check for the agy backend — run by hand, never in CI.
 *
 * Needs three things CI cannot have: the real `agy` binary, a completed
 * interactive Google sign-in on this host, and a running Talon daemon
 * serving its MCP hub (read the port from ~/.talon/talon.pid). Run it
 * with:
 *
 *   npx tsx scripts/agy-live-check.ts
 *
 * Phase 1 (dry): build + write the MCP entries against a TEMP COPY of
 *   the real config, prove the write preserves foreign entries.
 * Phase 2 (live): point TALON_AGY_MCP_CONFIG at the REAL file, register
 *   the extras-tools hub URL for one chat, spawn the real process layer,
 *   run one turn asking for check_time, and assert we observe an
 *   UNWRAPPED `check_time` tool start/end plus a text reply.
 * Phase 3 (cleanup): remove our entries + snapshot dirs and verify.
 *
 * It touches the REAL ~/.gemini/config/mcp_config.json for one turn and
 * puts it back exactly as it found it — phase 3 asserts that.
 */
import { copyFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REAL = join(homedir(), ".gemini", "config", "mcp_config.json");
const TMP = "/tmp/agy-live/mcp_config.copy.json";
const SNAPDIR = join(homedir(), ".gemini", "antigravity-cli", "mcp");
const CHAT = "-1009876543210";
const BRIDGE = `http://127.0.0.1:${
  (
    JSON.parse(
      readFileSync(join(homedir(), ".talon", "talon.pid"), "utf-8"),
    ) as { port: number }
  ).port
}`;

// The gateway (and its MCP hub) require the daemon's bearer token.
const HEADERS = {
  Authorization: `Bearer ${readFileSync(
    join(homedir(), ".talon", "keys", "gateway-token"),
    "utf-8",
  ).trim()}`,
};

const keysOf = (p: string) =>
  Object.keys(
    (JSON.parse(readFileSync(p, "utf-8")) as { mcpServers: object }).mcpServers,
  );
const talonKeys = (p: string) =>
  keysOf(p).filter((k) => k.startsWith("__talon__"));

async function main() {
  const mcp = await import("../src/backend/agy/mcp/config.js");
  const proc = await import("../src/backend/agy/process/child.js");
  const events = await import("../src/backend/agy/events.js");

  // ── Phase 1: dry run against a copy ─────────────────────────────────────
  copyFileSync(REAL, TMP);
  const beforeCopy = keysOf(TMP);
  const servers = mcp.buildAgyMcpServers({
    chatId: CHAT,
    bridgeUrl: BRIDGE,
    frontends: [],
    scope: "live",
  });
  // Frontends list is empty here; add the one hub server the brief names.
  servers["__talon__live__extras-tools"] = {
    disabled: false,
    headers: HEADERS,
    serverUrl: `${BRIDGE}/mcp/plugin/extras-tools/${CHAT}`,
  };
  const dry = mcp.writeAgyMcpServers("live", servers, {
    configPath: TMP,
    snapshotDir: "/tmp/agy-live/snapshots",
  });
  const afterCopy = keysOf(TMP);
  console.log("PHASE1 dry-run added:", dry.added);
  console.log(
    "PHASE1 foreign entries preserved:",
    beforeCopy.every((k) => afterCopy.includes(k)),
    `(${beforeCopy.length} before, ${afterCopy.length} after)`,
  );

  // ── Phase 2: live against the real config ───────────────────────────────
  const realTalonBefore = talonKeys(REAL);
  console.log("PHASE2 __talon__ keys in real config BEFORE:", realTalonBefore);
  process.env.TALON_AGY_MCP_CONFIG = REAL;
  const live = mcp.writeAgyMcpServers("live", {
    "__talon__live__extras-tools": {
      disabled: false,
      headers: HEADERS,
      serverUrl: `${BRIDGE}/mcp/plugin/extras-tools/${CHAT}`,
    },
  });
  console.log("PHASE2 registered:", live.added);

  const child = proc.ensureChild("live-check", {
    binary: "/home/ada/.local/bin/agy",
    cwd: "/tmp/agy-live",
    model: "gemini-3.8-flash-high",
    addDirs: ["/tmp/agy-live"],
    idleMs: 0,
  });

  const starts: string[] = [];
  const ends: Array<[string, boolean]> = [];
  let text = "";
  const state = { allResponseText: "", currentBlockText: "" };
  const result = await child.runTurn(
    "Call the check_time tool on the MCP server named " +
      "__talon__live__extras-tools with timezone Europe/London, then reply " +
      "with ONLY the time it returns (HH:MM:SS). Do not use run_command.",
    {
      onStep: (step) => {
        if (step.step_type === "tool") {
          const shape = events.describeAgyTool(step);
          if (step.state === "ACTIVE") starts.push(shape.name);
          if (step.state === "DONE" || step.state === "ERROR") {
            ends.push([shape.name, step.state === "ERROR"]);
            console.log(
              `  tool ${step.state}: name=${shape.name} server=${shape.server ?? "-"} ` +
                `raw_tool_name=${step.tool_name}`,
            );
          }
        }
        if (step.step_type === "agent_response" && step.text_delta) {
          state.currentBlockText += step.text_delta;
        }
      },
    },
  );
  text = state.currentBlockText;
  console.log("PHASE2 status:", result.status);
  console.log("PHASE2 conversation_id:", result.conversation_id);
  console.log("PHASE2 tool starts (unwrapped):", starts);
  console.log("PHASE2 tool ends (unwrapped, failed?):", ends);
  console.log("PHASE2 accumulated reply text:", JSON.stringify(text));
  console.log("PHASE2 result.response:", JSON.stringify(result.response));
  console.log("PHASE2 usage:", JSON.stringify(result.usage));
  console.log(
    "PHASE2 ASSERT unwrapped check_time observed:",
    starts.includes("check_time") && ends.some(([n]) => n === "check_time"),
  );
  console.log(
    "PHASE2 ASSERT call_mcp_tool never surfaced:",
    !starts.includes("call_mcp_tool") &&
      !ends.some(([n]) => n === "call_mcp_tool"),
  );
  console.log("PHASE2 ASSERT text reply non-empty:", text.trim().length > 0);

  proc.killAllChildren("live-check-done");

  // ── Phase 3: cleanup ────────────────────────────────────────────────────
  const removed = mcp.removeAgyMcpServers("live");
  console.log("PHASE3 removed:", removed);
  const realTalonAfter = talonKeys(REAL);
  console.log("PHASE3 __talon__ keys in real config AFTER:", realTalonAfter);
  console.log(
    "PHASE3 ASSERT no key we added remains:",
    !realTalonAfter.includes("__talon__live__extras-tools"),
  );
  const leftover = existsSync(SNAPDIR)
    ? readdirSync(SNAPDIR).filter((d) => d.startsWith("__talon__live"))
    : [];
  console.log("PHASE3 leftover __talon__live* snapshot dirs:", leftover);
  console.log(
    "PHASE3 ASSERT full key set unchanged vs before:",
    JSON.stringify(realTalonAfter.sort()) ===
      JSON.stringify(realTalonBefore.sort()),
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("LIVE CHECK FAILED:", err);
    process.exit(1);
  },
);
