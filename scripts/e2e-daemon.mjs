#!/usr/bin/env node
/**
 * End-to-end smoke of a real daemon process: boot from source with a
 * throwaway TALON_HOME (native bridge on localhost, stub Claude binary, no
 * external frontends), check bridge auth, drive a scripted device through
 * credential upgrade, registration, device_exec and streamed file transfer,
 * pair a second device from a one-time link, restart, check it all again.
 * A sub-agent spawned before the restart must resume after it and report.
 * The device answers commands itself, so this covers the daemon's half of the
 * protocol, not talon-node's executor.
 * Any failed step exits non-zero. The daemon log is left at $E2E_LOG.
 *
 * Refuses to run where a daemon already holds the gateway port: the
 * single-daemon guard would stop the boot anyway, and this is a CI job.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  existsSync,
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
const LYING_PATH = "/e2e/lies-about-its-digest.bin";
const AGENT_CHAT = 777;
const AGENT_LABEL = "e2e-resume";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = mkdtempSync(join(tmpdir(), "talon-e2e-"));
const home = join(root, "talon");
const log = process.env.E2E_LOG ?? join(root, "daemon.log");
const stubScript = join(root, "stub-script.json");
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
    capabilities: ["status", "exec", "upload_file", "download_file"],
  });
  expectStatus(`${label}: register as itself`, res.status, 200);
}

/** Do a command's transfer over HTTP; returns the data for its result. */
async function runTransfer(event, token, disk, used) {
  const { token: transfer, path, sha256: expected } = event.params;
  const url = `${BASE}/devices/file?deviceId=${DEVICE}&transfer=${transfer}`;
  const headers = { Authorization: `Bearer ${token}` };
  used.push({ name: event.name, url, headers });
  if (event.name === "download_file") {
    const res = await fetch(url, { headers });
    if (!res.ok) fail("device download", `HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (expected && expected !== sha256(bytes)) {
      fail("device download", "bytes differ from the announced sha256");
    }
    disk.set(path, bytes);
    return { bytesWritten: bytes.length, sha256: sha256(bytes) };
  }
  const bytes = disk.get(path);
  const res = await fetch(url, { method: "POST", headers, body: bytes });
  if (!res.ok) fail("device upload", `HTTP ${res.status}`);
  return { sha256: path === LYING_PATH ? "0".repeat(64) : sha256(bytes) };
}

/**
 * Hold the device's event stream open, doing each file transfer against
 * `disk` and answering any other command with its cmd.
 */
async function connectDevice(token, disk = new Map(), used = []) {
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
        const data = ["upload_file", "download_file"].includes(event.name)
          ? await runTransfer(event, token, disk, used)
          : { exitCode: 0, stdout: event.params.cmd, stderr: "" };
        await post("/devices/command-result", token, {
          commandId: event.id,
          deviceId: DEVICE,
          ok: true,
          data,
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

/** A transfer token is good for one request. */
async function checkSpent(label, { name, url, headers }, want) {
  const res = await (name === "download_file"
    ? fetch(url, { headers })
    : fetch(url, { method: "POST", headers, body: "replay" }));
  expectStatus(`${label}: replay ${name} token`, res.status, want);
}

async function checkFiles(label, token) {
  const disk = new Map();
  const used = [];
  const disconnect = await connectDevice(token, disk, used);
  const workspace = join(home, "workspace");
  mkdirSync(workspace, { recursive: true });
  // Bigger than a stream chunk, so a truncated copy can't pass.
  const pushed = randomBytes(300_000);
  writeFileSync(join(workspace, "e2e-push.bin"), pushed);
  const push = await action({
    action: "device_push_file",
    device: DEVICE,
    local_path: "e2e-push.bin",
    remote_path: "/e2e/pushed.bin",
  });
  if (!push.ok) fail(`${label}: push`, JSON.stringify(push));
  if (sha256(disk.get("/e2e/pushed.bin") ?? "") !== sha256(pushed)) {
    fail(`${label}: push`, "device holds different bytes");
  }
  console.log(`ok ${label}: device_push_file bytes match`);
  await checkSpent(label, used.at(-1), 404);

  const held = randomBytes(300_000);
  disk.set("/e2e/held.bin", held);
  const pull = await action({
    action: "device_pull_file",
    device: DEVICE,
    remote_path: "/e2e/held.bin",
    local_path: "e2e-pull.bin",
  });
  if (!pull.ok) fail(`${label}: pull`, JSON.stringify(pull));
  const landed = readFileSync(join(workspace, "e2e-pull.bin"));
  if (sha256(landed) !== sha256(held)) {
    fail(`${label}: pull`, "daemon holds different bytes");
  }
  console.log(`ok ${label}: device_pull_file bytes match`);
  await checkSpent(label, used.at(-1), 409);

  disk.set(LYING_PATH, randomBytes(1000));
  const lied = await action({
    action: "device_pull_file",
    device: DEVICE,
    remote_path: LYING_PATH,
    local_path: "e2e-lied.bin",
  });
  if (lied.ok || existsSync(join(workspace, "e2e-lied.bin"))) {
    fail(`${label}: wrong digest`, JSON.stringify(lied));
  }
  console.log(`ok ${label}: pull with a wrong digest refused and discarded`);
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
  await checkFiles(label, token);
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
    appVersion: "0.0.0-e2e",
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
    env: {
      ...process.env,
      TALON_HOME: home,
      HOME: root,
      STUB_CLAUDE_SCRIPT: stubScript,
      STUB_CLAUDE_TIMEOUT_MS: "600000",
    },
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

/** Ask about an agent as the chat that spawned it. */
async function agentStatus(id) {
  const status = await action({
    action: "agent_status",
    agent_id: id,
    chat_id: AGENT_CHAT,
    _chatId: String(AGENT_CHAT),
  });
  if (!status.ok) fail("agent_status", JSON.stringify(status));
  return String(status.text);
}

/** Spawn an agent whose run stays open: the stub's turn never finishes. */
async function spawnHeldAgent() {
  writeFileSync(stubScript, JSON.stringify({ turns: [{ emit: [] }] }));
  const spawned = await action({
    action: "spawn_agent",
    brief: "e2e: stay running across a daemon restart",
    label: AGENT_LABEL,
    force: true,
    chat_id: AGENT_CHAT,
    _chatId: String(AGENT_CHAT),
  });
  if (!spawned.ok) fail("spawn_agent", JSON.stringify(spawned));
  const id = /\(id: ([^)]+)\)/.exec(String(spawned.text))?.[1];
  if (!id) fail("spawn_agent", `no id in ${spawned.text}`);
  // Long enough for the stub's init to give the run a session id to resume.
  await new Promise((r) => setTimeout(r, 5000));
  const status = await agentStatus(id);
  if (!status.includes("State: running")) fail("held agent", status);
  console.log(`ok agent ${id} running before the restart`);
  return id;
}

/** From now on the stub reports a nonce through the real MCP tool. */
function scriptAgentReport(nonce) {
  writeFileSync(
    stubScript,
    JSON.stringify({
      dispatchMcp: true,
      turns: [
        {
          emit: [
            {
              type: "assistant",
              message: {
                content: [
                  {
                    type: "tool_use",
                    id: "toolu_e2e_report",
                    name: "mcp__native-tools__report_result",
                    input: { summary: nonce },
                  },
                ],
              },
            },
            { type: "result", result: "reported" },
          ],
        },
      ],
    }),
  );
}

/** The same agent must come back by itself and deliver the nonce. */
async function checkAgentResumed(id, nonce) {
  const deadline = Date.now() + 90_000;
  let status = "";
  while (Date.now() < deadline) {
    status = await agentStatus(id);
    if (!status.includes("State: running") && !status.includes("State: queued"))
      break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!status.includes("State: done") || !status.includes(nonce)) {
    fail("agent resume", status);
  }
  const resumed = readFileSync(log, "utf8")
    .split("\n")
    .find(
      (line) =>
        line.includes(id) && line.includes("resuming after restart (session"),
    );
  if (!resumed) fail("agent resume", "no session resume in the daemon log");
  console.log(`ok agent ${id} resumed its session and reported`);
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

writeFileSync(stubScript, JSON.stringify({ turns: [] }));
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
const agentId = await spawnHeldAgent();
const agentNonce = randomBytes(8).toString("hex");
await stop();
scriptAgentReport(agentNonce);
boot();
await checkBridge("after restart");
await checkDevice("after restart", deviceToken);
await checkPaired("after restart", pairedToken);
await checkAgentResumed(agentId, agentNonce);
await stop();
console.log("e2e-daemon passed");
process.exit(0);
