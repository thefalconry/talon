/**
 * The bridge as the mesh's transport: locates and device commands (from ANY
 * frontend's mesh tool calls) leave as SSE events.
 *
 * A locate is a bare "who's there?" — no secret in the frame, and
 * pre-command app builds rely on receiving it — so it still fans out.
 * A command is the opposite: its params carry transfer tokens, exec
 * command lines and (on the chunked fallback) file bodies, so it goes
 * to the target device's own client(s) only.
 *
 * A command for a device that is between streams (reconnecting after a
 * daemon restart or a network change) is reported undelivered, and the
 * mesh holds it; when that device's stream comes back the bridge says so
 * and the mesh offers the command again.
 */

import type { NativeRuntime } from "./runtime.js";
import type { BridgeServer } from "./bridge/server.js";

export function registerMeshTransport(
  runtime: Pick<NativeRuntime, "mesh" | "broadcast">,
  server: Pick<BridgeServer, "sendToDevice" | "onDeviceStream">,
): () => void {
  const { mesh } = runtime;
  const detachTransport = mesh.registerTransport({
    locate: (deviceId) => runtime.broadcast({ kind: "locate", deviceId }),
    command: (command) =>
      server.sendToDevice(command.deviceId, {
        kind: "device_command",
        id: command.id,
        deviceId: command.deviceId,
        name: command.name,
        params: command.params,
      }) !== "none",
  });
  const detachStreams = server.onDeviceStream((deviceId) =>
    mesh.deviceConnected(deviceId),
  );
  return () => {
    detachStreams();
    detachTransport();
  };
}
