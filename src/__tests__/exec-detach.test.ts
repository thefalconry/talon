import { spawn } from "node:child_process";
import { closeSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMeshService } from "../core/mesh/index.js";
import {
  DetachRefused,
  detachLocalRun,
  liveLocalJobs,
} from "../core/engine/gateway-actions/native/exec-detach.js";
import {
  bashLogDir,
  openBashLog,
  resetBashLogDir,
} from "../core/engine/gateway-actions/native/bash-log.js";

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

describe.skipIf(process.platform === "win32")("detachLocalRun — bounds", () => {
  afterEach(() => getMeshService().execJobs.setWake(null));

  it("refuses past the job cap so the caller kills instead", () => {
    const { child, killTree } = start("sleep 5");
    try {
      expect(() =>
        detachLocalRun({
          child,
          cmd: "over-cap",
          chatKey: "42",
          budgetMs: 1000,
          stdoutSoFar: "",
          stderrSoFar: "",
          killTree,
          maxJobs: liveLocalJobs(),
        }),
      ).toThrow(DetachRefused);
    } finally {
      killTree("SIGKILL");
    }
  });

  it("finishes a job whose pipes an escaped process keeps open", async () => {
    const woke = new Promise<string>((resolve) => {
      getMeshService().execJobs.setWake((_k, p) => resolve(p));
    });
    const before = liveLocalJobs();
    // setsid moves the sleeper out of the job's process group while it keeps
    // the inherited stdout, so `close` would not fire for 30s.
    const { child, killTree } = start(
      "setsid sleep 30 & echo shell-done; exit 0",
    );
    detachLocalRun({
      child,
      cmd: "escaper",
      chatKey: "42",
      budgetMs: 1000,
      stdoutSoFar: "",
      stderrSoFar: "",
      killTree,
      drainGraceMs: 200,
    });
    expect(liveLocalJobs()).toBe(before + 1);
    const prompt = await woke;
    expect(prompt).toContain("finished, exit 0");
    expect(prompt).toContain("shell-done");
    expect(liveLocalJobs()).toBe(before);
  }, 10_000);

  it("writes its log privately, in a directory only this user can open", async () => {
    const { child, killTree } = start("echo secret-ish; exit 0");
    const res = detachLocalRun({
      child,
      cmd: "private",
      chatKey: "0",
      budgetMs: 1000,
      stdoutSoFar: "",
      stderrSoFar: "",
      killTree,
    });
    const path = logOf(res.text);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o077).toBe(0);
  });
});

describe.skipIf(process.platform === "win32")("bash log directory", () => {
  afterEach(() => resetBashLogDir());

  it("never reuses an existing file or follows a symlink", async () => {
    const a = openBashLog("same command");
    const b = openBashLog("same command");
    expect(a.path).not.toBe(b.path);
    closeSync(a.fd);
    closeSync(b.fd);
  });

  it("falls back to a private temp dir when the stable one is not ours", async () => {
    const stable = join(tmpdir(), `talon-bash-${process.getuid!()}`);
    resetBashLogDir();
    const original = await lstat(stable).catch(() => null);
    // Simulate another user's planted directory with an open mode we cannot
    // fix: replace ours with a symlink to a world-writable dir.
    const planted = await mkdtemp(join(tmpdir(), "planted-"));
    const moved = `${stable}.moved-${process.pid}`;
    if (original) await rename(stable, moved);
    try {
      await symlink(planted, stable);
      const dir = bashLogDir();
      expect(dir).not.toBe(stable);
      expect(dir.startsWith(`${stable}-`)).toBe(true);
      expect((await stat(dir)).mode & 0o077).toBe(0);
    } finally {
      await rm(stable, { force: true });
      if (original) await rename(moved, stable);
      await rm(planted, { recursive: true, force: true });
    }
  });
});
