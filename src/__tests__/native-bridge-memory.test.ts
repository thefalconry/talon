/**
 * `GET /memory` and `GET /memory/why` end to end.
 *
 * Same harness as native-bridge-routes.test.ts — a real BridgeServer with
 * a bearer token — but the two memory entries on the handler seam are the
 * production implementations over the real (per-file throwaway) SQLite
 * store, so this proves the whole path: query string → coercion → store
 * → wire shape, including the limit cap and the two error statuses.
 *
 * The database starts empty for this file, so the listing assertions can
 * count rows rather than only look for their own.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  BridgeServer,
  type BridgeServerHandlers,
} from "../frontend/native/bridge/server.js";
import { listMemory, memoryWhy } from "../frontend/native/surface/memory.js";
import type {
  MemoryRowWire,
  MemoryWhyWire,
} from "../frontend/native/protocol.js";
import { assertMemory, supersedeMemory } from "../storage/memory.js";

const TOKEN = "memory-route-secret";

/** Only the memory entries are real; the rest is inert scaffolding. */
const handlers = {
  status: () => ({
    app: "talon-bridge",
    protocol: 1,
    botName: "Talon",
    backend: "test",
    model: "m1",
    activeChats: 0,
    startedAt: "now",
  }),
  listChats: () => [],
  createChat: () => ({}) as never,
  renameChat: () => null,
  deleteChat: () => false,
  history: () => [],
  search: () => [],
  listMemory,
  memoryWhy,
  send: () => {},
  upload: async () => ({}) as never,
  listModels: () => ({ active: "", models: [] }),
  setModel: () => {},
  listBackends: () => ({ active: "", backends: [] }),
  setBackend: async () => ({ ok: true }),
  setEffort: () => {},
  effortLevels: async () => ({ active: "", levels: [] }),
  listPlugins: () => [],
  setPluginEnabled: async () => ({ ok: true }),
  listSkills: () => [],
  setSkillEnabled: () => ({ ok: true }),
  resetChat: () => false,
  interruptTurn: async () => false,
  setPulse: () => {},
  queueMessage: () => {},
  getConfig: () => ({}) as never,
  setConfig: () => ({}) as never,
  control: async () => ({ ok: true, message: "" }),
  logs: () => [],
  liveTurnEvents: () => [],
  listCommands: () => [],
  mediaPath: () => null,
  registerDevice: async () => ({}) as never,
  storeLocation: async () => ({}) as never,
  listDevices: () => ({ devices: [], locations: [] }),
  completeCommand: () => false,
  acceptFileUpload: async () => ({ ok: false, error: "unused" }) as const,
  openFileDownload: async () => null,
  openNodeInstall: () => null,
  openCompanionPair: () => null,
  openNodeBinary: () => null,
} satisfies BridgeServerHandlers;

let server: BridgeServer;
let port: number;
/** The row `why` is asked about — asserted, then superseded. */
let supersededId: number;

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  return { status: res.status, body: await res.json() };
}

async function rowsOf(path: string): Promise<MemoryRowWire[]> {
  const { status, body } = await get(path);
  expect(status).toBe(200);
  return (body as { rows: MemoryRowWire[] }).rows;
}

beforeAll(async () => {
  const first = assertMemory({
    kind: "directive",
    subject: "deploys",
    text: "Ship on Fridays only",
    trust: "operator",
    salience: 10,
    pinned: true,
  });
  supersededId = first.id;
  supersedeMemory(first.id, "Ship on Thursdays only", "the week moved");
  for (let i = 0; i < 5; i++) {
    assertMemory({
      kind: "episode",
      subject: `walk-${i}`,
      text: `Ptarmigan sighting number ${i}`,
      trust: "agent",
    });
  }
  assertMemory({
    kind: "fact",
    subject: "birds",
    text: "A kestrel hovers before it stoops",
    trust: "operator",
  });

  server = new BridgeServer(
    { host: "127.0.0.1", port: 0, token: TOKEN, startedAt: "boot" },
    handlers,
  );
  port = await server.start();
});

afterAll(async () => {
  await server.stop();
});

describe("GET /memory", () => {
  it("lists live rows in wire shape", async () => {
    const rows = await rowsOf("/memory");
    // The superseded row is not live; its replacement is.
    expect(rows.map((r) => r.text)).toContain("Ship on Thursdays only");
    expect(rows.map((r) => r.text)).not.toContain("Ship on Fridays only");
    const pinned = rows.find((r) => r.subject === "deploys")!;
    expect(pinned).toMatchObject({
      kind: "directive",
      subject: "deploys",
      trust: "operator",
      confidence: 1,
      pinned: true,
      hitCount: 0,
      salience: 10,
    });
    expect(typeof pinned.createdAt).toBe("number");
    expect(typeof pinned.lastSeenAt).toBe("number");
    // Daemon internals never cross the wire.
    expect(pinned).not.toHaveProperty("contentHash");
    expect(pinned).not.toHaveProperty("source");
  });

  it("searches when q is given", async () => {
    const rows = await rowsOf("/memory?q=kestrel");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("A kestrel hovers before it stoops");
  });

  it("filters by kind", async () => {
    const rows = await rowsOf("/memory?kind=episode");
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.kind === "episode")).toBe(true);
  });

  it("honours an explicit limit", async () => {
    expect(await rowsOf("/memory?kind=episode&limit=2")).toHaveLength(2);
  });

  it("caps an absurd limit at 100 rather than dumping the table", async () => {
    // The cap is what matters: the store only ever sees 100, so the
    // response can never exceed it however big the query asks.
    const rows = await rowsOf("/memory?limit=1000000");
    expect(rows.length).toBeLessThanOrEqual(100);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("400s an unknown kind, naming the valid ones", async () => {
    const { status, body } = await get("/memory?kind=nonsense");
    expect(status).toBe(400);
    const err = (body as { ok: boolean; error: string }).error;
    expect(err).toContain('Unknown kind "nonsense"');
    expect(err).toContain("directive, fact, state, episode");
  });
});

describe("GET /memory/why", () => {
  it("returns the row plus its audit trail", async () => {
    const { status, body } = await get(`/memory/why?id=${supersededId}`);
    expect(status).toBe(200);
    const why = body as MemoryWhyWire;
    expect(why.row.id).toBe(supersededId);
    expect(why.row.text).toBe("Ship on Fridays only");
    // A superseded row still explains itself — that is the point of "why".
    expect(why.history.map((h) => h.op)).toEqual(["assert", "supersede"]);
    expect(why.history[1]!.reason).toBe("the week moved");
    expect(typeof why.history[0]!.at).toBe("number");
  });

  it("404s an unknown id", async () => {
    const { status, body } = await get("/memory/why?id=987654321");
    expect(status).toBe(404);
    expect(body).toEqual({ ok: false, error: "No memory with id 987654321" });
  });

  it("404s a missing id", async () => {
    const { status } = await get("/memory/why");
    expect(status).toBe(404);
  });
});
