/**
 * Runtime retention for talon.log: the file sink shifts the live file
 * into numbered generations once it passes the cap, so a long-running
 * daemon keeps bounded, numbered history instead of one file that grows
 * until the next start (which then kept exactly one `.old`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep log.ts's module-level initialization away from the real ~/.talon.
const fakePaths = vi.hoisted(() => {
  const root = `${process.env.TMPDIR ?? "/tmp"}/talon-log-rot-test-${process.pid}`;
  return {
    root,
    log: `${root}/talon.log`,
    config: `${root}/config.json`,
    respawnLog: `${root}/respawn.log`,
  };
});
vi.mock("../util/paths.js", () => ({
  dirs: { root: fakePaths.root },
  files: {
    log: fakePaths.log,
    config: fakePaths.config,
    respawnLog: fakePaths.respawnLog,
  },
}));
vi.mock("pino", () => ({
  default: Object.assign(
    () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
    { multistream: vi.fn(() => ({ write: vi.fn() })) },
  ),
}));
vi.mock("pino-pretty", () => ({
  default: () => ({ write: vi.fn(), on: vi.fn() }),
}));

const { ResilientFileSink, shiftLogGenerations } =
  await import("../util/log.js");

/** A 100-byte line (99 chars + newline) tagged with its sequence number. */
function line(n: number): string {
  return `${String(n).padStart(6, "0")} ${"x".repeat(92)}\n`;
}

function linesIn(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter(Boolean);
}

describe("ResilientFileSink rotation", () => {
  let dir: string;
  let logPath: string;
  let notices: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "talon-rot-"));
    logPath = join(dir, "talon.log");
    notices = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakePaths.root, { recursive: true, force: true });
  });

  const sinkWith = (opts: { rotateAtBytes: number; keep: number }) =>
    new ResilientFileSink(logPath, {
      ...opts,
      notify: (level, message) => notices.push(`${level}: ${message}`),
    });

  it("shifts into numbered generations at the size cap, dropping only the oldest", async () => {
    const sink = sinkWith({ rotateAtBytes: 1_000, keep: 3 });
    // 60 lines × 100 B = 6 KB → rotates after every 11th line.
    for (let n = 0; n < 60; n++) sink.write(line(n));
    sink.end();
    await Promise.resolve();

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(`${logPath}.2`)).toBe(true);
    expect(existsSync(`${logPath}.3`)).toBe(true);
    expect(existsSync(`${logPath}.4`)).toBe(false);
    // Each generation holds just over the cap; the live file the rest.
    expect(linesIn(`${logPath}.1`)).toHaveLength(11);

    // Newest-first generations read back oldest-first form an unbroken
    // tail of the sequence: nothing between the kept files was lost.
    const kept = [
      ...linesIn(`${logPath}.3`),
      ...linesIn(`${logPath}.2`),
      ...linesIn(`${logPath}.1`),
      ...linesIn(logPath),
    ].map((l) => Number(l.slice(0, 6)));
    expect(kept.at(-1)).toBe(59);
    for (let i = 1; i < kept.length; i++) expect(kept[i]).toBe(kept[i - 1] + 1);

    expect(notices.some((n) => n.includes("log.rotate file="))).toBe(true);
    expect(notices.find((n) => n.includes("log.rotate"))).toContain(
      `previous=${logPath}.1`,
    );
  });

  it("counts bytes already in the file when it opens", () => {
    writeFileSync(logPath, line(0).repeat(9)); // 900 B before we start
    const sink = sinkWith({ rotateAtBytes: 1_000, keep: 2 });
    sink.write(line(1));
    expect(existsSync(`${logPath}.1`)).toBe(false);
    sink.write(line(2)); // 1100 B → rotate
    expect(linesIn(`${logPath}.1`)).toHaveLength(11);
    sink.write(line(3));
    expect(linesIn(logPath)).toEqual([line(3).trimEnd()]);
    sink.end();
  });

  it("does not rotate a file another process already rotated", () => {
    const sink = sinkWith({ rotateAtBytes: 1_000, keep: 2 });
    for (let n = 0; n < 9; n++) sink.write(line(n));
    // Someone else shifted the file away; our fd still points at it.
    renameSync(logPath, `${logPath}.1`);
    writeFileSync(logPath, "");
    sink.write(line(9));
    sink.write(line(10)); // our count passes the cap, the disk does not
    expect(existsSync(`${logPath}.2`)).toBe(false);
    sink.end();
  });

  it("keeps appending, and warns once, when the shift fails", async () => {
    // keep=1 means "unlink talon.log.1" first — a directory there makes
    // that step fail with something other than ENOENT.
    mkdirSync(`${logPath}.1`);
    writeFileSync(join(`${logPath}.1`, "blocker"), "");
    const sink = sinkWith({ rotateAtBytes: 1_000, keep: 1 });
    for (let n = 0; n < 15; n++) sink.write(line(n));
    await Promise.resolve();
    expect(notices.filter((n) => n.includes("log.rotate failed"))).toHaveLength(
      1,
    );
    expect(linesIn(logPath)).toHaveLength(15);
    expect(sink.isDown).toBe(false);
    sink.end();
  });

  it("rotateAtBytes 0 disables runtime rotation", () => {
    const sink = sinkWith({ rotateAtBytes: 0, keep: 2 });
    for (let n = 0; n < 30; n++) sink.write(line(n));
    sink.end();
    expect(existsSync(`${logPath}.1`)).toBe(false);
    expect(linesIn(logPath)).toHaveLength(30);
  });
});

describe("shiftLogGenerations", () => {
  it("tolerates gaps left by a crash mid-shift", () => {
    const dir = mkdtempSync(join(tmpdir(), "talon-shift-"));
    const path = join(dir, "talon.log");
    writeFileSync(path, "live");
    writeFileSync(`${path}.2`, "two"); // .1 missing: a crash mid-shift
    shiftLogGenerations(path, 3);
    expect(readFileSync(`${path}.1`, "utf-8")).toBe("live");
    expect(readFileSync(`${path}.3`, "utf-8")).toBe("two");
    expect(existsSync(path)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
