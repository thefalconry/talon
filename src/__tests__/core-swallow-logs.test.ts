/**
 * Core and native paths that swallow a failure by design now leave a
 * log line saying why — without changing what they return, and without
 * letting a secret into the line.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logs = vi.hoisted(() => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../util/log.js", () => logs);

import { parseClaudeCredentials } from "../core/auth/status.js";
import { TaskTable } from "../core/tasks/table.js";
import {
  _resetNativeBlake3ForTesting,
  nativeBlake3,
} from "../native/blake3.js";

beforeEach(() => {
  for (const fn of Object.values(logs)) fn.mockClear();
});

describe("auth status — unparseable credentials", () => {
  it("warns with the length only, never the file's content", () => {
    const secret = "sk-ant-oat01-SECRETSECRET";
    const status = parseClaudeCredentials(`{"claudeAiOauth": ${secret}`);

    expect(status.loggedIn).toBe(false);
    expect(logs.logWarn).toHaveBeenCalledTimes(1);
    const [component, message] = logs.logWarn.mock.calls[0] as [string, string];
    expect(component).toBe("notify");
    expect(message).toContain("claude credentials file is not valid JSON");
    expect(message).not.toContain("SECRET");
  });
});

describe("task table — a throwing abort hook", () => {
  it("still reports ok and logs the task it could not abort", () => {
    const table = new TaskTable();
    const handle = table.begin({
      kind: "cron",
      label: "nightly",
      abort: () => {
        throw new Error("hook exploded");
      },
    });

    expect(table.kill(handle.id)).toEqual({ ok: true });
    expect(logs.logWarn).toHaveBeenCalledWith(
      "tasks",
      expect.stringMatching(
        new RegExp(
          `Abort hook threw task=${handle.id} kind=cron label="nightly": hook exploded`,
        ),
      ),
    );
  });
});

describe("blake3 — an explicit addon override that fails to load", () => {
  const saved = process.env.TALON_BLAKE3_NODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.TALON_BLAKE3_NODE;
    else process.env.TALON_BLAKE3_NODE = saved;
    _resetNativeBlake3ForTesting();
  });

  it("falls back to wasm and warns that the override did not take", () => {
    process.env.TALON_BLAKE3_NODE = "/nonexistent/talon-blake3.node";
    _resetNativeBlake3ForTesting();

    expect(nativeBlake3()).toBeNull();
    expect(logs.logWarn).toHaveBeenCalledWith(
      "native",
      expect.stringContaining(
        "TALON_BLAKE3_NODE addon rejected, using wasm path=/nonexistent/talon-blake3.node",
      ),
    );
  });
});
