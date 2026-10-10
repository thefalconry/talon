/**
 * Talon Client Bridge Protocol (v1).
 *
 * The stable, client-agnostic contract between a Talon daemon running the
 * `native` frontend and ANY GUI client: the bundled Electron companion app
 * (apps/desktop), and future clients (Android, iOS, web). Transport is plain
 * HTTP + Server-Sent Events with JSON bodies, so a client written in any
 * language can speak it against `http://<host>:<port>` (plus a bearer token
 * when one is configured).
 *
 * This module is the TRANSLATION LAYER. It defines the wire types and the
 * pure mappers from Talon's internal shapes (`HistoryMessage`, sessions,
 * `AgentEvent`) into them. Nothing Talon-internal crosses the wire — clients
 * depend only on the types here, never on Talon's engine. Bump
 * `BRIDGE_PROTOCOL_VERSION` on a breaking change so clients can refuse a
 * mismatch instead of misrendering.
 */

import type { HistoryMessage } from "../../storage/history.js";
import { unescapeHtml } from "../../util/html-entities.js";

/** Wire-format version. Surfaced in `/health` and the `hello` event. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** History sender id reserved for Talon's own (assistant) messages. */
export const BOT_SENDER_ID = 0;
/** History sender id used for the human on the other end of a native chat. */
export const USER_SENDER_ID = 1;

type ClientRole = "user" | "assistant" | "system";

/** An inline button. `url` opens a link; `data` is an opaque callback token. */
export type ClientButton = { text: string; url?: string; data?: string };

/**
 * A tool invocation that ran during an assistant turn, persisted so history
 * shows what the model did even after a reload/restart (additive in v1 —
 * older clients simply ignore the field).
 *
 * Reply-delivery tools (`end_turn` / `send_message` / `react`) never appear
 * here or in `tool` events — the daemon classifies and excludes them at the
 * source, because their effect already reaches clients as the `message` /
 * `reaction` itself. Clients render tool timelines as-is, no name filtering.
 */
export type ClientToolCall = {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  error?: string;
  /** Wall-clock duration of this call, when known. */
  durationMs?: number;
  /** Truncated string form of the tool's result, for the expanded view. */
  output?: string;
};

/**
 * One file attached to a message — an image, an archive, a document, or
 * anything else the user dropped on the composer. Additive in v1: older
 * clients that only know `imagePath` keep rendering the first image.
 *
 * `path` is the absolute on-disk location in the daemon's uploads dir; it is
 * what the model is pointed at so it can read the file itself. `url` is the
 * relative bridge path a client fetches the bytes from (`/media?id=…`),
 * resolved against its own base URL + token.
 */
export type ClientAttachment = {
  /** Absolute path on the daemon host (handed to the model). */
  path: string;
  /** Original file name, for display. */
  name: string;
  /** Size in bytes. */
  size: number;
  /** Best-effort MIME type, `application/octet-stream` when unknown. */
  mimeType: string;
  /** Relative bridge path the bytes are served from (`/media?id=…`). */
  url: string;
  /** True when the client should render this inline as an image. */
  image: boolean;
};

/** A single rendered message in a conversation. */
export type ClientMessage = {
  id: string;
  chatId: string;
  role: ClientRole;
  text: string;
  /** Epoch milliseconds. */
  ts: number;
  buttons?: ClientButton[][];
  reactions?: string[];
  /**
   * Relative bridge path to an attached image (e.g. `/media?id=…`). The
   * client resolves it against its own base URL + token and renders it inline.
   * Present on photo messages the bot sends; `text` carries any caption.
   */
  imagePath?: string;
  /**
   * Every file attached to this message, in the order the user staged them.
   * `imagePath` stays in sync with the first image here so clients written
   * against the single-image shape keep working unchanged.
   */
  attachments?: ClientAttachment[];
  /** Tools that ran during this assistant turn (history hydration). */
  tools?: ClientToolCall[];
  /** Turn stats attached once the turn ended (history hydration). */
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
};

/** One full-text search hit: the message plus the chat it lives in. */
export type SearchResult = {
  chatId: string;
  chatTitle: string;
  message: ClientMessage;
};

/**
 * Live context-window fill for a chat's session — how much of the model's
 * context the running conversation currently occupies. `known` is false when
 * the backend doesn't report a current-window figure (the client then hides
 * the readout rather than showing a fake 0%).
 */
export type ContextInfo = {
  known: boolean;
  /** Current tokens in the context window. */
  used: number;
  /** The model's context window size, or 0 when unknown. */
  max: number;
  /** used/max as a 0–100 integer (0 when not `known`). */
  pct: number;
  /** True once the window is ≥80% full — a hint to warn in the UI. */
  warn: boolean;
};

/**
 * A follow-up message queued while a turn is running. The daemon holds one
 * per chat and auto-sends it when the current turn ends. Broadcast on the
 * owning `ClientChat` so every connected client sees (and can edit/cancel)
 * the same queued message.
 */
export type QueuedMessage = {
  text: string;
  /** True when one or more files are attached to the queued send. */
  hasAttachment: boolean;
  /** How many files are attached (additive; older clients read the flag). */
  attachmentCount?: number;
};

/** A conversation in the sidebar. */
export type ClientChat = {
  id: string;
  title: string;
  createdAt: number;
  lastActive: number;
  /** Truncated last-message text for the list preview. */
  preview: string;
  /** Resolved model id for this chat, when known. */
  model?: string;
  /** Active backend id for this chat (e.g. "claude", "codex"), when known. */
  backend?: string;
  /** Reasoning effort for this chat, when known. */
  effort?: string;
  /** Whether proactive pulse check-ins are enabled for this chat. */
  pulse?: boolean;
  /** Live context-window fill, refreshed after each turn (when known). */
  context?: ContextInfo;
  /** The queued follow-up for this chat, when one is parked. */
  queued?: QueuedMessage;
};

/** Daemon-level status shown in the client's header / status pill. */
export type BridgeStatus = {
  app: "talon-bridge";
  protocol: number;
  /** Additive bridge features supported by this daemon. */
  capabilities?: string[];
  botName: string;
  backend: string;
  /** Display name of the global default model. */
  model: string;
  activeChats: number;
  startedAt: string;
};

/** Wire severity for a daemon log entry (mirrors pino's level names). */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LOG_LEVELS: readonly LogLevel[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
];

/** Narrow an untrusted query-param string to a wire log level. */
export function isLogLevel(v: string): v is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(v);
}

/**
 * One daemon log line, served by `GET /logs` for the client's log viewer
 * (additive in v1 — older clients simply never call the endpoint).
 */
export type LogEntry = {
  /** Epoch milliseconds. */
  ts: number;
  level: LogLevel;
  /** Subsystem tag (e.g. "agent", "native", "gateway"), when present. */
  component?: string;
  msg: string;
  /** Concise error message, when the line logged one. */
  err?: string;
  /** Full stack trace, when the line logged one. */
  stack?: string;
};

/**
 * One slash command the daemon answers itself in a native chat, as
 * `GET /commands` lists it — so a client can offer autocomplete. Additive
 * in v1 behind the `commands` capability. A `/send` whose text starts with
 * a listed name is handled by the daemon (the command and its reply land
 * in the chat as ordinary messages); any other text reaches the model.
 */
export type ClientCommand = {
  /** Without the leading slash, e.g. `"backup"`. */
  name: string;
  /** One line, for the suggestion list. */
  description: string;
  /** Argument synopsis, e.g. `"[list|now|restore <id>]"`; absent = none. */
  args?: string;
  /** Needs the `operator` scope; other callers get a refusal. */
  admin?: boolean;
};

/** A selectable model for the picker. */
export type ModelOption = {
  id: string;
  displayName: string;
  provider: string;
  reasoning: boolean;
};

/** A selectable backend for the picker (e.g. Claude SDK, Codex). */
export type BackendOption = {
  id: string;
  label: string;
};

/**
 * One installed plugin, as `GET /plugins` lists it. Toggled via
 * `POST /plugins/toggle` (`{ name, enabled }` → `ToggleResult`). Additive
 * in v1 behind the `plugins-skills` capability — older clients never call
 * these endpoints.
 */
export type PluginItem = {
  name: string;
  /** Built-in (config-section) plugin, module plugin, or MCP server. */
  kind: "builtin" | "module" | "mcp";
  enabled: boolean;
  /** Where it comes from: a config section, module path, or MCP command. */
  source: string;
};

/**
 * One installed skill, as `GET /skills` lists it. Toggled via
 * `POST /skills/toggle` — a disabled skill drops out of the model's
 * prompt index but stays installed.
 */
export type SkillItem = {
  name: string;
  description: string;
  enabled: boolean;
};

/**
 * Application-level outcome of a toggle, always carried in an HTTP 200
 * body (mirrors `/backend`: the client renders ok/error, HTTP-level
 * failures stay transport errors).
 */
export type ToggleResult = { ok: boolean; error?: string };

/**
 * One row of the typed memory store, as `GET /memory` lists it.
 *
 * A projection, not the stored row: the internal `source`, `contentHash`
 * and supersede/drop pointers stay daemon-side, and the numbers that
 * decide where a row ranks (trust, confidence, hits, salience) come
 * along so a client can show WHY something is remembered, not just
 * what. `kind` and `trust` are the store's vocabularies as plain
 * strings — a client renders what it gets rather than refusing an
 * unknown one.
 */
export type MemoryRowWire = {
  id: number;
  kind: string;
  subject: string;
  /** Present only on keyed `state` rows. */
  key?: string;
  text: string;
  trust: string;
  /** 0..1. */
  confidence: number;
  pinned: boolean;
  hitCount: number;
  salience: number;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  lastSeenAt: number;
};

/** One audit entry from a row's trail, oldest first in `MemoryWhyWire`. */
export type MemoryHistoryWire = {
  /** assert | supersede | drop | merge | pin | unpin | replace_state. */
  op: string;
  /** Epoch milliseconds. */
  at: number;
  reason?: string;
};

/** `GET /memory/why?id=` — one row plus everything that happened to it. */
export type MemoryWhyWire = {
  row: MemoryRowWire;
  history: MemoryHistoryWire[];
};

// Mesh device shapes are canonical in core (the mesh is daemon-wide state,
// readable from every frontend); re-exported here so bridge clients keep
// depending on the protocol module alone.
export type {
  DeviceCommand,
  DeviceCommandResult,
  DeviceInfo,
  DeviceLocation,
} from "../../core/mesh/types.js";
import type { DeviceCommand as MeshDeviceCommand } from "../../core/mesh/types.js";

/**
 * Server → client events, delivered as SSE `data:` lines (one JSON object
 * each). The client switches on `kind`. Streaming text arrives as ephemeral
 * `delta` events; the canonical, persisted reply always arrives as a
 * `message` event (possibly several per turn).
 */
export type BridgeEvent =
  | { kind: "hello"; status: BridgeStatus; chats: ClientChat[] }
  | { kind: "status"; status: BridgeStatus }
  | { kind: "chat_created"; chat: ClientChat }
  | { kind: "chat_updated"; chat: ClientChat }
  | { kind: "chat_deleted"; chatId: string }
  | { kind: "message"; chatId: string; message: ClientMessage }
  | { kind: "message_edited"; chatId: string; messageId: string; text: string }
  | { kind: "message_deleted"; chatId: string; messageId: string }
  | { kind: "reaction"; chatId: string; messageId: string; emoji: string }
  | { kind: "turn_start"; chatId: string }
  | { kind: "reasoning"; chatId: string; text: string }
  | { kind: "delta"; chatId: string; text: string }
  | {
      kind: "tool";
      chatId: string;
      id: string;
      name: string;
      phase: "call" | "result";
      input?: Record<string, unknown>;
      error?: string;
      /** Truncated string form of the result, on the `result` phase. */
      output?: string;
    }
  | { kind: "typing"; chatId: string; on: boolean }
  | {
      kind: "turn_end";
      chatId: string;
      delivered: number;
      durationMs?: number;
      usage?: { input: number; output: number };
    }
  | { kind: "locate"; deviceId?: string }
  /**
   * On-demand device command (ring, open_url, clipboard_*, status, …). The
   * target device executes it and answers via POST /devices/command-result
   * with the same `id` as `commandId`. Additive in v1 — app builds that
   * predate the command channel simply ignore the event.
   *
   * Addressed, not broadcast: params carry one-time transfer tokens, exec
   * command lines and (on the chunked fallback) file bodies, so the frame
   * goes only to the SSE client(s) that claimed this `deviceId` via
   * `GET /events?deviceId=…`. Clients that claim no id still receive
   * commands for devices nobody claimed, so pre-claim builds keep working.
   */
  | {
      kind: "device_command";
      id: string;
      deviceId: string;
      name: string;
      params: MeshDeviceCommand["params"];
    }
  | { kind: "error"; chatId?: string; message: string };

// ── Mappers (Talon internals → wire types) ───────────────────────────────────

/** Collapse whitespace and clip a string for list previews. */
export function previewOf(text: string, max = 90): string {
  const flat = unescapeHtml(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Map a persisted history row to a wire message. */
export function historyToClientMessage(
  m: HistoryMessage,
  chatId: string,
): ClientMessage {
  return {
    id: String(m.msgId),
    chatId,
    role: m.senderId === BOT_SENDER_ID ? "assistant" : "user",
    text: m.text,
    ts: m.timestamp,
  };
}
