/**
 * Secret drop: the store (mode 600, atomic, no traversal), the grants
 * (expiry, single use, GET doesn't spend), the service (receipt, https
 * only) and the bridge routes on the wire — and, throughout, that the
 * value never reaches a log line, a receipt or a response.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logged: string[] = [];
vi.mock("../util/log.js", () => {
  const capture = (...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(" "));
  };
  return {
    log: vi.fn(capture),
    logError: vi.fn(capture),
    logWarn: vi.fn(capture),
    logDebug: vi.fn(capture),
  };
});

import {
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  secretNameProblem,
  secretPath,
  writeSecret,
} from "../core/secrets/store.js";
import { SECRET_GRANT_TTL_MS, SecretDropStore } from "../core/secrets/drop.js";
import {
  openSecretDropForm,
  requestSecretDrop,
  secretCommandReply,
  setSecretDropDeps,
  submitSecretDrop,
  type SecretDropDeps,
} from "../core/secrets/service.js";
import {
  BridgeServer,
  type BridgeServerHandlers,
} from "../frontend/native/bridge/server.js";
import {
  isLiveSecretDrop,
  openSecretDropForm as openForm,
  submitSecretDrop as submit,
} from "../core/secrets/index.js";

const VALUE = "hunter2-Sup3r$ecret!";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "secret-drop-"));
  logged.length = 0;
});

describe("secret store", () => {
  it("writes mode 600 into a 700 folder and leaves no temp file", async () => {
    const root = join(dir, "secrets");
    const res = await writeSecret("gmail-pw", `${VALUE}\n`, root);
    expect(res.ok).toBe(true);
    expect(await readFile(join(root, "gmail-pw"), "utf8")).toBe(VALUE);
    if (process.platform !== "win32") {
      expect((await stat(join(root, "gmail-pw"))).mode & 0o777).toBe(0o600);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
    }
    expect(await readdir(root)).toEqual(["gmail-pw"]);
  });

  it("replaces an existing value atomically", async () => {
    await writeSecret("k", "old", dir);
    await writeSecret("k", "new", dir);
    expect(await readFile(join(dir, "k"), "utf8")).toBe("new");
  });

  it("replaces a symlink at the target, not what it points to", async () => {
    if (process.platform === "win32") return;
    const outside = join(dir, "outside.txt");
    await writeFile(outside, "untouched");
    const root = join(dir, "s");
    await writeSecret("seed", "x", root);
    await symlink(outside, join(root, "link"));
    await writeSecret("link", VALUE, root);
    expect(await readFile(outside, "utf8")).toBe("untouched");
    expect(await readFile(join(root, "link"), "utf8")).toBe(VALUE);
  });

  it.each([
    "../escape",
    "a/b",
    "a\\b",
    "..",
    ".hidden",
    "a..b",
    "",
    "-leading-dash",
    "x".repeat(65),
    "name with space",
    "/etc/passwd",
    "na\u0000me",
  ])("refuses the name %j", async (name) => {
    expect(secretNameProblem(name)).toBeDefined();
    expect(secretPath(name, dir).ok).toBe(false);
    const res = await writeSecret(name, VALUE, dir);
    expect(res.ok).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  it.each(["gmail-pw", "API_KEY", "a", "v1.2", "x".repeat(64)])(
    "accepts the name %j",
    (name) => {
      expect(secretNameProblem(name)).toBeUndefined();
    },
  );

  it("refuses an empty value", async () => {
    expect((await writeSecret("k", "\n", dir)).ok).toBe(false);
  });
});

describe("drop grants", () => {
  const grant = { name: "k", chatKey: "123", frontend: "telegram" };

  it("expires unused grants after the TTL", () => {
    let now = 1_000_000;
    const store = new SecretDropStore(SECRET_GRANT_TTL_MS, () => now);
    const g = store.create(grant);
    now += SECRET_GRANT_TTL_MS - 1;
    expect(store.peek(g.token)).not.toBeNull();
    now += 1;
    expect(store.peek(g.token)).toBeNull();
    expect(store.consume(g.token)).toBeNull();
  });

  it("is single use, and peeking does not spend it", () => {
    const store = new SecretDropStore();
    const g = store.create(grant);
    expect(store.peek(g.token)).not.toBeNull();
    expect(store.peek(g.token)).not.toBeNull();
    expect(store.consume(g.token)?.name).toBe("k");
    expect(store.consume(g.token)).toBeNull();
    expect(store.peek(g.token)).toBeNull();
  });

  it("mints unguessable, distinct tokens", () => {
    const store = new SecretDropStore();
    const a = store.create(grant).token;
    const b = store.create(grant).token;
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

describe("secret drop service", () => {
  let prev: SecretDropDeps;
  const notify = vi.fn(async () => {});

  beforeEach(() => {
    notify.mockClear();
    prev = setSecretDropDeps({
      store: new SecretDropStore(),
      baseUrl: () => ({ ok: true, url: "https://talon.example:19880" }),
      write: (name, value) => writeSecret(name, value, dir),
      notify,
    });
  });
  afterEach(() => {
    setSecretDropDeps(prev);
  });

  function mint(name = "gmail-pw"): string {
    const minted = requestSecretDrop({
      name,
      purpose: "<b>Gmail</b>",
      chatKey: "42",
    });
    if (!minted.ok) throw new Error(minted.text);
    return new URL(minted.link).searchParams.get("grant")!;
  }

  it("mints an https link and infers the frontend from the chat key", () => {
    const minted = requestSecretDrop({ name: "k", chatKey: "d_1_abc" });
    expect(minted.ok).toBe(true);
    if (minted.ok) {
      expect(minted.link).toMatch(
        /^https:\/\/talon\.example:19880\/secret\?grant=/,
      );
    }
  });

  it("refuses a plain-http bridge and a bad name", () => {
    setSecretDropDeps({
      baseUrl: () => ({ ok: true, url: "http://10.0.0.5:19880" }),
    });
    expect(requestSecretDrop({ name: "k", chatKey: "42" }).ok).toBe(false);
    setSecretDropDeps({
      baseUrl: () => ({ ok: true, url: "https://x" }),
    });
    expect(requestSecretDrop({ name: "../k", chatKey: "42" }).ok).toBe(false);
  });

  it("serves an escaped form without spending the grant", () => {
    const token = mint();
    const form = openSecretDropForm(token)!;
    expect(form).toContain("gmail-pw");
    expect(form).toContain("&lt;b&gt;Gmail&lt;/b&gt;");
    expect(form).not.toContain("<b>Gmail</b>");
    expect(openSecretDropForm(token)).not.toBeNull();
  });

  it("stores the value, sends the receipt, and burns the link", async () => {
    const token = mint();
    const res = await submitSecretDrop(
      token,
      new URLSearchParams({ value: VALUE }).toString(),
      "application/x-www-form-urlencoded",
    );
    expect(res.status).toBe(200);
    expect(await readFile(join(dir, "gmail-pw"), "utf8")).toBe(VALUE);
    expect(notify).toHaveBeenCalledWith(
      "telegram",
      "42",
      "stored ✓ as gmail-pw",
    );
    const again = await submitSecretDrop(token, "value=other", undefined);
    expect(again.status).toBe(404);
    expect(await readFile(join(dir, "gmail-pw"), "utf8")).toBe(VALUE);
  });

  it("never logs, echoes or returns the value", async () => {
    const token = mint();
    const res = await submitSecretDrop(
      token,
      `value=${encodeURIComponent(VALUE)}`,
      "application/x-www-form-urlencoded",
    );
    expect(res.html).not.toContain(VALUE);
    expect(JSON.stringify(notify.mock.calls)).not.toContain(VALUE);
    expect(logged.join("\n")).not.toContain(VALUE);
    expect(logged.join("\n")).not.toContain(token);
  });

  it("spends the grant even when the write fails", async () => {
    setSecretDropDeps({
      write: async () => ({
        ok: false,
        error: "Could not write the secret (EACCES)",
      }),
    });
    const token = mint();
    const res = await submitSecretDrop(
      token,
      `value=${VALUE}`,
      "application/x-www-form-urlencoded",
    );
    expect(res.status).toBe(500);
    expect(res.html).not.toContain(VALUE);
    expect(openSecretDropForm(token)).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    expect(logged.join("\n")).not.toContain(VALUE);
  });

  it("/secret: operator only, DMs only, usage without a name", () => {
    const base = { chatKey: "42", frontend: "telegram" };
    expect(
      secretCommandReply({
        ...base,
        arg: "k",
        isOperator: false,
        isGroup: false,
      }),
    ).toMatch(/Only the operator/);
    expect(
      secretCommandReply({
        ...base,
        arg: "k",
        isOperator: true,
        isGroup: true,
      }),
    ).toMatch(/private chat/);
    expect(
      secretCommandReply({
        ...base,
        arg: "",
        isOperator: true,
        isGroup: false,
      }),
    ).toMatch(/^Usage: \/secret/);
    expect(
      secretCommandReply({
        ...base,
        arg: "k for gmail",
        isOperator: true,
        isGroup: false,
      }),
    ).toMatch(/secret\?grant=/);
  });
});

describe("bridge /secret routes", () => {
  let prev: SecretDropDeps;
  let server: BridgeServer | undefined;
  const notify = vi.fn(async () => {});

  beforeEach(() => {
    prev = setSecretDropDeps({
      store: new SecretDropStore(),
      baseUrl: () => ({ ok: true, url: "https://bridge" }),
      write: (name, value) => writeSecret(name, value, dir),
      notify,
    });
  });
  afterEach(async () => {
    setSecretDropDeps(prev);
    await server?.stop();
    server = undefined;
  });

  async function start(): Promise<string> {
    const handlers = new Proxy(
      {
        openSecretDrop: (t: string) => openForm(t),
        isLiveSecretDrop: (t: string) => isLiveSecretDrop(t),
        submitSecretDrop: (t: string, b: string, c?: string) => submit(t, b, c),
      } as Record<string, unknown>,
      { get: (t, k) => (k in t ? t[k as string] : () => null) },
    ) as unknown as BridgeServerHandlers;
    server = new BridgeServer(
      { host: "127.0.0.1", port: 0, token: "t".repeat(40), startedAt: "boot" },
      handlers,
    );
    await server.start();
    return `http://127.0.0.1:${server.getPort()}`;
  }

  function grantToken(): string {
    const minted = requestSecretDrop({ name: "wire", chatKey: "7" });
    if (!minted.ok) throw new Error(minted.text);
    return new URL(minted.link).searchParams.get("grant")!;
  }

  it("serves the form pre-auth, takes one same-origin POST, then 404s", async () => {
    const base = await start();
    const token = grantToken();
    const get = await fetch(`${base}/secret?grant=${token}`);
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(get.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    const host = new URL(base).host;
    const post = await fetch(`${base}/secret?grant=${token}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: `http://${host}`,
      },
      body: new URLSearchParams({ value: VALUE }).toString(),
    });
    expect(post.status).toBe(200);
    expect(await post.text()).not.toContain(VALUE);
    expect(await readFile(join(dir, "wire"), "utf8")).toBe(VALUE);
    const replay = await fetch(`${base}/secret?grant=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "value=again",
    });
    expect(replay.status).toBe(404);
    expect((await fetch(`${base}/secret?grant=${token}`)).status).toBe(404);
    expect(logged.join("\n")).not.toContain(VALUE);
  });

  it("refuses a foreign Origin and an unknown grant", async () => {
    const base = await start();
    const token = grantToken();
    const foreign = await fetch(`${base}/secret?grant=${token}`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
      body: "value=x",
    });
    expect(foreign.status).toBe(403);
    expect(isLiveSecretDrop(token)).toBe(true);
    const unknown = await fetch(`${base}/secret?grant=nope`, {
      method: "POST",
      body: "value=x",
    });
    expect(unknown.status).toBe(404);
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps same-origin refused on every other route", async () => {
    const base = await start();
    const host = new URL(base).host;
    const res = await fetch(`${base}/health`, {
      headers: { Origin: `http://${host}` },
    });
    expect(res.status).toBe(403);
  });
});
