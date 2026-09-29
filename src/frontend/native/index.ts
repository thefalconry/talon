/**
 * Native frontend factory.
 *
 * A client-agnostic bridge: it runs the same gateway every messaging frontend
 * uses (so the agent's tools work) PLUS a Bridge server (server.ts) that GUI
 * clients connect to over the v1 protocol. The Electron-replacement Flutter
 * companion app is the reference client, but anything speaking the protocol —
 * a remote Android app over a token-authed LAN connection, a web client —
 * works identically.
 *
 * This file is wiring only: it constructs the shared runtime (runtime.ts),
 * binds the bridge handlers (handlers.ts) to a server, and owns the
 * frontend lifecycle. The behaviour lives in the modules the handlers
 * delegate to — chat-wire, context, emit, turn, models, history, ….
 */

import type { TalonConfig } from "../../core/config/index.js";
import type { ContextManager } from "../../core/types.js";
import type { Gateway } from "../../core/engine/gateway.js";
import { log, logError, logWarn } from "../../util/log.js";
import { notifyAdmin } from "../../core/frontend-runtime/admin-notify.js";
import { createNativeActionHandler } from "./turn/actions.js";
import { loadOrCreateBridgeToken } from "./bridge/auth.js";
import { warmContextCache } from "./turn/context.js";
import {
  removeBridgeDiscovery,
  writeBridgeDiscovery,
} from "./bridge/discovery.js";
import { emitAssistant, emitPhoto } from "./turn/emit.js";
import { startEmptyChatSweep } from "./chats/empty-chat-sweep.js";
import { buildBridgeHandlers } from "./surface/handlers.js";
import { createNativeRuntime, type NativeRuntime } from "./runtime.js";
import { BridgeServer, type BridgeCredentials } from "./bridge/server.js";
import {
  DEFAULT_COMPANION_SCOPES,
  type MeshScope,
} from "../../core/mesh/credentials/index.js";
import { isLoopbackHost, loadOrCreateBridgeTlsIdentity } from "./bridge/tls.js";

export { summarizeToolResult } from "./turn/tool-result.js";

export type NativeFrontend = {
  name: "native";
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type BridgeListen = {
  host: string;
  port: number;
  token: string | undefined;
  tls: boolean;
  legacySharedToken: boolean;
  companionScopes: readonly MeshScope[];
};

/** Where the bridge listens, and how it is secured, from `config.native`. */
function bridgeListen(config: TalonConfig): BridgeListen {
  const nativeCfg = config.native ?? { port: 19880, host: "127.0.0.1" };
  const host = nativeCfg.host ?? "127.0.0.1";
  // Encrypted by default the moment the bridge leaves the machine; loopback
  // stays plain HTTP unless explicitly opted in (`native.tls`).
  const tls = nativeCfg.tls ?? !isLoopbackHost(host);
  // Never serve the agent API to the network unauthenticated: a non-loopback
  // bind with no configured token gets a persistent auto-minted one instead.
  // `?? ` alone would treat an empty string as a configured token and skip
  // the mint, serving the LAN unauthenticated while looking configured —
  // easy to hit from `"token": "${BRIDGE_TOKEN}"` with the var unset.
  const configuredToken =
    nativeCfg.token !== undefined && nativeCfg.token !== ""
      ? nativeCfg.token
      : undefined;
  const token =
    configuredToken ??
    (isLoopbackHost(host) ? undefined : loadOrCreateBridgeToken());
  return {
    host,
    port: nativeCfg.port ?? 19880,
    token,
    tls,
    legacySharedToken: nativeCfg.legacySharedToken ?? true,
    companionScopes: nativeCfg.companionScopes ?? DEFAULT_COMPANION_SCOPES,
  };
}

/**
 * Per-device credentials for the bridge: only meaningful when the bridge
 * authenticates at all (an open loopback bridge has nothing to scope).
 */
function bridgeCredentials(
  listen: BridgeListen,
  mesh: NativeRuntime["mesh"],
): BridgeCredentials | undefined {
  if (!listen.token || !mesh.credentials) return undefined;
  return {
    authority: mesh.credentials,
    policy: {
      legacySharedToken: listen.legacySharedToken,
      companionScopes: listen.companionScopes,
    },
  };
}

/**
 * Plug this bridge in as the mesh's transport: locates and device commands
 * (from ANY frontend's mesh tool calls) leave as SSE events.
 *
 * A locate is a bare "who's there?" — no secret in the frame, and
 * pre-command app builds rely on receiving it — so it still fans out.
 * A command is the opposite: its params carry transfer tokens, exec
 * command lines and (on the chunked fallback) file bodies, so it goes
 * to the target device's own client(s) only.
 */
function registerMeshTransport(
  runtime: NativeRuntime,
  server: BridgeServer,
): () => void {
  return runtime.mesh.registerTransport({
    locate: (deviceId) => runtime.broadcast({ kind: "locate", deviceId }),
    command: (command) =>
      server.sendToDevice(command.deviceId, {
        kind: "device_command",
        id: command.id,
        deviceId: command.deviceId,
        name: command.name,
        params: command.params,
      }),
  });
}

export function createNativeFrontend(
  config: TalonConfig,
  gateway: Gateway,
): NativeFrontend {
  const runtime = createNativeRuntime(config, gateway, (event) =>
    server.broadcast(event),
  );
  const { chats, mesh } = runtime;
  const listen = bridgeListen(config);
  const server = new BridgeServer(
    {
      host: listen.host,
      port: listen.port,
      token: listen.token,
      allowedOrigins: config.native?.allowedOrigins,
      allowWeakToken: config.native?.allowWeakToken,
      sseMaxLifetimeMs: config.native?.sseMaxLifetimeMs,
      // Distributed token guessing should reach a human, not just the log.
      onSecurityAlert: (message) => void notifyAdmin(message),
      startedAt: runtime.startedAt,
      ...(listen.tls ? { tls: () => loadOrCreateBridgeTlsIdentity() } : {}),
      credentials: bridgeCredentials(listen, mesh),
    },
    buildBridgeHandlers(runtime),
  );
  let unregisterMeshTransport: (() => void) | null = null;
  let stopEmptyChatSweep: (() => void) | null = null;

  const context: ContextManager = {
    acquire: (chatId: number, stringId?: string) =>
      gateway.setContext(chatId, stringId, "native"),
    release: (chatId: number) => gateway.clearContext(chatId),
    getMessageCount: (chatId: number) => gateway.getMessageCount(chatId),
  };

  return {
    name: "native",
    context,

    sendTyping: async (chatId: number) => {
      const entry = chats.byNumeric(chatId);
      if (entry)
        runtime.broadcast({ kind: "typing", chatId: entry.id, on: true });
    },

    // Used by cron / pulse / heartbeat to reach a chat outside a user turn.
    sendMessage: async (chatId: number, text: string) => {
      if (!text.trim()) return;
      const entry = chats.byNumeric(chatId);
      if (entry) emitAssistant(runtime, entry, text);
    },

    getBridgePort: () => gateway.getPort(),

    async init() {
      await mesh.load();
      unregisterMeshTransport = registerMeshTransport(runtime, server);
      // Mesh tool actions (list_devices / get_device_location) are shared
      // gateway actions — no native-only cases here.
      gateway.registerFrontendHandler(
        "native",
        createNativeActionHandler({
          chats,
          gateway,
          emitAssistant: (entry, text, buttons) =>
            emitAssistant(runtime, entry, text, buttons),
          emitPhoto: (entry, filePath, caption) =>
            emitPhoto(runtime, entry, filePath, caption),
          broadcast: runtime.broadcast,
        }),
      );
      const gatewayPort = await gateway.start(19876);
      log("native", `Gateway on :${gatewayPort}`);
      chats.restore();
      // Non-blocking: a cold cache costs a missing chip, not a broken boot.
      void warmContextCache(runtime).catch((err) =>
        logError("native", "Context cache warm failed", err),
      );
      stopEmptyChatSweep = startEmptyChatSweep(runtime);
      await server.start();
      if (
        listen.token &&
        listen.legacySharedToken &&
        !isLoopbackHost(listen.host)
      ) {
        logWarn(
          "native",
          "native.legacySharedToken is on: remote clients may still use the shared bridge token. " +
            "Devices trade it for their own credential on their next connect; once `talon mesh` " +
            "lists none on the shared token, set native.legacySharedToken to false and rotate native.token.",
        );
      }
      const fingerprint = server.getFingerprint();
      const spkiPin = server.getSpkiPin();
      // Tell the mesh how this bridge is reachable — everything a generated
      // node installer needs (make_node_install_link fails cleanly without it).
      mesh.setBridgeInfo({
        scheme: server.getScheme(),
        host: listen.host,
        port: server.getPort(),
        ...(listen.token ? { token: listen.token } : {}),
        ...(fingerprint ? { fingerprint } : {}),
        ...(spkiPin ? { spkiPin } : {}),
        ...(config.native?.publicUrl
          ? { publicUrl: config.native.publicUrl }
          : {}),
        legacySharedToken: listen.legacySharedToken,
        companionScopes: listen.companionScopes,
      });
      await writeBridgeDiscovery({
        port: server.getPort(),
        token: listen.token,
        scheme: server.getScheme(),
        ...(fingerprint ? { fingerprint } : {}),
        startedAt: Date.parse(runtime.startedAt),
      });
    },

    // Nothing to run: init() already bound the bridge server, so the
    // frontend is listening the moment start() is called.
    async start() {
      log(
        "native",
        `Native bridge ready (${chats.count()} chat(s)) — connect a client to :${server.getPort()}`,
      );
    },

    async stop() {
      stopEmptyChatSweep?.();
      stopEmptyChatSweep = null;
      unregisterMeshTransport?.();
      unregisterMeshTransport = null;
      mesh.setBridgeInfo(null);
      await removeBridgeDiscovery();
      await server.stop();
      await gateway.stop();
    },
  };
}
