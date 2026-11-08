/**
 * MemPalace plugin — structured long-term memory with vector search.
 *
 * Registers the mempalace Python MCP server, giving the agent access to
 * semantic memory search, knowledge graph operations, and diary entries.
 *
 * Configuration in ~/.talon/config.json:
 *   "mempalace": {
 *     "enabled": true,
 *     "palacePath": "/path/to/palace",         // optional, defaults to ~/.talon/workspace/palace/
 *     "pythonPath": "/path/to/python",         // optional, defaults to mempalace venv python (bin/python on Unix, Scripts/python.exe on Windows)
 *     "entityLanguages": ["en", "ja"],         // optional, BCP 47 codes (mempalace >= 3.3)
 *     "verbose": false,                         // optional, enables MEMPAL_VERBOSE diagnostics
 *     "version": "3.8.0",                       // optional, overrides the built-in pin (managed venv only)
 *     "autoUpdate": true,                       // optional, reconcile managed venv to the pin
 *     "autoProvision": true                     // optional, create/heal the managed venv
 *   }
 *
 * The default venv is provisioned automatically at boot (see
 * ./provision.ts); a custom pythonPath is operator-managed and never
 * mutated.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { TalonPlugin } from "../../core/plugin/types.js";
import { log, logWarn } from "../../util/log.js";
import { dirs } from "../../util/paths.js";

const execFile = promisify(execFileCb);

/** Load from ~/.talon/prompts/ (user-customisable, seeded on first run) */
const PROMPT_PATH = resolve(dirs.prompts, "mempalace.md");

/**
 * Create a mempalace plugin instance with resolved paths.
 * Uses a factory because MCP server command/args depend on runtime config.
 */
export function createMempalacePlugin(config: {
  pythonPath: string;
  palacePath: string;
  /** BCP 47 codes passed via MEMPALACE_ENTITY_LANGUAGES (mempalace >= 3.3). */
  entityLanguages?: readonly string[];
  /** When true, sets MEMPAL_VERBOSE=1 so the MCP server logs diagnostic diaries. */
  verbose?: boolean;
  /** Version the provisioner found/installed — logging only. */
  installedVersion?: string;
}): TalonPlugin {
  const { pythonPath, palacePath, entityLanguages, verbose, installedVersion } =
    config;

  const envVars: Record<string, string> = {
    MEMPALACE_PALACE_PATH: palacePath,
  };
  if (entityLanguages && entityLanguages.length > 0) {
    envVars.MEMPALACE_ENTITY_LANGUAGES = entityLanguages.join(",");
  }
  if (verbose) {
    envVars.MEMPAL_VERBOSE = "1";
  }

  return {
    name: "mempalace",
    description:
      "Memory palace — structured long-term memory with vector search",
    version: "1.1.0",

    mcpServer: {
      command: pythonPath,
      args: ["-m", "mempalace.mcp_server", "--palace", palacePath],
    },

    validateConfig() {
      const errors: string[] = [];
      if (!existsSync(pythonPath)) {
        errors.push(
          `Python binary not found at ${pythonPath}. Create or select a Python environment, set "pythonPath" to that interpreter, then run: ${pythonPath} -m pip install mempalace`,
        );
        return errors;
      }

      // Verify mempalace.mcp_server is importable (the actual module spawned by MCP)
      try {
        execFileSync(pythonPath, ["-c", "import mempalace.mcp_server"], {
          timeout: 15_000,
          stdio: "pipe",
        });
      } catch (err: unknown) {
        const execErr =
          err && typeof err === "object"
            ? (err as {
                code?: string;
                signal?: string;
                killed?: boolean;
                stderr?: string | Buffer;
              })
            : undefined;
        const code = execErr?.code;
        if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
          errors.push(
            `Cannot execute Python at ${pythonPath} (${code}). Check that the path is correct and the binary is executable.`,
          );
        } else if (code === "ETIMEDOUT" || execErr?.killed || execErr?.signal) {
          errors.push(
            `Python import check timed out or was killed. The interpreter at ${pythonPath} may be unresponsive.`,
          );
        } else {
          const stderr =
            typeof execErr?.stderr === "string"
              ? execErr.stderr.trim()
              : Buffer.isBuffer(execErr?.stderr)
                ? execErr.stderr.toString("utf-8").trim()
                : "";
          errors.push(
            `mempalace package not installed or mcp_server submodule missing. Run: ${pythonPath} -m pip install mempalace${stderr ? `. Details: ${stderr}` : ""}`,
          );
        }
      }

      return errors.length > 0 ? errors : undefined;
    },

    async init() {
      if (!existsSync(palacePath)) {
        mkdirSync(palacePath, { recursive: true });
        log("mempalace", `Created palace directory: ${palacePath}`);
      }

      // Quick smoke test — verify mempalace can import and access the palace path
      try {
        const { stdout } = await execFile(
          pythonPath,
          [
            "-c",
            `import mempalace; print(f"mempalace {mempalace.__version__}" if hasattr(mempalace, "__version__") else "mempalace ok")`,
          ],
          { timeout: 15_000 },
        );
        log("mempalace", stdout.trim() || "Module verified");
      } catch (err) {
        // Non-fatal — MCP server handles lazy init
        log(
          "mempalace",
          `Module import check skipped — MCP server will initialize on first use (${firstLine(err)})`,
        );
      }

      const langSuffix =
        entityLanguages && entityLanguages.length > 0
          ? ` (languages: ${entityLanguages.join(",")})`
          : "";
      const versionSuffix = installedVersion ? ` v${installedVersion}` : "";
      log(
        "mempalace",
        `Ready${versionSuffix} (palace: ${palacePath})${langSuffix}`,
      );
    },

    getEnvVars() {
      return { ...envVars };
    },

    getSystemPromptAddition() {
      const languagesLine =
        entityLanguages && entityLanguages.length > 0
          ? entityLanguages.join(", ")
          : "en (default)";
      try {
        const template = readFileSync(PROMPT_PATH, "utf-8");
        return template
          .replace(/\{\{palacePath\}\}/g, palacePath)
          .replace(/\{\{entityLanguages\}\}/g, languagesLine);
      } catch (err) {
        logWarn(
          "mempalace",
          `Failed to load prompt from ${PROMPT_PATH}: ${err instanceof Error ? err.message : err}`,
        );
        return `## MemPalace — Long-term Memory\n\nPalace location: \`${palacePath}\`\nEntity languages: ${languagesLine}`;
      }
    },
  };
}

/** First line of an error's message; execFile errors append all of stderr. */
function firstLine(err: unknown): string {
  return (
    (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? ""
  );
}
