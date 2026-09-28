/**
 * Device mesh — read tools (list_devices, get_device_location,
 * get_device_history) and command tools (ring, live status).
 *
 * Shared actions, so the model has full mesh access from every frontend
 * (Telegram, Discord, Teams, terminal, native) — not just chats running
 * through the native bridge. The mesh itself is daemon-wide state
 * (core/mesh); the native bridge is merely the transport companions
 * register through and commands travel over.
 */

import { getMeshService } from "../../mesh/index.js";
import type { SharedActionHandlers } from "./types.js";

export const meshHandlers: SharedActionHandlers = {
  list_devices: () => getMeshService().describeDevices(),
  get_device_location: (body) =>
    getMeshService().locateDevice(body.device ?? body.deviceId),
  get_device_history: (body) =>
    getMeshService().deviceHistory(body.device ?? body.deviceId, body.hours),
  ring_device: (body) =>
    getMeshService().ringDevice(body.device ?? body.deviceId, body.message),
  // Registry hygiene: drop a stale/superseded device entry. Requires an
  // explicit target — a destructive action must never default-pick a device.
  remove_device: (body) =>
    getMeshService().removeDevice(body.device ?? body.deviceId),
  get_device_status: (body) =>
    getMeshService().getDeviceStatus(body.device ?? body.deviceId),
  // Exec + filesystem surface — the substrate teleport routes through.
  device_exec: (body) =>
    getMeshService().execOnDevice(
      body.device ?? body.deviceId,
      body.cmd,
      body.cwd,
      body.timeout_sec,
    ),
  device_list_dir: (body) =>
    getMeshService().listDirOnDevice(body.device ?? body.deviceId, body.path),
  device_stat: (body) =>
    getMeshService().statOnDevice(body.device ?? body.deviceId, body.path),
  device_read_file: (body) =>
    getMeshService().readFileFromDevice(
      body.device ?? body.deviceId,
      body.path,
    ),
  device_write_file: (body) =>
    getMeshService().writeFileToDevice(
      body.device ?? body.deviceId,
      body.path,
      body.content,
    ),
  device_pull_file: (body) =>
    getMeshService().pullFileFromDevice(
      body.device ?? body.deviceId,
      body.remote_path,
      body.local_path,
    ),
  device_push_file: (body) =>
    getMeshService().pushFileToDevice(
      body.device ?? body.deviceId,
      body.local_path,
      body.remote_path,
    ),
  // Remote self-update: push a new APK and silently (re)install it, keeping
  // the mesh connection across the app restart.
  update_device: (body) =>
    getMeshService().updateDeviceApp(
      body.device ?? body.deviceId,
      body.apk_path,
      body.remote_path,
      body.allow_downgrade,
    ),
  // Remote self-update for a headless talon-node: push a new binary and have
  // the node verify, swap, and restart into it. binary_path is optional —
  // omitted, the daemon resolves the right build for the node's
  // platform/arch itself (source build or verified release download).
  update_node: (body) =>
    getMeshService().updateNodeBinary(
      body.device ?? body.deviceId,
      body.binary_path,
      body.remote_path,
      body.allow_downgrade,
    ),
  // Node provisioning: materialize a talon-node binary for any arch, and
  // mint single-use bridge-served install links for fresh hosts.
  get_node_binary: (body) => getMeshService().getNodeBinary(body.os, body.arch),
  make_node_install_link: (body) =>
    getMeshService().makeNodeInstallLink(
      body.os,
      body.arch,
      body.name,
      body.bridge_url,
    ),
};

/**
 * Mesh actions are chat-free: every handler above reads `body` and the
 * daemon-wide mesh registry, and not one of them takes the `chatId` the
 * gateway threads through. Requiring an active chat context to reach them is
 * therefore incidental to the transport, not a property of the action — and
 * it makes the whole mesh unreachable from heartbeat/background runs, which
 * have no ambient chat and no `chat_id` parameter on these tools to promote.
 *
 * The gateway consults this set before chat resolution so `list_devices`,
 * `device_exec` and friends work from any run mode. Kept as an explicit
 * export (rather than `Object.keys(meshHandlers)`) so adding a handler that
 * *does* need a chat is a deliberate opt-out rather than a silent inclusion.
 */
export const chatFreeActions: ReadonlySet<string> = new Set([
  "list_devices",
  "get_device_location",
  "get_device_history",
  "ring_device",
  "remove_device",
  "get_device_status",
  "device_exec",
  "device_list_dir",
  "device_stat",
  "device_read_file",
  "device_write_file",
  "device_pull_file",
  "device_push_file",
  "update_device",
  "update_node",
  "get_node_binary",
  "make_node_install_link",
]);
