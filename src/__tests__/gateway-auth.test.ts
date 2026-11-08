/**
 * The local action gateway only serves Talon's own clients: every request
 * must name loopback on the bound port and carry no browser Origin, POSTs
 * must be JSON, and every route but /health needs the gateway token.
 * /health answers anonymously, but only with identity fields.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { request } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../core/plugin/index.js", () => ({
  handlePluginAction: vi.fn(async () => null),
}));

import { Gateway } from "../core/engine/gateway.js";
import {
  GATEWAY_TOKEN_ENV,
  gatewayToken,
  readGatewayToken,
  resetGatewayTokenCache,
} from "../core/engine/gateway-auth.js";
import { handleSharedAction } from "../core/engine/gateway-actions/index.js";
import { setNativeToolsEnabled } from "../core/engine/gateway-actions/native/index.js";
import { fetchGateway } from "../cli/daemon-api.js";
import { gatewayFetch, TEST_GATEWAY_TOKEN } from "./helpers/gateway-fetch.js";

let gateway: Gateway;
let port: number;
let base: string;

beforeAll(async () => {
  gateway = new Gateway();
  gateway.setFrontendHandler(async () => ({ ok: true, text: "handled" }));
  port = await gateway.start(0);
  base = `http://127.0.0.1:${port}`;
  gateway.setContext(4242);
});

afterAll(async () => {
  await gateway.stop();
});

/** Raw request with full control over Host / Origin / Content-Type. */
function raw(
  path: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: opts.method ?? "GET",
        headers: opts.headers,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const auth = { Authorization: `Bearer ${TEST_GATEWAY_TOKEN}` };
const actionBody = JSON.stringify({ action: "send_message", _chatId: "4242" });

describe("gateway token", () => {
  it("rejects /action without a token", async () => {
    const res = await fetch(`${base}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: actionBody,
    });
    expect(res.status).toBe(401);
  });

  it("rejects /action with a wrong token", async () => {
    const res = await fetch(`${base}/action`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer not-the-token",
      },
      body: actionBody,
    });
    expect(res.status).toBe(401);
  });

  it("accepts /action with the correct token", async () => {
    const res = await gatewayFetch(`${base}/action`, {
      method: "POST",
      body: actionBody,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, text: "handled" });
  });

  it("guards every other route too — reads, controls, and the MCP hub", async () => {
    for (const [method, path] of [
      ["GET", "/tasks"],
      ["GET", "/agents"],
      ["GET", "/events/recent"],
      ["POST", "/shutdown"],
      ["POST", "/plugins/reload"],
      ["POST", "/tasks/kill"],
      ["POST", "/mcp/talon/telegram/4242"],
      ["GET", "/no-such-route"],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method,
        ...(method === "POST"
          ? { headers: { "Content-Type": "application/json" }, body: "{}" }
          : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("gateway transport guard", () => {
  it("rejects a Host that is not loopback on the bound port", async () => {
    for (const host of [
      "evil.example",
      `evil.example:${port}`,
      "127.0.0.1",
      `127.0.0.1:${port + 1}`,
    ]) {
      const res = await raw("/tasks", { headers: { ...auth, Host: host } });
      expect(res.status, host).toBe(403);
    }
  });

  it("accepts every loopback spelling of the bound port", async () => {
    for (const host of [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ]) {
      const res = await raw("/tasks", { headers: { ...auth, Host: host } });
      expect(res.status, host).toBe(200);
    }
  });

  it("rejects any request carrying an Origin, even with the token", async () => {
    for (const origin of [
      "https://evil.example",
      "null",
      `http://127.0.0.1:${port}`,
    ]) {
      const res = await raw("/action", {
        method: "POST",
        headers: {
          ...auth,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: actionBody,
      });
      expect(res.status, origin).toBe(403);
    }
    const health = await raw("/health", {
      headers: { Origin: "https://evil.example" },
    });
    expect(health.status).toBe(403);
  });

  it("rejects POSTs that are not declared JSON", async () => {
    for (const type of [
      undefined,
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
    ]) {
      const res = await raw("/action", {
        method: "POST",
        headers: { ...auth, ...(type ? { "Content-Type": type } : {}) },
        body: actionBody,
      });
      expect(res.status, String(type)).toBe(415);
    }
    const ok = await raw("/action", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json; charset=utf-8" },
      body: actionBody,
    });
    expect(ok.status).toBe(200);
  });
});

describe("gateway /health", () => {
  it("answers without a token, with identity fields only", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["app", "mode", "ok", "pid", "port", "startedAt"].sort(),
    );
    expect(body).toMatchObject({ app: "talon", port });
  });

  it("adds the live counters for an authenticated caller", async () => {
    const res = await gatewayFetch(`${base}/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("uptime");
    expect(body).toHaveProperty("bridge");
    expect(body).toHaveProperty("sessions");
  });
});

describe("CLI gateway client", () => {
  it("fetchGateway authenticates with the provisioned token", async () => {
    const tasks = (await fetchGateway(port, "/tasks")) as { ok: boolean };
    expect(tasks.ok).toBe(true);
    // POSTs go out declared as JSON, which the gateway requires.
    const kill = (await fetchGateway(port, "/tasks/kill", {
      method: "POST",
      body: JSON.stringify({ id: 999_999 }),
    })) as { ok?: boolean };
    expect(kill).toBeTypeOf("object");
  });
});

describe("native actions", () => {
  it("are refused while native tools are disabled", async () => {
    setNativeToolsEnabled(false);
    const res = await handleSharedAction(
      { action: "native_bash", command: "echo should-not-run" },
      4242,
    );
    expect(res).toMatchObject({ ok: false });
    expect(res?.error).toMatch(/native tools are disabled/);
  });

  it("run once native tools are enabled", async () => {
    setNativeToolsEnabled(true);
    try {
      const res = await handleSharedAction(
        { action: "native_bash", command: "echo native-ok" },
        4242,
      );
      expect(res).toMatchObject({ ok: true });
      expect(res?.text).toContain("native-ok");
    } finally {
      setNativeToolsEnabled(false);
    }
  });
});

describe("token provisioning", () => {
  it("mints a 0600 key file once and reuses it across restarts", async () => {
    const home = mkdtempSync(join(tmpdir(), "talon-gw-token-"));
    const saved = process.env[GATEWAY_TOKEN_ENV];
    try {
      vi.resetModules();
      vi.doMock("../util/paths.js", () => ({
        dirs: { keys: join(home, "keys") },
      }));
      delete process.env[GATEWAY_TOKEN_ENV];
      const fresh = await import("../core/engine/gateway-auth.js");
      const first = fresh.gatewayToken();
      const path = fresh.gatewayTokenPath();
      expect(Buffer.from(first, "base64url").length).toBeGreaterThanOrEqual(32);
      expect(readFileSync(path, "utf-8").trim()).toBe(first);
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
      // Exported so children inherit it.
      expect(process.env[GATEWAY_TOKEN_ENV]).toBe(first);

      // A "restart": new process state, same file → same token.
      delete process.env[GATEWAY_TOKEN_ENV];
      fresh.resetGatewayTokenCache();
      expect(fresh.gatewayToken()).toBe(first);
      delete process.env[GATEWAY_TOKEN_ENV];
      expect(fresh.readGatewayToken()).toBe(first);
    } finally {
      vi.doUnmock("../util/paths.js");
      vi.resetModules();
      process.env[GATEWAY_TOKEN_ENV] = saved;
      resetGatewayTokenCache();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("clients read the token without minting one", () => {
    expect(readGatewayToken()).toBe(TEST_GATEWAY_TOKEN);
    expect(gatewayToken()).toBe(TEST_GATEWAY_TOKEN);
  });
});
