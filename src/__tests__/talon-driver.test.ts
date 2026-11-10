/**
 * talon-driver — the native C launcher (native/talon-driver) that
 * fronts the CLI for the apt/brew/source distribution channels. It
 * resolves a Node >= 24 and execs `node bin/talon.js <args>`.
 *
 * These tests build the launcher with the pinned Zig toolchain (zig cc)
 * and drive the real binary against fake `node` scripts and a fake
 * `talon.js`, asserting the behaviours that matter for a process that
 * sits in front of everything: exit-code and argv pass-through, the
 * authoritative TALON_NODE override, version-floor rejection with a
 * useful message, PATH discovery, and entry-point resolution.
 *
 * If zig is not installed the suite skips — the CI Driver job builds
 * with the pinned toolchain, and the wasm drift job covers the rest of
 * the native plane.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const driverSrc = fileURLToPath(
  new URL("../../native/talon-driver/src/main.c", import.meta.url),
);

function findZig(): string | null {
  const fromEnv = process.env.ZIG;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const pinned = join(homedir(), ".zig-bin", "zig");
  if (existsSync(pinned)) return pinned;
  try {
    execFileSync("zig", ["version"], { stdio: "ignore" });
    return "zig";
  } catch {
    return null;
  }
}

const zig = findZig();
const suite = zig ? describe : describe.skip;
if (!zig) {
  console.warn("talon-driver tests skipped: zig toolchain not found");
}

suite("talon-driver launcher", () => {
  let root: string;
  let driverBin: string;

  /** A fake `node`: prints its version, else echoes argv and exits `code`. */
  function fakeNode(path: string, version: string, code = 0): void {
    writeFileSync(
      path,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi
echo "NODE_ARGV: $*"
exit ${code}
`,
    );
    chmodSync(path, 0o755);
  }

  /** A fresh app dir holding a copy of the launcher beside a talon.js. */
  function appWithJs(): { dir: string; bin: string } {
    const dir = mkdtempSync(join(root, "app-"));
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const bin = join(binDir, "talon");
    copyFileSync(driverBin, bin);
    chmodSync(bin, 0o755);
    writeFileSync(join(binDir, "talon.js"), "process.exit(0);\n");
    return { dir, bin };
  }

  function runDriver(
    bin: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): { status: number | null; stderr: string; stdout: string } {
    // Minimal base env so the launcher's PATH/common-dir scan can't
    // reach a real system node unless the test puts one there.
    const res = spawnSync(bin, args, {
      env: { PATH: "/nonexistent", ...env },
      encoding: "utf-8",
    });
    return { status: res.status, stderr: res.stderr, stdout: res.stdout };
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "talon-driver-"));
    driverBin = join(root, "talon");
    execFileSync(
      zig as string,
      [
        "cc",
        "-O2",
        "-g0",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        driverSrc,
        "-o",
        driverBin,
      ],
      { stdio: "pipe" },
    );
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("execs node with talon.js + forwarded args and passes the exit code", () => {
    const { bin } = appWithJs();
    const node = join(root, "node-ok");
    fakeNode(node, "v24.3.1", 9);

    const { status, stdout } = runDriver(bin, ["run", "--flag", "x"], {
      TALON_NODE: node,
    });
    expect(status).toBe(9); // the launcher *becomes* node — node's code wins
    // argv[0]=node is consumed; talon.js then the forwarded args follow.
    expect(stdout).toContain("/talon.js run --flag x");
  });

  it("treats TALON_NODE as authoritative and rejects an old one with its version", () => {
    const { bin } = appWithJs();
    const old = join(root, "node-old");
    fakeNode(old, "v18.20.4");

    const { status, stderr } = runDriver(bin, ["run"], { TALON_NODE: old });
    expect(status).toBe(69);
    expect(stderr).toContain("Node v18");
    expect(stderr).toContain(">= 24");
  });

  it("hard-fails when TALON_NODE points at a non-executable path", () => {
    const { bin } = appWithJs();
    const { status, stderr } = runDriver(bin, ["run"], {
      TALON_NODE: join(root, "does-not-exist"),
    });
    expect(status).toBe(69);
    expect(stderr).toContain("is not an executable file");
  });

  it("runs a node path containing spaces without shell reinterpretation", () => {
    const { bin } = appWithJs();
    const spaced = join(root, "node dir with spaces");
    mkdirSync(spaced);
    const node = join(spaced, "node");
    fakeNode(node, "v24.0.0", 0);

    const { status, stdout } = runDriver(bin, ["ok"], { TALON_NODE: node });
    expect(status).toBe(0);
    expect(stdout).toContain("/talon.js ok");
  });

  it("discovers node on PATH when TALON_NODE is unset", () => {
    const { bin } = appWithJs();
    const dir = mkdtempSync(join(root, "pathdir-"));
    fakeNode(join(dir, "node"), "v25.1.0", 0);

    const { status, stdout } = runDriver(bin, ["hi"], { PATH: dir });
    expect(status).toBe(0);
    expect(stdout).toContain("/talon.js hi");
  });

  it("ignores a relative PATH entry rather than running a CWD-relative ./node", () => {
    // A relative PATH element (".") must never cause the launcher to run
    // an attacker-planted ./node from the current working directory.
    const { dir, bin } = appWithJs();
    const evil = mkdtempSync(join(root, "cwd-"));
    // Any execution of ./node, including the --version probe, leaves this
    // marker, written with a shell builtin because the test's PATH has no
    // touch. The launcher also searches fixed dirs such as /usr/local/bin, so
    // its exit status depends on whether the machine has a real node.
    const marker = join(evil, "ran");
    writeFileSync(
      join(evil, "node"),
      `#!/bin/sh\n: > "${marker}"\necho v99.0.0\n`,
    );
    chmodSync(join(evil, "node"), 0o755);

    spawnSync(bin, ["x"], {
      cwd: evil,
      env: { PATH: ".:/nonexistent" },
      encoding: "utf-8",
    });
    void dir;
    expect(existsSync(marker)).toBe(false);
  });

  it("accepts a chatty node that prints a banner after the version line", () => {
    // Version-manager shims (asdf/mise/nvm) may print a banner to stdout
    // after the version. The probe must drain the pipe to EOF, not close
    // it early and SIGPIPE an otherwise-usable node.
    const { bin } = appWithJs();
    const node = join(root, "node-chatty");
    writeFileSync(
      node,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "v24.9.0"
  # >63 bytes of banner after the version line — would SIGPIPE the child
  # if the launcher stopped reading at the version.
  i=0; while [ $i -lt 40 ]; do echo "notice: corepack banner line padding"; i=$((i+1)); done
  exit 0
fi
echo "NODE_ARGV: $*"
exit 0
`,
    );
    chmodSync(node, 0o755);

    const { status, stdout } = runDriver(bin, ["go"], { TALON_NODE: node });
    expect(status).toBe(0);
    expect(stdout).toContain("/talon.js go");
  });

  it("reports a missing JS entry instead of launching node", () => {
    // Launcher in an isolated dir with no talon.js anywhere near it.
    const lone = mkdtempSync(join(root, "lone-"));
    const bin = join(lone, "talon");
    copyFileSync(driverBin, bin);
    chmodSync(bin, 0o755);
    const node = join(root, "node-ok2");
    fakeNode(node, "v24.3.1", 0);

    const { status, stderr } = runDriver(bin, [], {
      TALON_NODE: node,
      TALON_JS: "",
    });
    expect(status).toBe(69);
    expect(stderr).toContain("cannot find the Talon JS entry");
  });

  it("honors a TALON_JS override", () => {
    const lone = mkdtempSync(join(root, "lone2-"));
    const bin = join(lone, "talon");
    copyFileSync(driverBin, bin);
    chmodSync(bin, 0o755);
    const js = join(root, "custom-entry.js");
    writeFileSync(js, "process.exit(0);\n");
    const node = join(root, "node-ok3");
    fakeNode(node, "v24.3.1", 3);

    const { status, stdout } = runDriver(bin, ["z"], {
      TALON_NODE: node,
      TALON_JS: js,
    });
    expect(status).toBe(3);
    expect(stdout).toContain("custom-entry.js z");
  });
});
