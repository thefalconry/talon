/**
 * Teleport state — the active node each chat's native tools route through.
 *
 * When a node is active, Talon's native shell/file tools (bash/read/write/
 * edit/glob/search) execute ON that companion device via the mesh exec/fs
 * channel instead of on the daemon host — Talon acts as if it were running
 * on the phone. `teleport_back` clears it and everything runs locally again.
 *
 * State is a tiny JSON sidecar under the Talon root so it survives restarts.
 * The sidecar is keyed by chat id: teleporting in one chat must not redirect
 * native tools in another chat.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dirs } from "../../../util/paths.js";
import { writePrivateJson } from "../persist.js";

export type TeleportState = {
  /** Target device id (as registered in the mesh). */
  deviceId: string;
  /** Human name for messages. */
  deviceName: string;
  /**
   * Working directory tracked across native `bash` calls so a teleported
   * session feels persistent (a `cd` in one command carries to the next).
   * Undefined until the first command resolves it.
   */
  cwd?: string;
  /** When the teleport was engaged (epoch ms). */
  since: number;
};

type TeleportStore = {
  chats: Record<string, TeleportState>;
};

/** Resolved lazily so a test can point it at a tmp file via env. */
function stateFile(): string {
  return (
    process.env.TALON_TELEPORT_STATE_FILE ??
    resolve(dirs.root, "teleport-state.json")
  );
}

let cache: TeleportStore | undefined;
/**
 * The in-flight first read. Shared so concurrent cold callers all get the
 * one store: separate reads would each build their own, and the last to
 * finish would replace the cache — dropping any teleport set on another.
 */
let loading: Promise<TeleportStore> | undefined;

function emptyStore(): TeleportStore {
  return { chats: Object.create(null) as Record<string, TeleportState> };
}

function normalizeChatId(chatId: number | string): string {
  return String(chatId);
}

function parseState(value: unknown): TeleportState | null {
  const parsed = value as Partial<TeleportState> | null;
  if (!parsed || typeof parsed.deviceId !== "string" || !parsed.deviceId) {
    return null;
  }
  return {
    deviceId: parsed.deviceId,
    deviceName:
      typeof parsed.deviceName === "string" && parsed.deviceName
        ? parsed.deviceName
        : parsed.deviceId,
    ...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}),
    since: typeof parsed.since === "number" ? parsed.since : Date.now(),
  };
}

function readStore(): Promise<TeleportStore> {
  if (cache !== undefined) return Promise.resolve(cache);
  loading ??= loadStore();
  return loading;
}

async function loadStore(): Promise<TeleportStore> {
  try {
    const raw = await readFile(stateFile(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const store = emptyStore();
    if (
      parsed &&
      typeof parsed === "object" &&
      "chats" in parsed &&
      parsed.chats &&
      typeof parsed.chats === "object"
    ) {
      for (const [chatId, state] of Object.entries(
        parsed.chats as Record<string, unknown>,
      )) {
        const normalized = parseState(state);
        if (normalized) store.chats[chatId] = normalized;
      }
    } else {
      // Legacy singleton file from pre-chat-scoped teleport. Keep reading it
      // harmlessly, but do not bind it to any chat.
    }
    cache = store;
  } catch {
    cache = emptyStore();
  }
  return cache;
}

/** The active teleport target, or null when operating locally. */
export async function getTeleport(
  chatId: number | string,
): Promise<TeleportState | null> {
  const store = await readStore();
  return store.chats[normalizeChatId(chatId)] ?? null;
}

/** Engage teleport onto a device. */
export async function setTeleport(
  chatId: number | string,
  deviceId: string,
  deviceName: string,
): Promise<TeleportState> {
  const state: TeleportState = {
    deviceId,
    deviceName,
    since: Date.now(),
  };
  const store = await readStore();
  store.chats[normalizeChatId(chatId)] = state;
  cache = store;
  await writePrivateJson(stateFile(), store);
  return state;
}

/** Persist an updated working directory for the active teleport. */
export async function setTeleportCwd(
  chatId: number | string,
  cwd: string,
): Promise<void> {
  const current = await getTeleport(chatId);
  if (!current) return;
  const next: TeleportState = { ...current, cwd };
  const store = await readStore();
  store.chats[normalizeChatId(chatId)] = next;
  cache = store;
  await writePrivateJson(stateFile(), store);
}

/** Return to local operation. Returns the prior target (for the message). */
export async function clearTeleport(
  chatId: number | string,
): Promise<TeleportState | null> {
  const store = await readStore();
  const key = normalizeChatId(chatId);
  const prior = store.chats[key] ?? null;
  delete store.chats[key];
  cache = store;
  await writePrivateJson(stateFile(), store);
  return prior;
}

/** Test seam — drop the in-memory cache so the next read hits disk. */
export function resetTeleportCache(): void {
  cache = undefined;
  loading = undefined;
}
