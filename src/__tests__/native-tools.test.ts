/**
 * Native tools — Talon's own bash/read/write/edit/glob/search plus teleport.
 *
 *   - composeTools gating: the native set is opt-in (includeNativeTools)
 *   - local execution: shell + filesystem run on the daemon host
 *   - teleport routing: with a target engaged, bash runs on the device via
 *     the mesh exec channel, marker-based cwd tracking persists across calls
 */

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MeshRegistry,
  MeshService,
  setMeshService,
} from "../core/mesh/index.js";
import { resetTeleportCache } from "../core/mesh/devices/teleport.js";
import { nativeHandlers } from "../core/engine/gateway-actions/native/index.js";
import { composeTools } from "../core/tools/index.js";

let workdir: string;

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), "talon-native-"));
  process.env.TALON_TELEPORT_STATE_FILE = join(workdir, "teleport.json");
});

afterEach(async () => {
  await nativeHandlers.teleport_back(
    { action: "teleport_back" },
    1,
    undefined,
    "1",
  );
  resetTeleportCache();
  setMeshService(null);
});

function freshMesh(): MeshService {
  return new MeshService(
    new MeshRegistry({
      devices: join(workdir, `d-${Math.random()}.json`),
      locations: join(workdir, `l-${Math.random()}.json`),
      history: join(workdir, `h-${Math.random()}.json`),
    }),
  );
}

describe("native handler registry", () => {
  it("pins the action names and their order", () => {
    // Action names are the model's tool vocabulary, and they ride in the
    // prompt-cache prefix through the tool descriptions — renaming or
    // reordering one re-bills every live chat. This list was captured from
    // the single `nativeHandlers` object literal before it was split into
    // per-concern modules; the spread order in native/index.ts must keep
    // reproducing it exactly.
    expect(Object.keys(nativeHandlers)).toEqual([
      "teleport",
      "teleport_back",
      "native_bash",
      "native_read",
      "native_write",
      "native_edit",
      "native_glob",
      "native_search",
    ]);
  });
});

describe("native tool composition gating", () => {
  it("excludes the native set by default and includes it on request", () => {
    const off = composeTools({ frontend: "telegram" }).map((t) => t.name);
    for (const n of [
      "bash",
      "read",
      "write",
      "edit",
      "glob",
      "search",
      "teleport",
    ]) {
      expect(off).not.toContain(n);
    }

    const on = composeTools({
      frontend: "telegram",
      includeNativeTools: true,
    }).map((t) => t.name);
    for (const n of [
      "bash",
      "read",
      "write",
      "edit",
      "glob",
      "search",
      "teleport",
      "teleport_back",
    ]) {
      expect(on).toContain(n);
    }
  });
});

describe("native tools — local execution", () => {
  it("runs a shell command on the daemon host", async () => {
    const res = await nativeHandlers.native_bash(
      { action: "native_bash", command: "echo hello-native" },
      1,
      undefined,
      "1",
    );
    expect(res.ok).toBe(true);
    expect(res.text).toContain("hello-native");
    expect(res.text).toContain("exit 0");
  });

  it("reports a non-zero exit", async () => {
    const res = await nativeHandlers.native_bash(
      { action: "native_bash", command: "exit 3" },
      1,
      undefined,
      "1",
    );
    expect(res.ok).toBe(false);
    expect(res.text).toContain("exit 3");
  });

  it("points at the near-miss line when an edit's old_string doesn't match", async () => {
    const f = join(workdir, "near-miss.ts");
    await nativeHandlers.native_write(
      {
        action: "native_write",
        path: f,
        content: "function x() {\n\treturn compute(a, b) + 1;\n}\n",
      },
      1,
      undefined,
      "1",
    );
    // Same code, but space-indented — the classic invisible mismatch.
    const res = await nativeHandlers.native_edit(
      {
        action: "native_edit",
        path: f,
        old_string: "  return compute(a, b) + 1;",
        new_string: "  return compute(a, b) + 2;",
      },
      1,
      undefined,
      "1",
    );
    expect(res.ok).toBe(false);
    expect(res.text).toContain("not found");
    expect(res.text).toContain("Line 2 looks close");
    expect(res.text).toContain("return compute(a, b) + 1;");
  });

  it("keeps partial output and hints at background mode on timeout", async () => {
    const res = await nativeHandlers.native_bash(
      {
        action: "native_bash",
        command: "echo streaming-head; sleep 30",
        timeout_sec: 1,
        on_timeout: "kill",
      },
      1,
      undefined,
      "1",
    );
    expect(res.ok).toBe(false);
    expect(res.text).toContain("timed out after 1s");
    expect(res.text).toContain("streaming-head"); // partial output survives
    expect(res.text).toContain("background:true"); // self-correction hint
  }, 15_000);

  it.skipIf(process.platform === "win32")(
    "keeps a command running past its budget and logs all its output",
    async () => {
      const marker = join(tmpdir(), `detach-${process.pid}-${Date.now()}`);
      const res = await nativeHandlers.native_bash(
        {
          action: "native_bash",
          command: `echo before; sleep 2; echo after; touch ${marker}`,
          timeout_sec: 1,
        },
        1,
        undefined,
        "1",
      );
      expect(res.ok).toBe(true);
      expect(res.text).toContain("not killed");
      const logPath = (res.text ?? "").match(/→ (\S+\.log)/)?.[1] as string;
      let logged = "";
      for (let i = 0; i < 40 && !logged.includes("after"); i++) {
        await new Promise((r) => setTimeout(r, 250));
        logged = await readFile(logPath, "utf8").catch(() => "");
      }
      expect(logged).toContain("before");
      expect(logged).toContain("after");
      // The command really ran to its end, not just its output. `touch` runs
      // after the final echo, so the log can show "after" before the marker exists.
      let marked: string | undefined;
      for (let i = 0; i < 40 && marked === undefined; i++) {
        marked = await readFile(marker, "utf8").catch(() => undefined);
        if (marked === undefined) await new Promise((r) => setTimeout(r, 100));
      }
      expect(marked).toBe("");
      await rm(marker, { force: true });
    },
    20_000,
  );

  // Background mode is POSIX-only (process groups, group kill, restart
  // survival) — the handler refuses on win32, so these run on POSIX legs.
  it.skipIf(process.platform === "win32")(
    "launches a background command and returns pid + log path",
    async () => {
      const res = await nativeHandlers.native_bash(
        {
          action: "native_bash",
          command: "echo bg-line-1; sleep 5; echo bg-line-2",
          background: true,
        },
        1,
        undefined,
        "1",
      );
      expect(res.ok).toBe(true);
      expect(res.text).toContain("Started in background");
      expect(res.text).toMatch(/pid \d+/);
      const logPath = (res.text ?? "").match(/→ (\S+\.log)/)?.[1];
      expect(logPath).toBeTruthy();
      // Output lands asynchronously (Git Bash on the Windows runners can take
      // a beat to start) — poll rather than read once.
      let logged = "";
      for (let i = 0; i < 40 && !logged.includes("bg-line-1"); i++) {
        await new Promise((r) => setTimeout(r, 250));
        logged = await readFile(logPath as string, "utf8").catch(() => "");
      }
      expect(logged).toContain("bg-line-1");
      // Clean up the straggler so the suite doesn't leak a sleeper.
      const pid = Number((res.text ?? "").match(/pid (\d+)/)?.[1]);
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          /* already gone / no process groups on this platform */
        }
      }
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "surfaces a fast-failing background command as a normal error",
    async () => {
      const res = await nativeHandlers.native_bash(
        {
          action: "native_bash",
          command: "echo doomed; exit 7",
          background: true,
        },
        1,
        undefined,
        "1",
      );
      expect(res.ok).toBe(false);
      expect(res.text).toContain("exit 7");
      expect(res.text).toContain("doomed");
    },
    15_000,
  );

  it.runIf(process.platform === "win32")(
    "refuses background mode on a Windows host with an actionable error",
    async () => {
      const res = await nativeHandlers.native_bash(
        { action: "native_bash", command: "echo hi", background: true },
        1,
        undefined,
        "1",
      );
      expect(res.ok).toBe(false);
      expect(res.text).toContain("isn't supported on a Windows");
    },
  );

  it("writes, reads (numbered), and edits a file locally", async () => {
    const f = join(workdir, "roundtrip.txt");
    const w = await nativeHandlers.native_write(
      { action: "native_write", path: f, content: "alpha\nbeta\ngamma\n" },
      1,
      undefined,
      "1",
    );
    expect(w.ok).toBe(true);

    const r = await nativeHandlers.native_read(
      { action: "native_read", path: f },
      1,
      undefined,
      "1",
    );
    expect(r.ok).toBe(true);
    expect(r.text).toContain("alpha");
    expect(r.text).toMatch(/\s+1\talpha/); // line numbers

    const e = await nativeHandlers.native_edit(
      {
        action: "native_edit",
        path: f,
        old_string: "beta",
        new_string: "BETA!",
      },
      1,
      undefined,
      "1",
    );
    expect(e.ok).toBe(true);

    const r2 = await nativeHandlers.native_read(
      { action: "native_read", path: f },
      1,
      undefined,
      "1",
    );
    expect(r2.text).toContain("BETA!");
    expect(r2.text).not.toContain("beta");
  });

  it("reads an image file as a viewable image block, not mojibake", async () => {
    // A 1x1 PNG. The bytes are not valid UTF-8, so the old text path would
    // have returned garbage; the image path returns a base64 image block.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const f = join(workdir, "pixel.png");
    await writeFile(f, png);

    const r = await nativeHandlers.native_read(
      { action: "native_read", path: f },
      1,
      undefined,
      "1",
    );
    expect(r.ok).toBe(true);
    expect(r.text).toContain("image (image/png");
    expect(r.image).toBeDefined();
    expect(r.image?.mimeType).toBe("image/png");
    expect(r.image?.data).toBe(png.toString("base64"));
  });

  it("refuses an ambiguous edit unless replace_all is set", async () => {
    const f = join(workdir, "dupe.txt");
    await nativeHandlers.native_write(
      { action: "native_write", path: f, content: "x x x" },
      1,
      undefined,
      "1",
    );
    const ambiguous = await nativeHandlers.native_edit(
      { action: "native_edit", path: f, old_string: "x", new_string: "y" },
      1,
      undefined,
      "1",
    );
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.text).toContain("appears 3×");

    const all = await nativeHandlers.native_edit(
      {
        action: "native_edit",
        path: f,
        old_string: "x",
        new_string: "y",
        replace_all: true,
      },
      1,
      undefined,
      "1",
    );
    expect(all.ok).toBe(true);
    expect(all.text).toContain("3 replacements");
  });

  it("searches file contents and globs files with ripgrep", async () => {
    const f = join(workdir, "needle.txt");
    await nativeHandlers.native_write(
      { action: "native_write", path: f, content: "find-this-token here\n" },
      1,
      undefined,
      "1",
    );
    const s = await nativeHandlers.native_search(
      { action: "native_search", pattern: "find-this-token", path: workdir },
      1,
      undefined,
      "1",
    );
    expect(s.ok).toBe(true);
    expect(s.text).toContain("find-this-token");

    const g = await nativeHandlers.native_glob(
      { action: "native_glob", pattern: "needle.txt", path: workdir },
      1,
      undefined,
      "1",
    );
    expect(g.ok).toBe(true);
    expect(g.text).toContain("needle.txt");
  });

  it("search and glob still find real matches when rg is missing (JS fallback)", async () => {
    const f = join(workdir, "fallback-needle.txt");
    await nativeHandlers.native_write(
      { action: "native_write", path: f, content: "fallback-token here\n" },
      1,
      undefined,
      "1",
    );
    process.env.TALON_NATIVE_RG = join(workdir, "no-such-rg-binary");
    try {
      const s = await nativeHandlers.native_search(
        { action: "native_search", pattern: "fallback-token", path: workdir },
        1,
        undefined,
        "1",
      );
      expect(s.ok).toBe(true);
      // Must be a REAL match line (path:line:content), not a vacuous
      // "No matches for fallback-token" echo of the pattern.
      expect(s.text).toContain("match line");
      expect(s.text).toContain(`${f}:1:`);

      const g = await nativeHandlers.native_glob(
        {
          action: "native_glob",
          pattern: "fallback-needle.txt",
          path: workdir,
        },
        1,
        undefined,
        "1",
      );
      expect(g.ok).toBe(true);
      expect(g.text).toContain("match(es)");
      expect(g.text).toContain(f);
    } finally {
      delete process.env.TALON_NATIVE_RG;
    }
  });

  it("edit keeps $-substitution patterns in new_string literal", async () => {
    const f = join(workdir, "dollar.mk");
    await nativeHandlers.native_write(
      {
        action: "native_write",
        path: f,
        content: "prefix-line\nREPLACE_ME\nsuffix-line\n",
      },
      1,
      undefined,
      "1",
    );
    // $&, $', $`, $$ are String.replace substitution directives — a literal
    // edit must write them through untouched, not expand them.
    const res = await nativeHandlers.native_edit(
      {
        action: "native_edit",
        path: f,
        old_string: "REPLACE_ME",
        new_string: 'echo "$& $\' $` $$PID"',
      },
      1,
      undefined,
      "1",
    );
    expect(res.ok).toBe(true);
    const content = await readFile(f, "utf8");
    expect(content).toBe('prefix-line\necho "$& $\' $` $$PID"\nsuffix-line\n');
  });

  it("write reports UTF-8 bytes, not UTF-16 code units", async () => {
    const f = join(workdir, "utf8-count.txt");
    const body = "h\u00e9llo \u20ac";
    const res = await nativeHandlers.native_write(
      { action: "native_write", path: f, content: body },
      1,
      undefined,
      "1",
    );
    expect(res.ok).toBe(true);
    expect(res.text).toContain(
      `Wrote ${Buffer.byteLength(body, "utf8")} bytes`,
    );
  });

  it("read clamps a negative offset and a zero limit instead of lying", async () => {
    const f = join(workdir, "clamp.txt");
    await writeFile(f, "alpha\nbravo\ncharlie\n");
    const neg = await nativeHandlers.native_read(
      { action: "native_read", path: f, offset: -5, limit: 2 },
      1,
      undefined,
      "1",
    );
    expect(neg.ok).toBe(true);
    expect(neg.text).toContain("1\talpha"); // top of file, numbered from 1
    const zero = await nativeHandlers.native_read(
      { action: "native_read", path: f, offset: 0, limit: 0 },
      1,
      undefined,
      "1",
    );
    expect(zero.ok).toBe(true);
    expect(zero.text).toContain("alpha"); // at least one line, not a fake-empty read
  });

  it("read reports an offset past the end instead of returning nothing", async () => {
    const f = join(workdir, "short.txt");
    await writeFile(f, "only\n");
    const res = await nativeHandlers.native_read(
      { action: "native_read", path: f, offset: 50 },
      1,
      undefined,
      "1",
    );
    expect(res.ok).toBe(false);
    expect(res.text).toContain("past the end");
  });

  it("read refuses binary files with a shell-tool hint", async () => {
    const f = join(workdir, "blob.bin");
    await writeFile(f, Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    const res = await nativeHandlers.native_read(
      { action: "native_read", path: f },
      1,
      undefined,
      "1",
    );
    expect(res.ok).toBe(false);
    expect(res.text).toContain("binary");
  });

  it("read refuses an oversized file with a bash hint", async () => {
    const f = join(workdir, "big.log");
    await writeFile(f, Buffer.alloc(32 * 1024 * 1024 + 1, 0x61));
    const res = await nativeHandlers.native_read(
      { action: "native_read", path: f },
      1,
      undefined,
      "1",
    );
    expect(res.ok).toBe(false);
    expect(res.text).toContain("read limit");
  });

  it("bash names a bad cwd instead of a misleading spawn error", async () => {
    const missing = await nativeHandlers.native_bash(
      {
        action: "native_bash",
        command: "echo hi",
        cwd: join(workdir, "no-such-dir"),
      },
      1,
      undefined,
      "1",
    );
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("Working directory does not exist");

    const f = join(workdir, "cwd-file.txt");
    await writeFile(f, "x");
    const notDir = await nativeHandlers.native_bash(
      { action: "native_bash", command: "echo hi", cwd: f },
      1,
      undefined,
      "1",
    );
    expect(notDir.ok).toBe(false);
    expect(notDir.text).toContain("not a directory");
  });

  it("edit refuses binary files instead of corrupting them", async () => {
    const f = join(workdir, "edit-blob.bin");
    await writeFile(f, Buffer.from([0x00, 0x41, 0x42, 0x43, 0x00, 0xff]));
    const res = await nativeHandlers.native_edit(
      { action: "native_edit", path: f, old_string: "ABC", new_string: "XYZ" },
      1,
      undefined,
      "1",
    );
    expect(res.ok).toBe(false);
    expect(res.text).toContain("binary");
    // The file must be untouched.
    const bytes = await readFile(f);
    expect([...bytes]).toEqual([0x00, 0x41, 0x42, 0x43, 0x00, 0xff]);
  });

  it("edit reports the line the replacement landed on", async () => {
    const f = join(workdir, "edit-line.txt");
    await writeFile(f, "one\ntwo\nthree\nfour\n");
    const res = await nativeHandlers.native_edit(
      { action: "native_edit", path: f, old_string: "three", new_string: "3" },
      1,
      undefined,
      "1",
    );
    expect(res.ok).toBe(true);
    expect(res.text).toContain("first at line 3");
  });

  it("glob returns deterministically sorted results", async () => {
    const dir = join(workdir, "glob-sort");
    await mkdir(dir, { recursive: true });
    for (const name of ["zz.sorted", "aa.sorted", "mm.sorted"]) {
      await writeFile(join(dir, name), "");
    }
    const res = await nativeHandlers.native_glob(
      { action: "native_glob", pattern: "*.sorted", path: dir },
      1,
      undefined,
      "1",
    );
    expect(res.ok).toBe(true);
    const text = res.text ?? "";
    const idx = ["aa", "mm", "zz"].map((n) => text.indexOf(`${n}.sorted`));
    expect(idx.every((i) => i !== -1)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
});

describe("native tools — teleport routing", () => {
  it("teleports onto a device, routes bash through the mesh, and tracks cwd", async () => {
    const service = freshMesh();
    setMeshService(service);
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["exec"],
    });
    const sentCmds: string[] = [];
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() => {
          sentCmds.push(String(cmd.params.cmd));
          // Emulate the device shell: our wrapper appends a pwd marker; return
          // some output plus the marker so cwd tracking can parse it.
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
            data: {
              stdout:
                "Downloads\nPictures\n__TALON_CWD__/sdcard/Download__TALON_CWD_END__",
              stderr: "",
              exitCode: 0,
              via: "shizuku",
            },
          });
        }),
    });

    const tp = await nativeHandlers.teleport(
      { action: "teleport", device: "phone" },
      1,
      undefined,
      "1",
    );
    expect(tp.ok).toBe(true);
    expect(tp.text).toContain("Pixel 9");

    const res = await nativeHandlers.native_bash(
      { action: "native_bash", command: "ls" },
      1,
      undefined,
      "1",
    );
    expect(res.ok).toBe(true);
    expect(res.text).toContain("[Pixel 9 via shizuku] exit 0");
    expect(res.text).toContain("Downloads");
    // The cwd marker must be stripped from what the model sees.
    expect(res.text).not.toContain("__TALON_CWD__");

    // Second command should carry the tracked cwd forward.
    resetTeleportCache();
    await nativeHandlers.native_bash(
      { action: "native_bash", command: "ls again" },
      1,
      undefined,
      "1",
    );
    expect(sentCmds[1]).toContain("cd '/sdcard/Download'");
  });

  it("appends the in-shell background hint when the device killed the command", async () => {
    const service = freshMesh();
    setMeshService(service);
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["exec"],
    });
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() => {
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: false,
            data: {
              stdout: "some log lines",
              stderr: "[killed: timeout]",
              exitCode: -9,
            },
          });
        }),
    });

    await nativeHandlers.teleport(
      { action: "teleport", device: "phone" },
      1,
      undefined,
      "1",
    );
    const res = await nativeHandlers.native_bash(
      { action: "native_bash", command: "logcat" },
      1,
      undefined,
      "1",
    );
    expect(res.ok).toBe(false);
    expect(res.text).toContain("some log lines"); // partial output survives
    expect(res.text).toContain("> /tmp/out.log 2>&1 &"); // self-correction hint
  });

  it("scopes teleport routing to the current chat", async () => {
    const service = freshMesh();
    setMeshService(service);
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["exec"],
    });
    const sentCmds: string[] = [];
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() => {
          sentCmds.push(String(cmd.params.cmd));
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
            data: {
              stdout: "remote\n__TALON_CWD__/sdcard__TALON_CWD_END__",
              stderr: "",
              exitCode: 0,
            },
          });
        }),
    });

    const tp = await nativeHandlers.teleport(
      { action: "teleport", device: "phone" },
      1,
      undefined,
      "1",
    );
    expect(tp.ok).toBe(true);

    const local = await nativeHandlers.native_bash(
      { action: "native_bash", command: "echo local-chat" },
      2,
      undefined,
      "2",
    );
    expect(local.ok).toBe(true);
    expect(local.text).toContain("[local] exit 0");
    expect(local.text).toContain("local-chat");
    expect(sentCmds).toHaveLength(0);

    const remote = await nativeHandlers.native_bash(
      { action: "native_bash", command: "echo remote-chat" },
      1,
      undefined,
      "1",
    );
    expect(remote.ok).toBe(true);
    expect(remote.text).toContain("[Pixel 9] exit 0");
    expect(sentCmds).toHaveLength(1);
  });

  it("teleported glob's find fallback matches only files, like rg --files", async () => {
    const service = freshMesh();
    setMeshService(service);
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["exec"],
    });
    const sentCmds: string[] = [];
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() => {
          sentCmds.push(String(cmd.params.cmd));
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
            data: { stdout: "", stderr: "", exitCode: 0 },
          });
        }),
    });
    await nativeHandlers.teleport(
      { action: "teleport", device: "phone" },
      1,
      undefined,
      "1",
    );
    await nativeHandlers.native_glob(
      { action: "native_glob", pattern: "*.apk", path: "/sdcard" },
      1,
      undefined,
      "1",
    );
    expect(sentCmds.length).toBe(1);
    // rg --files never lists directories; the find fallback must agree.
    expect(sentCmds[0]).toContain("-type f -name");
    expect(sentCmds[0]).toContain("rg --files");
  });

  it("refuses to teleport onto a device that lacks exec", async () => {
    const service = freshMesh();
    setMeshService(service);
    await service.register({
      id: "watch",
      name: "Pixel Watch",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["ring"],
    });
    const tp = await nativeHandlers.teleport(
      { action: "teleport", device: "watch" },
      1,
      undefined,
      "1",
    );
    expect(tp.ok).toBe(false);
    expect(tp.text).toContain('does not advertise the "exec"');
  });
});
