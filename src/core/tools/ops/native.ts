import { z } from "zod";
import type { ToolDefinition } from "../types.js";

/**
 * Native tools — Talon's own shell/filesystem primitives, the replacement
 * for the SDK's built-in Bash/Read/Write/Edit/Glob/Grep. They are only
 * surfaced when `config.nativeTools` is enabled (see the tool composition in
 * the MCP server); otherwise the built-ins are used.
 *
 * Their extra power over the built-ins: every one honours the active
 * `teleport` target, so with a teleport engaged they run ON a companion
 * device (via the mesh exec/fs channel) instead of on the daemon host.
 * Talon's namespace (~/.talon/ns) is a real filesystem location — its
 * files are reached by their ordinary real paths, with no address scheme
 * to translate, so the same path works here, in a bare shell, and in any
 * spawned process.
 */

/** One shared description of the namespace, stated once. */
const NAMESPACE_DOC =
  "Talon's namespace lives on disk at ~/.talon/ns — home/ (the workspace), skills/, " +
  "scripts/, logs/, and, while the FUSE layer is mounted, the live views proc/ (task " +
  "table at proc/tasks/<id>, event ring at proc/events, both JSON) and plugins/ " +
  "(registry). These are real paths: address them directly as ~/.talon/ns/<mount>/….";
export const nativeTools: ToolDefinition[] = [
  {
    name: "teleport",
    description:
      "Switch Talon's native shell/file tools to run ON a companion mesh device (e.g. your phone). After teleporting, bash/read/write/edit/glob/search execute on that device until teleport_back. The device must be online and advertise the 'exec' capability.",
    schema: {
      device: z
        .string()
        .optional()
        .describe(
          "Device id, exact name, or unique name fragment (case/separator-insensitive; see list_devices). Ambiguous fragments error unless exactly one match is online — prefer the id when duplicates exist. Defaults to the most recent mobile device.",
        ),
    },
    execute: (params, bridge) => bridge("teleport", params),
    tag: "native",
  },
  {
    name: "teleport_back",
    description:
      "Return native tools to the daemon host — bash/read/write/edit/glob/search run locally again.",
    schema: {},
    execute: (_params, bridge) => bridge("teleport_back", {}),
    tag: "native",
  },
  {
    name: "bash",
    description:
      "Run a shell command. Runs on the daemon host, or ON the active teleport device if one is engaged. On a teleported device, `cd` persists across calls (a real working-directory session). " +
      'A foreground run still going at timeout_sec keeps running as a watched job, and the chat gets a wake-up when it ends (on_timeout:"kill" kills it instead; Windows hosts and devices without exec_job always kill). Locally its output moves to a log file; on a teleported device use device_exec_job to read or kill it. For streaming/never-ending commands (adb logcat, tail -f, dev servers, watchers) set background:true instead: the command is launched detached in its own process group with stdout+stderr captured to a log file, and the tool returns immediately with the pid + log path so you can poll the log and kill it when done. ' +
      `${NAMESPACE_DOC} Reach them by real path, e.g. \`ls ~/.talon/ns/home\` or \`cat ~/.talon/ns/proc/events | jq\` (proc/ and plugins/ need the FUSE layer mounted).`,
    schema: {
      command: z.string().describe("The shell command to run."),
      cwd: z
        .string()
        .optional()
        .describe(
          "Working directory (local runs only; teleport tracks its own cwd). A real path, e.g. ~/.talon/ns/home.",
        ),
      timeout_sec: z
        .number()
        .optional()
        .describe(
          "Seconds a foreground command may hold this call (default 60, max 300). Ignored with background:true.",
        ),
      on_timeout: z
        .enum(["detach", "kill"])
        .optional()
        .describe(
          "What happens to a foreground command at timeout_sec. detach (default) keeps it running as a watched job; kill ends it and returns the partial output.",
        ),
      background: z
        .boolean()
        .optional()
        .describe(
          "Launch detached and return immediately with pid + log file path (local runs only). Use for streaming or long-running commands that would otherwise time out.",
        ),
    },
    execute: (params, bridge) => bridge("native_bash", params),
    tag: "native",
  },
  {
    name: "read",
    description: `Read a file (with line numbers). Runs on the daemon host or the active teleport device. Supports offset/limit for large files. ${NAMESPACE_DOC}`,
    schema: {
      path: z
        .string()
        .describe(
          "Absolute file path or ~ path (namespace files live under ~/.talon/ns, e.g. ~/.talon/ns/home/notes.md).",
        ),
      offset: z.number().optional().describe("0-based line to start from."),
      limit: z
        .number()
        .optional()
        .describe("Max lines to return (default/max 2000)."),
    },
    execute: (params, bridge) => bridge("native_read", params),
    tag: "native",
  },
  {
    name: "write",
    description:
      "Write (create/overwrite) a file with the given content. Runs on the daemon host or the active teleport device. Under ~/.talon/ns the writable mounts are home/, skills/, scripts/ (logs/, proc/, plugins/ are read-only).",
    schema: {
      path: z
        .string()
        .describe(
          "Absolute file path or ~ path (namespace files live under ~/.talon/ns, e.g. ~/.talon/ns/home/notes.md).",
        ),
      content: z.string().describe("Full file content to write."),
    },
    execute: (params, bridge) => bridge("native_write", params),
    tag: "native",
  },
  {
    name: "edit",
    description:
      "Exact-string replacement in a file. old_string must be unique unless replace_all is set. Runs on the daemon host or the active teleport device.",
    schema: {
      path: z
        .string()
        .describe(
          "Absolute file path or ~ path (namespace files live under ~/.talon/ns, e.g. ~/.talon/ns/home/notes.md).",
        ),
      old_string: z.string().describe("Exact text to replace."),
      new_string: z.string().describe("Replacement text."),
      replace_all: z
        .boolean()
        .optional()
        .describe("Replace every occurrence (default false)."),
    },
    execute: (params, bridge) => bridge("native_edit", params),
    tag: "native",
  },
  {
    name: "glob",
    description:
      "Find files matching a glob pattern (ripgrep-backed). Runs on the daemon host or the active teleport device.",
    schema: {
      pattern: z.string().describe('Glob pattern, e.g. "**/*.ts".'),
      path: z
        .string()
        .optional()
        .describe(
          "Root directory to search (default cwd; a real path e.g. ~/.talon/ns/home).",
        ),
    },
    execute: (params, bridge) => bridge("native_glob", params),
    tag: "native",
  },
  {
    name: "search",
    description:
      "Search file contents with a regex (ripgrep-backed). Runs on the daemon host or the active teleport device.",
    schema: {
      pattern: z.string().describe("Regex pattern to search for."),
      path: z
        .string()
        .optional()
        .describe(
          "Root directory or file (default cwd; a real path e.g. ~/.talon/ns/home).",
        ),
      glob: z
        .string()
        .optional()
        .describe('Filter files by glob, e.g. "*.ts".'),
      case_insensitive: z
        .boolean()
        .optional()
        .describe("Case-insensitive match (default false)."),
    },
    execute: (params, bridge) => bridge("native_search", params),
    tag: "native",
  },
];
