/**
 * `fetch` for suites that talk to a live gateway: adds the gateway bearer
 * token (the fixed value test-db.ts exports) and, for POSTs, the JSON
 * content type the gateway requires — so each test states only what it
 * is actually about.
 */
export const TEST_GATEWAY_TOKEN = "vitest-gateway-token";

export function gatewayFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) {
    headers.set("Authorization", `Bearer ${TEST_GATEWAY_TOKEN}`);
  }
  if (init.method === "POST" && !headers.has("content-type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...init, headers });
}
