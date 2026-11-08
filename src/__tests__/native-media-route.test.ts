/**
 * `GET /media` and the bridge's request-body parser, over the wire.
 *
 * The media route is how a client fetches an image the agent sent: history
 * rows keep only a short media id, and the daemon resolves it to a path it
 * minted itself, so a bad or stale id must 404 rather than leak anything
 * about the filesystem. The server is a real `BridgeServer` bound to the
 * production handler table, so the id really does travel through
 * `runtime.media`.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

// Pass-through, so a test can reach the read stream the route opened.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

import { createReadStream, type ReadStream } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBridgeHandlers } from "../frontend/native/surface/handlers.js";
import { registerMedia } from "../frontend/native/media/media.js";
import { BridgeServer } from "../frontend/native/bridge/server.js";
import { makeNativeHarness } from "./helpers/native-bridge.js";

const TOKEN = "media-route-secret";
const auth = { Authorization: `Bearer ${TOKEN}` };

let server: BridgeServer;
let port: number;
let dir: string;
let harness: ReturnType<typeof makeNativeHarness>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "talon-media-route-"));
  harness = makeNativeHarness();
  server = new BridgeServer(
    { host: "127.0.0.1", port: 0, token: TOKEN, startedAt: "boot" },
    buildBridgeHandlers(harness.runtime),
  );
  port = await server.start();
});

afterAll(async () => {
  await server.stop();
});

function get(path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { headers: auth });
}

describe("GET /media", () => {
  it("streams a registered image with its own content type", async () => {
    const path = join(dir, "shot.png");
    await writeFile(path, Buffer.from([1, 2, 3, 4]));
    const id = registerMedia(harness.runtime, path);

    const res = await get(`/media?id=${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
  });

  it("keeps the bytes private to the client that fetched them", async () => {
    const path = join(dir, "cached.png");
    await writeFile(path, "x");
    const id = registerMedia(harness.runtime, path);

    const res = await get(`/media?id=${id}`);
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
  });

  it("404s an id this daemon run never minted", async () => {
    const res = await get("/media?id=not-a-real-id");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "No such media" });
  });

  it("404s when no id is given at all", async () => {
    expect((await get("/media")).status).toBe(404);
  });

  it("404s an id that resolves to a directory rather than a file", async () => {
    const id = registerMedia(harness.runtime, dir);
    expect((await get(`/media?id=${id}`)).status).toBe(404);
  });

  it("closes the file when the client hangs up mid-download", async () => {
    const path = join(dir, "large.png");
    await writeFile(path, Buffer.alloc(16 * 1024 * 1024));
    const id = registerMedia(harness.runtime, path);
    vi.mocked(createReadStream).mockClear();

    const sock = connect(port, "127.0.0.1");
    sock.on("error", () => {});
    await new Promise<void>((resolve) => sock.once("connect", resolve));
    sock.write(
      `GET /media?id=${id} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
        `Authorization: Bearer ${TOKEN}\r\n\r\n`,
    );
    await new Promise<void>((resolve) => sock.once("data", () => resolve()));
    sock.destroy();

    const stream = vi.mocked(createReadStream).mock.results[0]!
      .value as ReadStream;
    await vi.waitFor(() => expect(stream.destroyed).toBe(true), {
      timeout: 2_000,
    });
  });

  it("404s an id whose file has since been deleted", async () => {
    const id = registerMedia(harness.runtime, join(dir, "vanished.png"));
    expect((await get(`/media?id=${id}`)).status).toBe(404);
  });
});

describe("bridge request bodies", () => {
  it("treats a request with no body as an empty object", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/chats`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ chat: { title: "New chat" } });
  });

  it("treats a whitespace-only body as an empty object", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/chats`, {
      method: "POST",
      headers: auth,
      body: "   ",
    });
    expect(res.status).toBe(200);
  });

  it("refuses a body that is not a JSON object", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/chats`, {
      method: "POST",
      headers: auth,
      body: "[1,2,3]",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: "Body must be a JSON object",
    });
  });
});
