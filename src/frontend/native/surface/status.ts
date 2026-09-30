/**
 * Bridge status — the daemon-level summary served on `/status` and pushed
 * as a `status` event whenever something it reports changes.
 */

import { resolveModel } from "../../../core/models/catalog.js";
import { BRIDGE_PROTOCOL_VERSION, type BridgeStatus } from "../protocol.js";
import type { NativeRuntime } from "../runtime.js";

export function bridgeStatus(runtime: NativeRuntime): BridgeStatus {
  const { config } = runtime;
  return {
    app: "talon-bridge",
    protocol: BRIDGE_PROTOCOL_VERSION,
    // "attachments": /upload streams any file type and /send takes an
    // `attachments` list, so a client can stage several files per message.
    // "commands": `/send` answers slash commands itself and `GET /commands`
    // lists them for autocomplete.
    capabilities: [
      "mesh",
      "mesh-commands",
      "plugins-skills",
      "attachments",
      "commands",
    ],
    botName: runtime.botName,
    backend: config.backend,
    model: resolveModel(config.model)?.displayName ?? config.model,
    activeChats: runtime.chats.count(),
    startedAt: runtime.startedAt,
  };
}

export function broadcastStatus(runtime: NativeRuntime): void {
  runtime.broadcast({ kind: "status", status: bridgeStatus(runtime) });
}
