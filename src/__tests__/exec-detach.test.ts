import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { getMeshService } from "../core/mesh/index.js";
import { detachLocalRun } from "../core/engine/gateway-actions/native/exec-detach.js";

function start(script: string) {
  const child = spawn("bash", ["-c", script], { detached: true });
  const killTree = (signal: NodeJS.Signals) => {
    try {
      process.kill(-(child.pid as number), signal);
    } catch {
      // already gone
    }
  };
  return { child: child as typeof child & { pid: number }, killTree };
}

const logOf = (text: string | undefined) =>
  (text ?? "").match(/→ (\S+\.log)/)?.[1] as string;

describe.skipIf(process.platform === "win32")("detachLocalRun", () => {
  afterEach(() => getMeshService().execJobs.setWake(null));

  it("wakes the starting chat with exit code and tail when the job ends", async () => {
    const woke = new Promise<[string, string]>((resolve) => {
      getMeshService().execJobs.setWake((k, p) => resolve([k, p]));
    });
    const { child, killTree } = start("sleep 0.2; echo late-line; exit 4");
    const res = detachLocalRun({
      child,
      cmd: "the-command",
      chatKey: "42",
      budgetMs: 1000,
      stdoutSoFar: "early-line\n",
      stderrSoFar: "",
      killTree,
    });
    expect(res.text).toContain("gets a wake-up");
    const [chat, prompt] = await woke;
    expect(chat).toBe("42");
    expect(prompt).toContain("finished, exit 4");
    expect(prompt).toContain("the-command");
    expect(prompt).toContain("late-line");
    const logged = await readFile(logOf(res.text), "utf8");
    expect(logged).toContain("early-line");
    expect(logged).toContain("late-line");
  }, 10_000);

  it("says so when there is no chat to wake", () => {
    getMeshService().execJobs.setWake(() => {
      throw new Error("must not wake");
    });
    const { child, killTree } = start("exit 0");
    const res = detachLocalRun({
      child,
      cmd: "x",
      chatKey: "0",
      budgetMs: 1000,
      stdoutSoFar: "",
      stderrSoFar: "",
      killTree,
    });
    expect(res.text).toContain("poll the log");
  });

  it("kills a job whose log hits the cap, and reports why", async () => {
    const woke = new Promise<string>((resolve) => {
      getMeshService().execJobs.setWake((_k, p) => resolve(p));
    });
    const { child, killTree } = start("yes spam");
    detachLocalRun({
      child,
      cmd: "spam",
      chatKey: "42",
      budgetMs: 1000,
      stdoutSoFar: "",
      stderrSoFar: "",
      killTree,
      maxLogBytes: 100_000,
    });
    expect(await woke).toContain("was killed: log reached 100000 bytes");
  }, 10_000);

  it("kills a job at its hard time limit", async () => {
    const woke = new Promise<string>((resolve) => {
      getMeshService().execJobs.setWake((_k, p) => resolve(p));
    });
    const { child, killTree } = start("sleep 60");
    detachLocalRun({
      child,
      cmd: "sleeper",
      chatKey: "42",
      budgetMs: 1000,
      stdoutSoFar: "",
      stderrSoFar: "",
      killTree,
      maxJobMs: 200,
    });
    expect(await woke).toContain("was killed");
  }, 10_000);
});
