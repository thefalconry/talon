/**
 * Tests for the filesystem + shell tools registered by the OpenAI
 * Agents backend.
 *
 * Each tool is exercised through its public `invoke()` entrypoint —
 * the same path the SDK uses at runtime — so input parsing, schema
 * validation, and result shaping are covered alongside the actual
 * filesystem/process behavior. Real disk operations run against a
 * per-test temp directory to avoid coupling to the project layout.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { RunContext } from "@openai/agents";

import { OPENAI_AGENTS_BUILTIN_TOOLS } from "../backend/openai-agents/builtins.js";

// Bash and Grep rely on `spawn("bash", ["-lc", ...])`. On Windows the
// Bash tool itself works correctly (spawn error is now handled), but the
// tool's output degrades to an error message rather than the expected shell
// output, so the tests are skipped on that platform.
const isWindows = process.platform === "win32";

type FunctionTool = {
  name: string;
  description: string;
  invoke: (ctx: RunContext, input: string) => Promise<string | unknown>;
};

function getTool(name: string): FunctionTool {
  const t = OPENAI_AGENTS_BUILTIN_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool '${name}' not found in builtin toolset`);
  return t as unknown as FunctionTool;
}

async function call(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const tool = getTool(name);
  const ctx = new RunContext();
  const result = await tool.invoke(ctx, JSON.stringify(input));
  return typeof result === "string" ? result : JSON.stringify(result);
}

// ── Toolset shape ───────────────────────────────────────────────────────────

describe("openai-agents / builtins / toolset shape", () => {
  it("exposes the six Claude-Code-equivalent tools", () => {
    const names = OPENAI_AGENTS_BUILTIN_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
  });

  it("every tool has a non-empty description", () => {
    for (const t of OPENAI_AGENTS_BUILTIN_TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it("every tool is a function tool (not hosted)", () => {
    for (const t of OPENAI_AGENTS_BUILTIN_TOOLS) {
      expect((t as { type: string }).type).toBe("function");
    }
  });
});

// ── Filesystem fixture ──────────────────────────────────────────────────────

let workdir: string;
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "talon-builtins-"));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

// ── Read ────────────────────────────────────────────────────────────────────

describe("openai-agents / builtins / Read", () => {
  it("returns cat -n-style line numbering", async () => {
    const path = join(workdir, "a.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n");
    const out = await call("Read", {
      file_path: path,
      offset: null,
      limit: null,
    });
    expect(out).toMatch(/^\s+1\talpha\n\s+2\tbeta\n\s+3\tgamma/);
  });

  it("respects offset (1-indexed) and limit", async () => {
    const path = join(workdir, "b.txt");
    await writeFile(path, ["one", "two", "three", "four", "five"].join("\n"));
    const out = await call("Read", { file_path: path, offset: 2, limit: 2 });
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\s+2\ttwo$/);
    expect(lines[1]).toMatch(/^\s+3\tthree$/);
  });

  it("expands ~/ to the home directory in error paths", async () => {
    // The path resolver expands ~/ before hitting readFile, so the
    // ENOENT-style error message ends up referencing an absolute
    // path under $HOME, not the literal ~/ form.
    const fake = "~/__talon_test_does_not_exist__.txt";
    const out = await call("Read", {
      file_path: fake,
      offset: null,
      limit: null,
    });
    expect(out).toMatch(/ENOENT|no such file/i);
    expect(out).not.toContain("~/");
  });

  it("surfaces a not-found error when the file does not exist", async () => {
    const out = await call("Read", {
      file_path: join(workdir, "missing.txt"),
      offset: null,
      limit: null,
    });
    expect(out).toMatch(/ENOENT|no such file/i);
  });
});

// ── Write ───────────────────────────────────────────────────────────────────

describe("openai-agents / builtins / Write", () => {
  it("creates missing parent directories", async () => {
    const nested = join(workdir, "a/b/c/out.txt");
    const result = await call("Write", { file_path: nested, content: "hello" });
    expect(existsSync(nested)).toBe(true);
    expect(await readFile(nested, "utf8")).toBe("hello");
    expect(result).toContain("wrote 5 bytes");
  });

  it("overwrites existing content", async () => {
    const path = join(workdir, "f.txt");
    await writeFile(path, "old");
    await call("Write", { file_path: path, content: "new" });
    expect(await readFile(path, "utf8")).toBe("new");
  });
});

// ── Edit ────────────────────────────────────────────────────────────────────

describe("openai-agents / builtins / Edit", () => {
  it("replaces a unique match in place", async () => {
    const path = join(workdir, "edit.txt");
    await writeFile(path, "first second third");
    const result = await call("Edit", {
      file_path: path,
      old_string: "second",
      new_string: "TWO",
      replace_all: null,
    });
    expect(result).toContain("replaced 1 occurrence");
    expect(await readFile(path, "utf8")).toBe("first TWO third");
  });

  it("surfaces a not-unique error when old_string matches multiple times and replace_all is false", async () => {
    const path = join(workdir, "edit2.txt");
    await writeFile(path, "x x x");
    const out = await call("Edit", {
      file_path: path,
      old_string: "x",
      new_string: "y",
      replace_all: null,
    });
    expect(out).toMatch(/not unique/i);
    // File should be untouched since the edit was rejected.
    expect(await readFile(path, "utf8")).toBe("x x x");
  });

  it("replaces every occurrence when replace_all is true", async () => {
    const path = join(workdir, "edit3.txt");
    await writeFile(path, "x x x");
    const result = await call("Edit", {
      file_path: path,
      old_string: "x",
      new_string: "y",
      replace_all: true,
    });
    expect(result).toContain("replaced 3 occurrences");
    expect(await readFile(path, "utf8")).toBe("y y y");
  });

  it("surfaces a not-found error when old_string isn't in the file", async () => {
    const path = join(workdir, "edit4.txt");
    await writeFile(path, "hello world");
    const out = await call("Edit", {
      file_path: path,
      old_string: "missing",
      new_string: "z",
      replace_all: null,
    });
    expect(out).toMatch(/not found/i);
  });

  it("rejects identical old and new strings", async () => {
    const path = join(workdir, "edit5.txt");
    await writeFile(path, "abc");
    const out = await call("Edit", {
      file_path: path,
      old_string: "abc",
      new_string: "abc",
      replace_all: null,
    });
    expect(out).toMatch(/must differ/i);
    expect(await readFile(path, "utf8")).toBe("abc");
  });
});

// ── Bash ────────────────────────────────────────────────────────────────────

describe.skipIf(isWindows)("openai-agents / builtins / Bash", () => {
  it("captures stdout and reports exit 0 on success", async () => {
    const out = await call("Bash", {
      command: "echo hello-from-bash",
      description: null,
      timeout_ms: null,
    });
    expect(out).toContain("hello-from-bash");
    expect(out).toContain("exit 0");
  });

  it("captures stderr and reports a non-zero exit code", async () => {
    const out = await call("Bash", {
      command: "echo oops 1>&2; exit 7",
      description: null,
      timeout_ms: null,
    });
    expect(out).toContain("--- stderr ---");
    expect(out).toContain("oops");
    expect(out).toMatch(/exit 7/);
  });

  it("kills commands that exceed the timeout", async () => {
    const out = await call("Bash", {
      command: "sleep 5",
      description: null,
      timeout_ms: 1000,
    });
    expect(out).toContain("timed out");
  }, 10_000);

  it("returns on timeout even when a grandchild still holds the output pipes", async () => {
    // `sleep` is bash's child here, not an exec'd replacement: killing only
    // bash left it holding stdout, so `close` (and the tool) waited the full
    // 30s — and the sleep outlived the timeout as an orphan.
    const started = Date.now();
    const out = await call("Bash", {
      command: "sleep 30; echo after",
      description: null,
      timeout_ms: 1000,
    });
    expect(out).toContain("timed out");
    expect(out).not.toContain("after");
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 15_000);

  it("caps captured output instead of buffering an unbounded stream", async () => {
    // Unbounded, a chatty command (`yes`, a verbose build) grew the string
    // until V8's max string length threw inside the data listener — an
    // uncaught exception that took the daemon down.
    const out = await call("Bash", {
      command: "head -c 6000000 /dev/zero | tr '\\0' a",
      description: null,
      timeout_ms: null,
    });
    expect(out.length).toBeLessThan(5 * 1024 * 1024);
    expect(out).toContain("capture cap");
    expect(out).toContain("exit 0");
  }, 15_000);
});

describe.skipIf(isWindows)("openai-agents / builtins / run context", () => {
  it("runs Bash in the run context's cwd with its env layered on", async () => {
    // An isolated one-shot (a sub-agent) hands its workspace and private
    // TMPDIR through `run(…, { context })`; the chat path passes none.
    const ctx = new RunContext({
      cwd: workdir,
      env: { TALON_TEST_SCOPE: "scoped-env" },
    });
    const out = await getTool("Bash").invoke(
      ctx,
      JSON.stringify({
        command: 'pwd; echo "$TALON_TEST_SCOPE"; echo "$PATH"',
      }),
    );
    const text = String(out);
    // basename: macOS reports the realpath (/private/var/…) of a tmp dir.
    expect(text).toContain(basename(workdir));
    expect(text).toContain("scoped-env");
    // Layered over the daemon's environment, not replacing it.
    expect(text).toContain(process.env.PATH ?? "");
  });

  it("defaults Glob to the run context's cwd when no path is given", async () => {
    await writeFile(join(workdir, "scoped.ts"), "");
    const out = await getTool("Glob").invoke(
      new RunContext({ cwd: workdir }),
      JSON.stringify({ pattern: "*.ts" }),
    );
    expect(String(out)).toContain(`${basename(workdir)}`);
    expect(String(out)).toContain("scoped.ts");
  });

  it("keeps the daemon cwd when the run carries no context", async () => {
    const out = await call("Bash", { command: "pwd" });
    expect(out).toContain(process.cwd());
  });
});

// ── Glob ────────────────────────────────────────────────────────────────────

describe("openai-agents / builtins / Glob", () => {
  beforeEach(async () => {
    await mkdir(join(workdir, "src/nested"), { recursive: true });
    await writeFile(join(workdir, "a.ts"), "");
    await writeFile(join(workdir, "b.md"), "");
    await writeFile(join(workdir, "src/c.ts"), "");
    await writeFile(join(workdir, "src/nested/d.ts"), "");
  });

  it("matches a recursive pattern relative to a given path", async () => {
    const out = await call("Glob", { pattern: "**/*.ts", path: workdir });
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    // Sorted alphabetically; the leading absolute path makes /nested/
    // sort before /src so use Set membership rather than positional
    // checks for stability across platforms.
    // Use path.basename to handle both POSIX ("/") and Windows ("\") separators.
    const names = lines.map((l) => basename(l));
    expect(new Set(names)).toEqual(new Set(["a.ts", "c.ts", "d.ts"]));
  });

  it("returns `(no matches)` when nothing matches", async () => {
    const out = await call("Glob", {
      pattern: "**/*.nonexistent",
      path: workdir,
    });
    expect(out).toBe("(no matches)");
  });
});

// ── Grep ────────────────────────────────────────────────────────────────────

describe.skipIf(isWindows)("openai-agents / builtins / Grep", () => {
  beforeEach(async () => {
    await writeFile(
      join(workdir, "haystack.txt"),
      ["first line", "needle here", "another line", "needle again"].join("\n"),
    );
    await writeFile(join(workdir, "other.txt"), "nothing relevant");
  });

  it("finds matching lines with line numbers", async () => {
    const out = await call("Grep", {
      pattern: "needle",
      path: workdir,
      include: null,
    });
    expect(out).toContain("haystack.txt");
    expect(out).toContain("needle here");
    expect(out).toContain("needle again");
    expect(out).not.toContain("other.txt");
  });

  it("returns `(no matches)` for a pattern that doesn't match", async () => {
    const out = await call("Grep", {
      pattern: "zzz_definitely_not_here_zzz",
      path: workdir,
      include: null,
    });
    expect(out).toBe("(no matches)");
  });
});
