import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import type { AttachmentRef } from "./params.js";
import type {
  BridgeCredentials,
  BridgePrincipal,
} from "../credentials/principal.js";
import type {
  BackendOption,
  ClientAttachment,
  BridgeEvent,
  BridgeStatus,
  ClientChat,
  ClientCommand,
  ClientMessage,
  DeviceInfo,
  DeviceLocation,
  LogEntry,
  LogLevel,
  MemoryWhyWire,
  ModelOption,
  PluginItem,
  SearchResult,
  SkillItem,
  ToggleResult,
} from "../../protocol.js";
import type {
  MemoryListQuery,
  MemoryListResult,
} from "../../surface/memory.js";
import type { ConfigSnapshot } from "../../surface/settings.js";

/** Optional attachment references carried alongside a sent message. */
export type SendOptions = {
  /**
   * Every file attached to the message, as the client's references to its
   * own uploads. `imagePath` and `attachmentPath` below are the single-file
   * shape older clients send; the handler folds them into the same list.
   */
  attachments?: AttachmentRef[];
  /** Relative bridge path to render inline (e.g. `/media?id=…`). */
  imagePath?: string;
  /** Absolute on-disk path handed to the model so it can read the file. */
  attachmentPath?: string;
};

/** Everything the transport needs the frontend to implement. */
export type BridgeServerHandlers = {
  status(): BridgeStatus;
  listChats(): ClientChat[];
  createChat(title?: string): ClientChat;
  renameChat(id: string, title: string): ClientChat | null;
  deleteChat(id: string): boolean;
  /** A page of history: newest window, or the window before `before`. */
  history(
    id: string,
    opts?: { before?: number; limit?: number },
  ): ClientMessage[];
  /** Full-text search across chats (or one chat when `chatId` is given). */
  search(query: string, chatId?: string): SearchResult[];
  /**
   * Live memory rows — a full-text search when `q` is given, else the
   * ranked listing. Read-only: the bridge exposes no memory writes.
   */
  listMemory(query: MemoryListQuery): MemoryListResult;
  /** One memory row plus its audit trail, or null when no such id. */
  memoryWhy(id: number): MemoryWhyWire | null;
  /**
   * Fire-and-forget: streams its results back through `broadcast`. Text
   * naming one of the daemon's slash commands is answered by the daemon
   * instead of the model; `caller` says whether the credential may run
   * the operator-only ones (absent = it may not).
   */
  send(
    id: string,
    text: string,
    opts?: SendOptions,
    caller?: { operator: boolean },
  ): void;
  /**
   * Stream an uploaded file to disk and return its wire description. The body
   * is consumed as it arrives (never buffered whole), so the size ceiling is
   * disk, not memory.
   */
  upload(
    filename: string,
    contentType: string,
    body: Readable,
  ): Promise<ClientAttachment>;
  listModels(
    id?: string,
  ):
    | { active: string; models: ModelOption[] }
    | Promise<{ active: string; models: ModelOption[] }>;
  setModel(id: string, model: string): void;
  /** Backends selectable for a chat + the chat's active backend id. */
  listBackends(id: string): { active: string; backends: BackendOption[] };
  /** Switch a chat to another backend; returns ok + an optional error. */
  setBackend(
    id: string,
    backend: string,
  ): Promise<{ ok: boolean; error?: string }>;
  setEffort(id: string, effort: string): void;
  effortLevels(id: string): Promise<{ active: string; levels: string[] }>;
  resetChat(id: string): boolean;
  /** Best-effort interrupt of a chat's in-flight turn. `true` if one was
   *  running and got signalled. */
  interruptTurn(id: string): Promise<boolean>;
  setPulse(id: string, on: boolean): void;
  /** Set/replace/clear the chat's queued follow-up (empty text clears). */
  queueMessage(id: string, text: string): void;
  /** Read the daemon's own (allowlisted) settings + health. */
  getConfig(): ConfigSnapshot;
  /** Change daemon settings; returns the fresh snapshot. */
  setConfig(update: Record<string, unknown>): ConfigSnapshot;
  /** Installed plugins (built-ins + configured entries) with state. */
  listPlugins(): PluginItem[];
  /** Enable/disable a plugin; persists + hot-reloads. */
  setPluginEnabled(name: string, enabled: boolean): Promise<ToggleResult>;
  /** Installed skills with state. */
  listSkills(): SkillItem[];
  /** Enable/disable a skill; rebuilds the prompt index. */
  setSkillEnabled(name: string, enabled: boolean): ToggleResult;
  /** Fire a daemon-level control action (e.g. "restart", "dream"). */
  control(action: string): Promise<{ ok: boolean; message: string }>;
  /** The slash commands `/send` answers itself, for client autocomplete. */
  listCommands(): ClientCommand[];
  /** Newest daemon log entries (for the client's log viewer). */
  logs(opts: {
    lines: number;
    minLevel?: LogLevel;
    component?: string;
  }): LogEntry[];
  /** Events reconstructing any in-progress turns, for a just-connected client. */
  liveTurnEvents(): BridgeEvent[];
  /** Resolve a media id to an absolute file path (or null if unknown). */
  mediaPath(id: string): string | null;
  /** Best-effort original file name for a media id (or null if unknown). */
  mediaName?(id: string): string | null;
  /** Register/update one mesh device. */
  registerDevice(body: Record<string, unknown>): Promise<DeviceInfo>;
  /** Store the last-known location for one mesh device. */
  storeLocation(body: Record<string, unknown>): Promise<DeviceLocation>;
  /** List mesh devices and their last-known locations. */
  listDevices():
    | { devices: DeviceInfo[]; locations: DeviceLocation[] }
    | Promise<{ devices: DeviceInfo[]; locations: DeviceLocation[] }>;
  /** A device answered a device_command; true when a call was waiting. */
  completeCommand(body: Record<string, unknown>): boolean;
  /** A device streams a pull-transfer's file body up (raw request body).
   *  `fromDeviceId` is the caller's claimed identity, when it sent one. */
  acceptFileUpload(
    token: string,
    body: IncomingMessage,
    fromDeviceId?: string,
  ): Promise<{ ok: true; bytes: number } | { ok: false; error: string }>;
  /** Resolve a push-transfer token to the file to stream down, or null. */
  openFileDownload(
    token: string,
    fromDeviceId?: string,
  ): Promise<{ path: string; size: number } | null>;
  /** Resolve a companion-pairing grant to its page/payload, or null. */
  openCompanionPair(
    token: string,
    format: "html" | "json",
  ): { contentType: string; body: string } | null;
  /**
   * Resolve a node-provisioning token to its installer script, or null. An
   * auto link passes the os/arch its host reported.
   */
  openNodeInstall(
    token: string,
    os?: string | null,
    arch?: string | null,
  ):
    | { script: string; filename: string }
    | null
    | Promise<{ script: string; filename: string } | null>;
  /** Resolve a node-provisioning token to the binary to stream, or null. */
  openNodeBinary(token: string): { path: string; size: number } | null;
};

/**
 * What a route handler may do with the server that owns it. Built once
 * by BridgeServer as bound closures, so the route modules never see the
 * class — only this surface.
 */
export type RouteHost = {
  handlers: BridgeServerHandlers;
  opts: { host: string; token?: string; startedAt: string };
  port: () => number;
  scheme: () => "http" | "https";
  fingerprint: () => string | null;
  json: (res: ServerResponse, code: number, body: unknown) => void;
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  corsHeaders: () => Record<string, string>;
  streamFile: (
    res: ServerResponse,
    file: { path: string; size: number },
  ) => void;
  serveMedia: (res: ServerResponse, id: string) => Promise<void>;
  openStream: (
    res: ServerResponse,
    deviceId: string | undefined,
    principal: BridgePrincipal,
  ) => void;
  unknownProvision: (res: ServerResponse) => void;
  /** Per-device credential support; undefined = shared token only. */
  credentials: BridgeCredentials | undefined;
};
