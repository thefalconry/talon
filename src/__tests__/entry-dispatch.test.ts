/**
 * The entry shims (src/index.ts, src/cli.ts) dispatch Talon's hidden
 * self-invocation subcommands by string literal and load each helper's
 * module dynamically, so a helper process (MCP reaper, per-child
 * supervisor, Lua runner, handoff witness) never evaluates another
 * helper's module graph. This pins the literals to the constants the
 * re-invoking side actually passes.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_LAUNCH_SUBCOMMAND } from "../core/mcp-hub/launcher.js";
import { MCP_REAPER_SUBCOMMAND } from "../core/mcp-hub/reaper.js";
import { LUA_RUN_SUBCOMMAND } from "../core/scripts/lua.js";
import { HANDOFF_WATCH_SUBCOMMAND } from "../core/daemon/handoff.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => readFileSync(resolve(SRC, f), "utf-8");

describe("entry shim subcommand dispatch", () => {
  it("src/index.ts dispatches every helper subcommand", () => {
    const text = read("index.ts");
    for (const sub of [
      MCP_LAUNCH_SUBCOMMAND,
      MCP_REAPER_SUBCOMMAND,
      LUA_RUN_SUBCOMMAND,
      HANDOFF_WATCH_SUBCOMMAND,
    ]) {
      expect(text).toContain(`subcommand === "${sub}"`);
    }
  });

  it("src/cli.ts dispatches the MCP and Lua helper subcommands", () => {
    const text = read("cli.ts");
    for (const sub of [
      MCP_LAUNCH_SUBCOMMAND,
      MCP_REAPER_SUBCOMMAND,
      LUA_RUN_SUBCOMMAND,
    ]) {
      expect(text).toContain(`subcommand === "${sub}"`);
    }
  });

  it("the shims import no helper module statically", () => {
    for (const f of ["index.ts", "cli.ts"]) {
      const staticImports = read(f)
        .split("\n")
        .filter((l) => /^import\s/.test(l));
      expect(
        staticImports.filter((l) =>
          /mcp-hub|scripts\/lua|daemon\/handoff/.test(l),
        ),
      ).toEqual([]);
    }
  });
});
