/**
 * `talon logs` keeps tailing across a log rotation: a daemon start moves
 * talon.log aside and starts a fresh, shorter file under the same name.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tail = vi.hoisted(() => ({
  file: "",
  listener: null as ((curr: Stats, prev: Stats) => void) | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watchFile: ((_path: string, _opts: unknown, listener: never) => {
      tail.listener = listener;
    }) as unknown as typeof actual.watchFile,
  };
});

vi.mock("../cli/context.js", () => ({
  get LOG_FILE() {
    return tail.file;
  },
}));

vi.mock("../cli/config.js", () => ({ printBanner: () => {} }));

const { tailLogs, parseLogsArgs, runLogsCommand } =
  await import("../cli/logs.js");

function line(msg: string): string {
  return JSON.stringify({ level: 30, time: 0, component: "bot", msg });
}

const stats = (ino: number, size: number) => ({ ino, size }) as Stats;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("talon logs", () => {
  it("prints the new file's lines after the log is rotated", async () => {
    tail.file = join(mkdtempSync(join(tmpdir(), "talon-logs-")), "talon.log");
    const old = Array.from({ length: 40 }, (_, i) => line(`old ${i}`));
    writeFileSync(tail.file, old.join("\n") + "\n");
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((text?: unknown) => {
      printed.push(String(text));
    });

    void tailLogs();
    await vi.waitFor(() => expect(tail.listener).not.toBeNull());
    printed.length = 0;

    // Rotation: a new inode, and far fewer lines than before.
    writeFileSync(tail.file, [line("fresh 1"), line("fresh 2")].join("\n"));
    tail.listener!(stats(2, 100), stats(1, 5000));

    expect(printed.join("\n")).toContain("fresh 1");
    expect(printed.join("\n")).toContain("fresh 2");
  });
});

describe("talon logs filters", () => {
  const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

  function rec(fields: Record<string, unknown>): string {
    return JSON.stringify({
      level: 30,
      time: NOW,
      component: "bot",
      ...fields,
    });
  }

  function capture(): string[] {
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((text?: unknown) => {
      printed.push(String(text));
    });
    return printed;
  }

  it("parses every filter flag", async () => {
    const opts = await parseLogsArgs(
      [
        "--errors",
        "--component",
        "agent",
        "--since",
        "2h",
        "--grep",
        "timeout",
        "--turn",
        "t-7",
        "-n",
        "50",
        "--no-follow",
      ],
      NOW,
    );
    expect(opts).toEqual({
      filter: {
        minLevel: "warn",
        component: "agent",
        since: NOW - 2 * 3_600_000,
        grep: "timeout",
        turn: "t-7",
      },
      follow: false,
      lines: 50,
    });
    expect(await parseLogsArgs([])).toEqual({ filter: {}, follow: true });
  });

  it("rejects bad input with a usage message", async () => {
    expect(await parseLogsArgs(["--since", "soon"])).toContain("duration");
    expect(await parseLogsArgs(["--component"])).toBe(
      "--component needs a value",
    );
    expect(await parseLogsArgs(["--bogus"])).toContain("unknown option");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runLogsCommand(["--bogus"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("prints only matching entries, reading back into rotated files", async () => {
    tail.file = join(mkdtempSync(join(tmpdir(), "talon-logs-")), "talon.log");
    writeFileSync(
      `${tail.file}.1`,
      [
        rec({ level: 50, component: "agent", msg: "rotated error turn=t-1" }),
        rec({ msg: "rotated info" }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      tail.file,
      [
        rec({ level: 40, component: "agent", msg: "live warn turn=t-2" }),
        rec({ level: 50, component: "telegram", msg: "poll failed" }),
        rec({ msg: "live info" }),
      ].join("\n") + "\n",
    );
    const printed = capture();

    await tailLogs({
      filter: { minLevel: "warn", component: "agent" },
      follow: false,
    });
    const out = printed.join("\n");
    expect(out).toContain("2 matching entries (>=warn, component=agent)");
    expect(out).toContain("rotated error turn=t-1");
    expect(out).toContain("live warn turn=t-2");
    expect(out).not.toContain("poll failed");
    expect(out).not.toContain("info");

    printed.length = 0;
    await tailLogs({ filter: { turn: "t-1" }, follow: false });
    expect(printed.join("\n")).toContain("rotated error");
    expect(printed.join("\n")).not.toContain("live warn");

    printed.length = 0;
    await tailLogs({ filter: { grep: "POLL" }, follow: false });
    expect(printed.join("\n")).toContain("poll failed");
  });

  it("applies the filter to lines that arrive while following", async () => {
    tail.file = join(mkdtempSync(join(tmpdir(), "talon-logs-")), "talon.log");
    writeFileSync(tail.file, rec({ msg: "start" }) + "\n");
    tail.listener = null;
    const printed = capture();

    void tailLogs({ filter: { minLevel: "error" }, follow: true });
    await vi.waitFor(() => expect(tail.listener).not.toBeNull());
    printed.length = 0;

    writeFileSync(
      tail.file,
      [
        rec({ msg: "start" }),
        rec({ msg: "chatter" }),
        rec({ level: 50, msg: "it broke" }),
      ].join("\n") + "\n",
    );
    tail.listener!(stats(1, 300), stats(1, 100));
    expect(printed.join("\n")).toContain("it broke");
    expect(printed.join("\n")).not.toContain("chatter");
  });
});
