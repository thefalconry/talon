/**
 * Kimi backend hardening: what happens when the CLI misbehaves.
 *
 * A fake `kimi` (a node script) stands in for the real CLI so the child
 * and one-shot paths run against a real subprocess. What would reveal a
 * regression: a malformed or unexpected stream line throwing out of the
 * stdout listener (an uncaught exception takes the daemon down), a failed
 * one-shot returning normally (recorded as a success), the prompt landing
 * in the log, or the orphan sweep matching on a label kimi never carries.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../backend/runtime/metrics.js", () => ({
  recordToolCall: vi.fn(),
}));

const { parseKimiLine } = await import("../backend/kimi/events.js");
const {
  KimiChild,
  describeKimiArgs,
  kimiPromptTooLarge,
  KIMI_MAX_PROMPT_BYTES,
  ensureChild,
  killChild,
} = await import("../backend/kimi/process/child.js");
const { runOneShotAgent, KimiOneShotError } =
  await import("../backend/kimi/one-shot.js");
const { environHasRunLabel, isKimiArgv } =
  await import("../backend/kimi/process/orphans.js");
const { KIMI_RUN_LABEL_ENV, kimiSystemPromptSuffix } =
  await import("../backend/kimi/constants.js");

let dir: string;
let fakeKimi: string;

/**
 * Prints FAKE_KIMI_LINES (a JSON array) to stdout, each followed by a
 * newline unless FAKE_KIMI_NO_TRAILING_NL is set, then exits FAKE_KIMI_EXIT.
 * With FAKE_KIMI_ECHO_LABEL it answers with its run-label env var.
 */
const FAKE_KIMI = `#!/usr/bin/env node
const lines = JSON.parse(process.env.FAKE_KIMI_LINES || "[]");
if (process.env.FAKE_KIMI_ECHO_LABEL) {
  lines.push(JSON.stringify({ role: "assistant", content: "label=" + (process.env.${KIMI_RUN_LABEL_ENV} || "") }));
}
const out = lines.join("\\n") + (process.env.FAKE_KIMI_NO_TRAILING_NL ? "" : "\\n");
if (process.env.FAKE_KIMI_STDERR) process.stderr.write(process.env.FAKE_KIMI_STDERR);
process.stdout.write(out, () => process.exit(Number(process.env.FAKE_KIMI_EXIT || 0)));
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "talon-kimi-hardening-"));
  fakeKimi = join(dir, "kimi");
  writeFileSync(fakeKimi, FAKE_KIMI);
  chmodSync(fakeKimi, 0o755);
  // Keep readKimiSessionUsage away from the real ~/.kimi-code.
  vi.stubEnv("KIMI_CODE_HOME", join(dir, "home"));
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const line = (event: unknown): string => JSON.stringify(event);

describe("kimi events — unexpected shapes are normalised, never thrown on", () => {
  it("turns non-string tool content into text", () => {
    expect(
      parseKimiLine(line({ role: "tool", tool_call_id: "a", content: null })),
    ).toEqual({ role: "tool", tool_call_id: "a", content: "" });
    expect(
      parseKimiLine(
        line({
          role: "tool",
          tool_call_id: "a",
          content: [{ type: "text", text: "one" }, { type: "image" }, "two"],
        }),
      ),
    ).toEqual({ role: "tool", tool_call_id: "a", content: "onetwo" });
  });

  it("drops null and id-less tool calls and names nameless ones", () => {
    const event = parseKimiLine(
      line({
        role: "assistant",
        tool_calls: [
          null,
          { id: "x" },
          { function: { name: "Bash", arguments: "{}" } },
          { id: "y", function: { name: 7, arguments: { cmd: "ls" } } },
        ],
      }),
    );
    expect(event).toEqual({
      role: "assistant",
      tool_calls: [
        {
          type: "function",
          id: "y",
          function: { name: "unknown", arguments: '{"cmd":"ls"}' },
        },
      ],
    });
  });

  it("keeps a session id only when it is a string", () => {
    expect(
      parseKimiLine(
        line({ role: "meta", type: "session.resume_hint", session_id: 5 }),
      ),
    ).toMatchObject({ session_id: undefined });
  });

  it("rejects arrays and unknown roles", () => {
    expect(parseKimiLine("[1,2]")).toBeNull();
    expect(parseKimiLine(line({ role: "system" }))).toBeNull();
  });
});

describe("kimi child — a throwing stream handler fails the turn, not the daemon", () => {
  const spec = (env: Record<string, string>) => ({
    binary: fakeKimi,
    cwd: dir,
    model: "m",
    env: { ...process.env, ...env },
  });

  it("rejects the turn with the handler's error", async () => {
    const child = new KimiChild(
      "chat-throws",
      spec({
        FAKE_KIMI_LINES: JSON.stringify([
          line({ role: "assistant", content: "hi" }),
          line({ role: "meta", type: "session.resume_hint", session_id: "s1" }),
        ]),
      }),
    );
    const boom = new Error("metrics write failed");
    await expect(
      child.runTurn("prompt", {
        onStep: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
  });

  it("rejects when the throwing line is the unterminated last one", async () => {
    const child = new KimiChild(
      "chat-flush-throws",
      spec({
        FAKE_KIMI_LINES: JSON.stringify([
          line({ role: "assistant", content: "x" }),
        ]),
        FAKE_KIMI_NO_TRAILING_NL: "1",
      }),
    );
    const boom = new Error("flush handler failed");
    await expect(
      child.runTurn("prompt", {
        onStep: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
  });

  it("still resolves a normal turn with its session id and label tag", async () => {
    const seen: string[] = [];
    const child = new KimiChild(
      "chat-ok",
      spec({
        FAKE_KIMI_LINES: JSON.stringify([
          line({ role: "meta", type: "session.resume_hint", session_id: "s2" }),
        ]),
        FAKE_KIMI_ECHO_LABEL: "1",
      }),
    );
    const result = await child.runTurn("prompt", {
      onStep: (e) => {
        if (e.role === "assistant" && e.content) seen.push(e.content);
      },
    });
    expect(result.sessionId).toBe("s2");
    expect(seen).toEqual(["label=chat-ok"]);
  });
});

describe("kimi child — pooled children track the spec's session", () => {
  it("drops a stale session id when the chat starts a fresh session", () => {
    const first = ensureChild("chat-pool", {
      binary: fakeKimi,
      cwd: dir,
      model: "m",
      sessionId: "old",
    });
    expect(first.sessionId).toBe("old");
    const again = ensureChild("chat-pool", {
      binary: fakeKimi,
      cwd: dir,
      model: "m",
    });
    expect(again).toBe(first);
    expect(again.sessionId).toBeUndefined();
    killChild("chat-pool", "test");
  });
});

describe("kimi argv — the prompt stays out of the log", () => {
  it("replaces the prompt with its size", () => {
    const rendered = describeKimiArgs([
      "--output-format",
      "stream-json",
      "-p",
      "my secret message",
      "-m",
      "model",
    ]);
    expect(rendered).not.toContain("secret");
    expect(rendered).toBe(
      "--output-format stream-json -p <prompt: 17 bytes> -m model",
    );
  });

  it("refuses a prompt over the per-argument limit with a clear error", () => {
    if (process.platform !== "linux") return;
    expect(
      kimiPromptTooLarge("x".repeat(KIMI_MAX_PROMPT_BYTES)),
    ).toBeUndefined();
    const err = kimiPromptTooLarge("x".repeat(KIMI_MAX_PROMPT_BYTES + 1));
    expect(err?.message).toMatch(/command-line argument/);
  });
});

describe("kimi one-shot — failures are thrown, not swallowed", () => {
  const params = (overrides: Record<string, unknown> = {}) => ({
    prompt: "do the thing",
    systemPrompt: "system",
    model: "m",
    workspace: dir,
    contextLabel: "cron-job-1",
    abortController: new AbortController(),
    appendLog: vi.fn(async () => {}),
    ...overrides,
  });

  afterEach(() => {
    vi.stubEnv("FAKE_KIMI_LINES", "");
    vi.stubEnv("FAKE_KIMI_EXIT", "");
    vi.stubEnv("FAKE_KIMI_STDERR", "");
    vi.stubEnv("FAKE_KIMI_ECHO_LABEL", "");
  });

  it("throws on a non-zero exit", async () => {
    vi.stubEnv("KIMI_BINARY", fakeKimi);
    vi.stubEnv("FAKE_KIMI_EXIT", "3");
    vi.stubEnv("FAKE_KIMI_STDERR", "provider error");
    const p = params();
    await expect(runOneShotAgent(p as never)).rejects.toBeInstanceOf(
      KimiOneShotError,
    );
    expect(p.appendLog).toHaveBeenCalledWith(
      expect.stringContaining("provider error"),
    );
  });

  it("throws when the binary cannot be spawned", async () => {
    vi.stubEnv("KIMI_BINARY", join(dir, "no-such-kimi"));
    await expect(runOneShotAgent(params() as never)).rejects.toBeInstanceOf(
      KimiOneShotError,
    );
  });

  it("returns normally on success and tags the process with its label", async () => {
    vi.stubEnv("KIMI_BINARY", fakeKimi);
    vi.stubEnv("FAKE_KIMI_ECHO_LABEL", "1");
    const onAssistantText = vi.fn();
    await expect(
      runOneShotAgent(params({ onAssistantText }) as never),
    ).resolves.toBeUndefined();
    expect(onAssistantText).toHaveBeenCalledWith("label=cron-job-1");
  });

  it("does not let a failing log write escape as an unhandled rejection", async () => {
    vi.stubEnv("KIMI_BINARY", fakeKimi);
    vi.stubEnv(
      "FAKE_KIMI_LINES",
      JSON.stringify([
        line({ role: "tool", tool_call_id: "t", content: "out" }),
      ]),
    );
    const appendLog = vi.fn(async (text: string) => {
      if (text.includes("Tool Output")) throw new Error("disk full");
    });
    await expect(
      runOneShotAgent(params({ appendLog }) as never),
    ).resolves.toBeUndefined();
  });
});

describe("kimi orphan sweep — matches the env tag exactly", () => {
  it("matches only the exact label entry", () => {
    const env = [`PATH=/bin`, `${KIMI_RUN_LABEL_ENV}=cron-job-1`];
    expect(environHasRunLabel(env, "cron-job-1")).toBe(true);
    expect(environHasRunLabel(env, "cron-job")).toBe(false);
    expect(
      environHasRunLabel([`X=${KIMI_RUN_LABEL_ENV}=cron-job-1`], "cron-job-1"),
    ).toBe(false);
  });

  it("recognises kimi run directly or through its node shebang", () => {
    expect(isKimiArgv(["kimi", "-p", "x"])).toBe(true);
    expect(isKimiArgv(["node", "/usr/lib/node_modules/.bin/kimi", "-p"])).toBe(
      true,
    );
    expect(isKimiArgv(["node", "/srv/kimi-tools/run.js"])).toBe(false);
  });
});

describe("kimi system prompt — no tools it does not have", () => {
  it("does not tell the model to call Talon delivery tools", () => {
    const suffix = kimiSystemPromptSuffix("telegram");
    expect(suffix).toMatch(/plain assistant text is the reply/i);
    expect(suffix).toMatch(/do not exist here/);
    expect(suffix).not.toMatch(/end_turn\(text=/);
  });
});
