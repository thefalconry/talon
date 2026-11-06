#!/usr/bin/env node
/**
 * End-to-end smoke of a real daemon process: boot from source with a
 * throwaway TALON_HOME (native bridge on localhost, stub Claude binary, no
 * external frontends), check bridge auth, restart it, check it again.
 * Any failed step exits non-zero. The daemon log is left at $E2E_LOG.
 *
 * Refuses to run where a daemon already holds the gateway port: the
 * single-daemon guard would stop the boot anyway, and this is a CI job.
 */
import { spawn } from "node:child_process";
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 19899;
const TOKEN = "e2e-throwaway-token-not-a-secret-0000000000000";
const BASE = `http://127.0.0.1:${PORT}`;
const root = mkdtempSync(join(tmpdir(), "talon-e2e-"));
const home = join(root, "talon");
const log = process.env.E2E_LOG ?? join(root, "daemon.log");
let child = null;

function fail(step, detail) {
  console.error(`FAIL ${step}: ${detail}\ndaemon log: ${log}`);
  child?.kill("SIGKILL");
  process.exit(1);
}

async function get(path, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return fetch(BASE + path, { headers, signal: AbortSignal.timeout(3000) });
}

async function gatewayTaken() {
  try {
    await fetch("http://127.0.0.1:19876/health", {
      signal: AbortSignal.timeout(1000),
    });
    return true;
  } catch {
    return false;
  }
}

function boot() {
  const out = createWriteStream(log, { flags: "a" });
  child = spawn("npx", ["tsx", "src/index.ts"], {
    env: { ...process.env, TALON_HOME: home, HOME: root },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const started = child;
  started.on("exit", (code, signal) => {
    if (child === started) fail("daemon", `exited (${code ?? signal})`);
  });
}

async function waitHealthy() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await get("/health");
      if (res.ok) return await res.json();
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail("health", "bridge did not answer within 120 s");
}

async function stop() {
  const stopping = child;
  child = null;
  const exited = new Promise((r) => stopping.once("exit", r));
  process.kill(-stopping.pid, "SIGTERM");
  const timer = setTimeout(
    () => process.kill(-stopping.pid, "SIGKILL"),
    30_000,
  );
  await exited;
  clearTimeout(timer);
}

async function checkBridge(label) {
  const health = await waitHealthy();
  if (health.app !== "talon-bridge" || health.authRequired !== true) {
    fail(`${label} health`, JSON.stringify(health));
  }
  for (const [name, token, want] of [
    ["no token", undefined, 401],
    ["wrong token", "wrong", 401],
    ["operator token", TOKEN, 200],
  ]) {
    const { status } = await get("/devices", token);
    if (status !== want)
      fail(`${label} ${name}`, `got ${status}, want ${want}`);
    console.log(`ok ${label}: /devices with ${name} -> ${status}`);
  }
}

if (await gatewayTaken()) {
  console.error("a daemon already answers on :19876; run this in CI only");
  process.exit(2);
}
mkdirSync(home, { recursive: true });
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({
    frontend: ["native"],
    backend: "claude",
    claudeBinary: resolve(
      "src/__tests__/integration/stub-claude/fake-claude.mjs",
    ),
    pulse: false,
    dream: false,
    heartbeat: false,
    native: { host: "127.0.0.1", port: PORT, token: TOKEN },
  }),
);

boot();
await checkBridge("first boot");
await stop();
boot();
await checkBridge("after restart");
await stop();
console.log("e2e-daemon passed");
process.exit(0);
