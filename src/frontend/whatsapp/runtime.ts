/**
 * WhatsApp frontend runtime — the state every module shares.
 *
 * One explicit object, constructed once, that each module (access,
 * inbound, connection) takes as its first parameter. The runtime carries
 * the parsed settings, the allow-lists and the live socket state; the
 * modules own the behaviour.
 */

import type { WASocket } from "baileys";
import type { TalonConfig } from "../../core/config/index.js";
import type { Gateway } from "../../core/engine/gateway.js";
import { bareId } from "./connection/identity.js";
import {
  createConnectionHealth,
  type ConnectionHealth,
} from "./connection/health.js";

type WhatsAppSettings = {
  allowedJids: string[];
  allowedGroups: string[];
  groupPolicy: "listed" | "with-allowed-user" | "all";
  respondMode: "mention" | "all";
  pairingNumber?: string;
  sendReadReceipts: boolean;
};

/** Reconnect backoff: WhatsApp throttles a client that hammers it. */
export const RECONNECT_BASE_MS = 2_000;
export const RECONNECT_MAX_MS = 60_000;

export type WhatsAppRuntime = {
  readonly config: TalonConfig;
  readonly gateway: Gateway;
  readonly settings: WhatsAppSettings;
  /** `allowedJids` / `allowedGroups`, normalised to bare ids. */
  readonly allowedDms: ReadonlySet<string>;
  readonly allowedGroups: ReadonlySet<string>;
  /** Cached `groupPolicy` verdicts, keyed by group JID. */
  readonly groupAllowCache: Map<string, { allowed: boolean; at: number }>;
  /** The live socket. Reconnects replace it, so read it at each use. */
  sock: WASocket | null;
  stopping: boolean;
  /**
   * Aborted by `stop()`. The connection loop's waits (reconnect backoff,
   * the park that holds an unpaired account) listen for it, so a
   * shutdown that awaits the loop never sits out a timer it could skip.
   */
  readonly stopRequest: AbortController;
  reconnectDelay: number;
  /** One "not linked" admin note per outage, not one per QR window. */
  unpairedNotified: boolean;
  /** Reconnect logging and the `whatsapp.connection` alert. */
  readonly health: ConnectionHealth;
  /** Our own ids (phone and LID), once connected — for mention detection. */
  selfIds: string[];
};

export function createWhatsAppRuntime(
  config: TalonConfig,
  gateway: Gateway,
): WhatsAppRuntime {
  const settings: WhatsAppSettings = {
    allowedJids: [],
    allowedGroups: [],
    groupPolicy: "listed",
    respondMode: "mention",
    sendReadReceipts: true,
    ...((config as Record<string, unknown>).whatsapp as
      Partial<WhatsAppSettings> | undefined),
  };
  return {
    config,
    gateway,
    settings,
    allowedDms: new Set(settings.allowedJids.map(bareId)),
    allowedGroups: new Set(settings.allowedGroups.map(bareId)),
    groupAllowCache: new Map(),
    sock: null,
    stopping: false,
    stopRequest: new AbortController(),
    reconnectDelay: RECONNECT_BASE_MS,
    unpairedNotified: false,
    health: createConnectionHealth(),
    selfIds: [],
  };
}
