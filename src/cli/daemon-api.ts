/**
 * Shared CLI access to the running daemon's gateway (127.0.0.1 JSON
 * endpoints: /tasks, /events/recent, …). Discovery finds the instance the
 * same way `talon status` does; commands render, this module only fetches.
 */

import pc from "picocolors";
import { findRunningInstance } from "../core/daemon/discovery.js";
import {
  gatewayAuthHeaders,
  gatewayTokenPath,
  readGatewayToken,
} from "../core/engine/gateway-auth.js";

const REQUEST_TIMEOUT_MS = 3_000;

/**
 * Call a gateway endpoint as the operator: every request carries the gateway
 * token (read from ~/.talon/keys/gateway-token), and a POST always declares a
 * JSON body — the gateway refuses anything else.
 */
export async function fetchGateway(
  port: number,
  path: string,
  init?: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const isPost = init?.method === "POST";
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    ...(isPost && init?.body === undefined ? { body: "{}" } : {}),
    headers: {
      ...(isPost ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers as Record<string, string> | undefined),
      ...gatewayAuthHeaders(readGatewayToken()),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401) {
    throw new Error(
      `gateway refused the request (401) — is ${gatewayTokenPath()} readable by this user?`,
    );
  }
  if (!response.ok) throw new Error(`gateway answered ${response.status}`);
  return response.json();
}

/** Find the daemon and return its gateway port, or render why not. */
export async function requireGatewayPort(): Promise<number | null> {
  const instance = await findRunningInstance();
  if (!instance) {
    console.log(`  ${pc.red("●")} Talon is not running\n`);
    return null;
  }
  if (!instance.port) {
    console.log(
      `  ${pc.yellow("●")} Talon is running (PID ${instance.pid}) but its gateway port is unknown — possibly still starting.\n`,
    );
    return null;
  }
  return instance.port;
}
