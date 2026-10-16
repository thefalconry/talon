/**
 * Built-in filesystem + shell tools for the OpenAI Agents backend.
 *
 * The Claude SDK backend ships these as part of Claude Code (`Read`,
 * `Write`, `Edit`, `Bash`, `Glob`, `Grep`). The `@openai/agents` SDK
 * doesn't — it's model-agnostic and assumes the host wires whatever
 * capabilities the agent needs. To keep Talon's system prompt and
 * behavior consistent across backends, this module mirrors that
 * Claude-Code surface as `tool()` definitions.
 *
 * Schema choice
 * ─────────────
 *
 * `@openai/agents`'s `tool()` factory accepts either a Zod schema or
 * a raw JSON Schema. Zod is convenient but `@openai/agents` forces
 * `strict: true` for Zod schemas, which in turn forces every
 * declared property into the `required` array. That's OpenAI-correct
 * but does NOT survive in the real world: many models (especially
 * non-OpenAI ones routed through chat_completions) drop optional
 * fields when calling, and the SDK then rejects every call as
 * "Invalid JSON input". That manifested as "Bash tool is completely
 * broken — JSON input errors on every call" in production with
 * OpenRouter models like Trinity / Owl.
 *
 * We use plain JSON Schemas with explicit `required` arrays so
 * truly-optional fields (offset/limit, timeout, provider, …) can be
 * omitted by the model and the call still validates. `strict: false`
 * disables the all-required pass.
 *
 * Tool names + parameter shapes still match Claude Code so the
 * shared prompt vocabulary applies uniformly.
 */
import { tool } from "@openai/agents";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, mkdir, glob } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { createOutputCapture } from "../../util/exec-output.js";
import { expandFsPath as expandPath } from "../../util/fs-path.js";

// ── Read ────────────────────────────────────────────────────────────────────

interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

const readTool = tool({
  name: "Read",
  description:
    "Read a text file from disk. Returns the file contents with " +
    "`cat -n`-style line numbering. `offset` (1-indexed) skips the " +
    "first N-1 lines; `limit` caps the number of lines returned.",
  strict: false,
  parameters: {
    type: "object" as const,
    additionalProperties: true as const,
    required: ["file_path"],
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path (or ~/...) to the file to read.",
      },
      offset: {
        type: "integer",
        minimum: 1,
        description: "1-indexed line number to start reading from.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: "Maximum number of lines to read.",
      },
    },
  },
  async execute(input) {
    const { file_path, offset, limit } = input as ReadInput;
    const abs = expandPath(file_path);
    const text = await readFile(abs, "utf8");
    const allLines = text.split("\n");
    const start = (offset ?? 1) - 1;
    const end = limit != null ? start + limit : allLines.length;
    const slice = allLines.slice(start, end);
    return slice
      .map((line, i) => `${String(start + i + 1).padStart(6, " ")}\t${line}`)
      .join("\n");
  },
});

// ── Write ───────────────────────────────────────────────────────────────────

interface WriteInput {
  file_path: string;
  content: string;
}

const writeTool = tool({
  name: "Write",
  description:
    "Write a string to a file, creating it (and any missing parent " +
    "directories) if necessary. Overwrites existing content. Use " +
    "Edit for partial in-place changes.",
  strict: false,
  parameters: {
    type: "object" as const,
    additionalProperties: true as const,
    required: ["file_path", "content"],
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path (or ~/...) to the file to write.",
      },
      content: {
        type: "string",
        description: "Full file contents to write.",
      },
    },
  },
  async execute(input) {
    const { file_path, content } = input as WriteInput;
    const abs = expandPath(file_path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    return `wrote ${content.length} bytes to ${abs}`;
  },
});

// ── Edit ────────────────────────────────────────────────────────────────────

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

const editTool = tool({
  name: "Edit",
  description:
    "Replace text in a file. `old_string` must appear verbatim in " +
    "the file. By default `old_string` must be unique; set " +
    "`replace_all` to replace every occurrence. Use this for surgical " +
    "changes instead of rewriting the whole file with Write.",
  strict: false,
  parameters: {
    type: "object" as const,
    additionalProperties: true as const,
    required: ["file_path", "old_string", "new_string"],
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path (or ~/...) to the file to modify.",
      },
      old_string: { type: "string", description: "Exact text to replace." },
      new_string: {
        type: "string",
        description: "Replacement text. Must differ from old_string.",
      },
      replace_all: {
        type: "boolean",
        description:
          "When true, replace every occurrence of old_string. " +
          "When false or omitted, the match must be unique.",
      },
    },
  },
  async execute(input) {
    const { file_path, old_string, new_string, replace_all } =
      input as EditInput;
    if (old_string === new_string) {
      throw new Error("old_string and new_string must differ");
    }
    const abs = expandPath(file_path);
    const original = await readFile(abs, "utf8");
    if (replace_all) {
      const next = original.split(old_string).join(new_string);
      if (next === original) {
        throw new Error(`old_string not found in ${abs}`);
      }
      await writeFile(abs, next, "utf8");
      const count = original.split(old_string).length - 1;
      return `replaced ${count} occurrence${count === 1 ? "" : "s"} in ${abs}`;
    }
    const first = original.indexOf(old_string);
    if (first === -1) throw new Error(`old_string not found in ${abs}`);
    const second = original.indexOf(old_string, first + old_string.length);
    if (second !== -1) {
      throw new Error(
        `old_string is not unique in ${abs} — pass replace_all=true ` +
          `or add more surrounding context to disambiguate`,
      );
    }
    await writeFile(
      abs,
      original.slice(0, first) +
        new_string +
        original.slice(first + old_string.length),
      "utf8",
    );
    return `replaced 1 occurrence in ${abs}`;
  },
});

// ── Bash ────────────────────────────────────────────────────────────────────

const BASH_DEFAULT_TIMEOUT_MS = 30_000;
const BASH_MAX_TIMEOUT_MS = 600_000;
/**
 * After a timeout kill, how long to wait for `close` before settling with
 * what was captured. `close` waits for the stdio pipes to drain, which a
 * descendant that escaped the kill can hold open indefinitely.
 */
const BASH_CLOSE_GRACE_MS = 2_000;

interface BashInput {
  command: string;
  description?: string;
  timeout_ms?: number;
}

/**
 * Optional run context a caller can hand `run(agent, input, { context })`
 * to scope the shell tools. The chat path passes none (daemon cwd and
 * environment, as before); an isolated one-shot passes its workspace as
 * `cwd` and its extra environment (a sub-agent's private `TMPDIR`) as
 * `env`, layered over the daemon's.
 */
export interface BuiltinRunContext {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

/** Where a shell child runs, as resolved from a tool's run context. */
interface ShellScope {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Resolve the shell scope from the SDK's `RunContext` (or its absence). */
function shellScope(runContext: unknown): ShellScope {
  const ctx = (runContext as { context?: unknown } | undefined)?.context as
    BuiltinRunContext | undefined;
  const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
  const env =
    ctx?.env && typeof ctx.env === "object"
      ? { ...process.env, ...ctx.env }
      : process.env;
  return { cwd, env };
}

function runShell(
  command: string,
  timeoutMs: number,
  scope: ShellScope = { cwd: process.cwd(), env: process.env },
): Promise<{
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}> {
  return new Promise((resolveResult) => {
    const shell =
      process.platform === "win32"
        ? {
            cmd: "powershell.exe",
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              command,
            ],
          }
        : { cmd: "bash", args: ["-lc", command] };
    // detached → own process group on POSIX, so the timeout kill reaches
    // the shell's children too. A surviving child (the `sleep` in
    // `sleep 30; echo`) holds stdout open, and `close` waits for it.
    const detached = process.platform !== "win32";
    const child = spawn(shell.cmd, shell.args, {
      cwd: scope.cwd,
      env: scope.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached,
    });
    // Bounded: an unbounded stream (`yes`, a verbose build) otherwise grows
    // until V8's string limit throws inside the data listener.
    const out = createOutputCapture();
    const err = createOutputCapture();
    child.stdout.on("data", out.push);
    child.stderr.on("data", err.push);
    let settled = false;
    let timedOut = false;
    let closeGrace: NodeJS.Timeout | undefined;
    const finish = (code: number, stderr = err.value()): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (closeGrace) clearTimeout(closeGrace);
      resolveResult({ stdout: out.value(), stderr, code, timedOut });
    };
    const killer = setTimeout(() => {
      timedOut = true;
      killGroup(child, detached);
      // A descendant that left the group can still hold the pipes open;
      // don't let it pin the tool call past the timeout.
      closeGrace = setTimeout(() => finish(-1), BASH_CLOSE_GRACE_MS);
    }, timeoutMs);
    // spawn failed (e.g. bash not in PATH on Windows). Resolve instead
    // of letting Node emit an uncaught error — the tool returns the
    // diagnostic so callers can surface it rather than crashing.
    child.on("error", (spawnErr) => finish(-1, spawnErr.message));
    child.on("close", (code) => finish(code ?? -1));
  });
}

/** SIGKILL the child's whole process group, falling back to the child. */
function killGroup(child: ChildProcess, detached: boolean): void {
  if (detached && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // group already gone — fall through to the direct kill
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already dead
  }
}

const bashTool = tool({
  name: "Bash",
  description:
    "Run a shell command. Uses PowerShell on Windows and `bash -lc` elsewhere. Returns combined stdout " +
    "and stderr along with the exit code. Default timeout 30s, max " +
    "10min. Use for inspecting files, running scripts, package " +
    "managers, git, etc. Every command runs in the foreground until it " +
    "exits or times out, so do not start long-running servers or " +
    "watchers here.",
  strict: false,
  parameters: {
    type: "object" as const,
    additionalProperties: true as const,
    required: ["command"],
    properties: {
      command: { type: "string", description: "Shell command to execute." },
      description: {
        type: "string",
        description:
          "Short (5-10 word) explanation of what this command does. Recorded in logs.",
      },
      timeout_ms: {
        type: "integer",
        minimum: 1000,
        maximum: BASH_MAX_TIMEOUT_MS,
        description: `Optional timeout in milliseconds (max ${BASH_MAX_TIMEOUT_MS}).`,
      },
    },
  },
  async execute(input, runContext) {
    const { command, timeout_ms } = input as BashInput;
    const timeout = timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS;
    const result = await runShell(command, timeout, shellScope(runContext));
    const parts: string[] = [];
    if (result.stdout) parts.push(`--- stdout ---\n${result.stdout}`);
    if (result.stderr) parts.push(`--- stderr ---\n${result.stderr}`);
    parts.push(
      `--- exit ${result.code}${result.timedOut ? " (timed out)" : ""} ---`,
    );
    return parts.join("\n");
  },
});

// ── Glob ────────────────────────────────────────────────────────────────────

interface GlobInput {
  pattern: string;
  path?: string;
}

const globTool = tool({
  name: "Glob",
  description:
    "List files matching a glob pattern (e.g. `**/*.ts`, " +
    "`src/**/*.md`). Returns absolute paths, one per line, sorted " +
    "alphabetically. Searches under `path` if provided, otherwise " +
    "under the current working directory.",
  strict: false,
  parameters: {
    type: "object" as const,
    additionalProperties: true as const,
    required: ["pattern"],
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern to match (e.g. `src/**/*.ts`).",
      },
      path: {
        type: "string",
        description:
          "Directory to search under. Defaults to the current working directory.",
      },
    },
  },
  async execute(input, runContext) {
    const { pattern, path } = input as GlobInput;
    const cwd = path ? expandPath(path) : shellScope(runContext).cwd;
    const matches: string[] = [];
    for await (const entry of glob(pattern, { cwd })) {
      matches.push(resolvePath(cwd, entry));
    }
    matches.sort();
    return matches.length > 0 ? matches.join("\n") : "(no matches)";
  },
});

// ── Grep ────────────────────────────────────────────────────────────────────

interface GrepInput {
  pattern: string;
  path?: string;
  include?: string;
}

const grepTool = tool({
  name: "Grep",
  description:
    "Search for a regular expression in files using the system " +
    "`grep` (or `rg` when available). Returns matching lines with " +
    "file paths, line numbers, and content.",
  strict: false,
  parameters: {
    type: "object" as const,
    additionalProperties: true as const,
    required: ["pattern"],
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression to search for.",
      },
      path: {
        type: "string",
        description:
          "File or directory to search. Defaults to the current working directory.",
      },
      include: {
        type: "string",
        description: "Glob limiting which files to search (e.g. `*.ts`).",
      },
    },
  },
  async execute(input, runContext) {
    const { pattern, path, include } = input as GrepInput;
    const scope = shellScope(runContext);
    const target = path ? expandPath(path) : scope.cwd;
    // Prefer ripgrep if installed; fall back to GNU/BSD grep.
    const rgCheck = await runShell(
      process.platform === "win32" ? "where.exe rg" : "command -v rg",
      2000,
    );
    const useRg = rgCheck.code === 0 && rgCheck.stdout.trim().length > 0;

    let command: string;
    if (useRg) {
      const includeFlag = include ? ` --glob ${JSON.stringify(include)}` : "";
      command = `rg -n --no-heading${includeFlag} ${JSON.stringify(pattern)} ${JSON.stringify(target)}`;
    } else {
      const includeFlag = include
        ? ` --include=${JSON.stringify(include)}`
        : "";
      command = `grep -RIn${includeFlag} -E ${JSON.stringify(pattern)} ${JSON.stringify(target)}`;
    }
    const result = await runShell(command, 30_000, scope);
    // Both rg and grep return non-zero exit when there are no matches; that
    // isn't an error from the model's perspective, surface it as "no matches".
    if (result.code !== 0 && !result.stdout && !result.stderr) {
      return "(no matches)";
    }
    if (result.stdout) return result.stdout.trimEnd();
    return result.stderr.trimEnd() || "(no matches)";
  },
});

// ── Public surface ──────────────────────────────────────────────────────────

/**
 * The full Claude-Code-equivalent filesystem + shell toolset for
 * OpenAI Agents. Pass this into `new Agent({ tools: [...] })`.
 */
export const OPENAI_AGENTS_BUILTIN_TOOLS = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
] as const;
