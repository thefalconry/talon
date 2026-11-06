#!/usr/bin/env node
/**
 * End-to-end smoke of a real daemon process: boot from source with a
 * throwaway TALON_HOME (native bridge on localhost, stub Claude binary, no
 * external frontends), check bridge auth, drive a scripted device through
 * credential upgrade, registration and device_exec, pair a second device from
 * a one-time link, restart, check it all again.
 * The device answers commands itself, so this covers the daemon's half of the
 * protocol, not talon-node's executor.
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
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 19899;
const TOKEN = "e2e-throwaway-token-not-a-secret-0000000000000";
const BASE = `http://127.0.0.1:${PORT}`;
const GATEWAY = "http://127.0.0.1:19876";
const DEVICE = "e2e-device";
const PAIRED = "e2e-paired";
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

async function post(path, token, body) {
  return fetch(BASE + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

function expectStatus(step, got, want) {
  if (got !== want) fail(step, `got ${got}, want ${want}`);
  console.log(`ok ${step} -> ${got}`);
}

/** Call an agent tool's action the way the MCP tool server does. */
async function action(body) {
  const token = readFileSync(
    join(home, "keys", "gateway-token"),
    "utf8",
  ).trim();
  const res = await fetch(`${GATEWAY}/action`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) fail(`action ${body.action}`, `HTTP ${res.status}`);
  return res.json();
}

async function registerDevice(label, token) {
  const res = await post("/devices/register", token, {
    id: DEVICE,
    name: DEVICE,
    platform: "linux",
    arch: "amd64",
    appVersion: "0.0.0-e2e",
    capabilities: ["status", "exec"],
  });
  expectStatus(`${label}: register as itself`, res.status, 200);
}

/** Hold the device's event stream open, answering each exec with its cmd. */
async function connectDevice(token) {
  const abort = new AbortController();
  const res = await fetch(`${BASE}/events?deviceId=${DEVICE}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: abort.signal,
  });
  if (!res.ok) fail("device stream", `HTTP ${res.status}`);
  const done = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop();
      for (const frame of frames) {
        if (!frame.startsWith("data: ")) continue;
        const event = JSON.parse(frame.slice(6));
        if (event.kind !== "device_command") continue;
        await post("/devices/command-result", token, {
          commandId: event.id,
          deviceId: DEVICE,
          ok: true,
          data: { exitCode: 0, stdout: event.params.cmd, stderr: "" },
        });
      }
    }
  })().catch(() => {});
  return async () => {
    abort.abort();
    await done;
  };
}

async function checkExec(label, token) {
  const disconnect = await connectDevice(token);
  const nonce = `nonce-${label.replace(/\W/g, "")}-${Date.now()}`;
  const ran = await action({
    action: "device_exec",
    device: DEVICE,
    cmd: nonce,
    timeout_sec: 20,
  });
  if (!ran.ok || !String(ran.text).includes(nonce)) {
    fail(`${label}: device_exec`, JSON.stringify(ran));
  }
  console.log(`ok ${label}: device_exec round trip`);
  await disconnect();
}

async function checkDevice(label, token) {
  await registerDevice(label, token);
  const other = await post("/devices/register", token, {
    id: "someone-else",
    name: "x",
    platform: "linux",
  });
  expectStatus(`${label}: register as another device`, other.status, 403);
  const fleet = await get("/devices", token);
  expectStatus(`${label}: device token on /devices`, fleet.status, 403);
  const listed = await (await get("/devices", TOKEN)).json();
  if (!JSON.stringify(listed).includes(DEVICE)) {
    fail(`${label}: fleet`, JSON.stringify(listed));
  }
  console.log(`ok ${label}: device in fleet`);
  await checkExec(label, token);
}

/**
 * Pair the way a phone does: an agent mints a link, the holder of the link
 * collects the credential with no bearer token, and the link is then spent.
 */
async function pairDevice() {
  const minted = await action({
    action: "make_companion_pair_link",
    bridge_url: BASE,
    label: "e2e",
  });
  const grant = /\/pair\?grant=([\w-]+)/.exec(String(minted.text))?.[1];
  if (!minted.ok || !grant) fail("mint pair link", JSON.stringify(minted));
  console.log("ok pair: link minted");
  const bogus = await get("/pair?grant=not-a-grant&format=json");
  expectStatus("pair: unknown grant", bogus.status, 404);
  const claimed = await get(`/pair?grant=${grant}&format=json`);
  expectStatus("pair: claim grant without a bearer token", claimed.status, 200);
  const payload = await claimed.json();
  if (payload.url !== BASE || !payload.token || payload.token === TOKEN) {
    fail("pair: payload", `url ${payload.url}, own token ${!!payload.token}`);
  }
  const again = await get(`/pair?grant=${grant}&format=json`);
  expectStatus("pair: second claim of the same grant", again.status, 404);
  return payload.token;
}

/** The paired credential binds to the first device that registers with it. */
async function checkPaired(label, token) {
  const self = await post("/devices/register", token, {
    id: PAIRED,
    name: PAIRED,
    platform: "android",
    capabilities: ["status"],
  });
  expectStatus(`${label}: paired device registers`, self.status, 200);
  const other = await post("/devices/register", token, {
    id: DEVICE,
    name: "x",
    platform: "android",
  });
  expectStatus(`${label}: paired token as another device`, other.status, 403);
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
const upgrade = await post("/auth/upgrade", TOKEN, {
  deviceId: DEVICE,
  client: "node",
});
expectStatus("upgrade shared token", upgrade.status, 200);
const { token: deviceToken } = await upgrade.json();
if (!deviceToken || deviceToken === TOKEN) fail("upgrade", "no new token");
await checkDevice("first boot", deviceToken);
const pairedToken = await pairDevice();
await checkPaired("first boot", pairedToken);
await stop();
boot();
await checkBridge("after restart");
await checkDevice("after restart", deviceToken);
await checkPaired("after restart", pairedToken);
await stop();
console.log("e2e-daemon passed");
process.exit(0);
