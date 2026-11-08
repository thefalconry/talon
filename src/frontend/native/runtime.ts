/**
 * Native frontend runtime — the state every bridge module shares: one
 * object, constructed once, that each module (chat-wire, context, emit,
 * turn, …) takes as its first parameter. It carries state plus two
 * primitives — the message-id minter and the broadcast sink; the modules
 * own the behaviour.
 */

import type { TalonConfig } from "../../core/config/index.js";
import type { Gateway } from "../../core/engine/gateway.js";
import { getMeshService, type MeshService } from "../../core/mesh/index.js";
import { NativeChats } from "./chats/chats.js";
import type {
  BridgeEvent,
  ClientAttachment,
  ClientToolCall,
  ContextInfo,
} from "./protocol.js";

/** One tool call observed during a running turn, kept for mid-turn replay. */
export type LiveToolEntry = {
  call: ClientToolCall;
  startedAt: number;
  done?: boolean;
};

/** A chat's single queued follow-up, with its attachments intact. */
export type QueuedEntry = {
  text: string;
  attachments: ClientAttachment[];
};

export type NativeRuntime = {
  readonly config: TalonConfig;
  readonly gateway: Gateway;
  /** ISO timestamp of frontend construction — surfaced on /health + status. */
  readonly startedAt: string;
  readonly botName: string;
  readonly chats: NativeChats;
  /**
   * Daemon-wide mesh service (core/mesh). This frontend is its transport:
   * companions register/report/answer through the bridge routes, and the
   * SSE transport (wired in init) pushes locate requests and device commands
   * out. The model's mesh tools are served by the shared gateway actions, so
   * they work from every frontend.
   */
  readonly mesh: MeshService;
  /**
   * Ephemeral registry mapping a short media id → absolute file path, so the
   * bridge can serve images the bot attaches without exposing raw paths in
   * the URL. Lives for the process; history rows keep only a text
   * placeholder, so images render live in-session (mirroring how the chat
   * frontends behave).
   */
  readonly media: Map<string, string>;
  /**
   * `media` reversed (path → id). Every history page re-registers its
   * attachments, so without this each fetch — and every client reconnect
   * re-fetches — grew `media` by one entry per attachment, forever.
   */
  readonly mediaIds: Map<string, string>;
  /**
   * Uploads this daemon run has accepted, keyed by their media id. `/send`
   * resolves a client's attachment references through here rather than
   * trusting the paths in the request body, so a message can only ever point
   * the model at a file this daemon itself wrote to the uploads dir.
   */
  readonly uploads: Map<string, ClientAttachment>;
  /**
   * Live context-window fill per chat, refreshed at the end of each turn.
   * Cached (not computed inline) so the sync `toClientChat` projection stays
   * sync — it just reads the last computed value.
   */
  readonly contextByChat: Map<string, ContextInfo>;
  /**
   * In-progress turns, keyed by chat id, so a client that (re)connects
   * mid-turn can be replayed the turn's tool activity instead of waiting for
   * the turn to finish. Holds the same live tool map `runTurn` mutates;
   * cleared at turn end.
   */
  readonly liveTurns: Map<string, Map<string, LiveToolEntry>>;
  /**
   * The single queued follow-up per chat, held server-side so every
   * connected client shares (and can edit/cancel) the same queue. Keeps the
   * attachment paths so a queued image sends intact when the turn ends.
   */
  readonly queuedByChat: Map<string, QueuedEntry>;
  /**
   * The most recent assistant message id per chat — turn_end attaches the
   * turn's meta (tools/stats) to this message so history hydration can show
   * what the model did after a reload.
   */
  readonly lastAssistantId: Map<string, string>;
  /**
   * Monotonic message-id minter. Seeded from the wall clock so ids stay
   * unique and ascending across restarts (history rows persist their ids).
   */
  nextId(): number;
  /** Fan an event out to every connected bridge client. */
  broadcast(event: BridgeEvent): void;
};

export function createNativeRuntime(
  config: TalonConfig,
  gateway: Gateway,
  broadcast: (event: BridgeEvent) => void,
): NativeRuntime {
  let seq = Date.now();
  return {
    config,
    gateway,
    startedAt: new Date().toISOString(),
    botName: config.botDisplayName || "Talon",
    chats: new NativeChats(),
    mesh: getMeshService(),
    media: new Map(),
    mediaIds: new Map(),
    uploads: new Map(),
    contextByChat: new Map(),
    liveTurns: new Map(),
    queuedByChat: new Map(),
    lastAssistantId: new Map(),
    nextId: () => ++seq,
    broadcast,
  };
}
