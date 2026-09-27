/**
 * Teleport control — which host the native tools in this directory target.
 *
 *   teleport(device)  → native tools run ON that companion device
 *   teleport_back()   → native tools run on the daemon host again
 */

import { getMeshService } from "../../../mesh/index.js";
import { clearTeleport, setTeleport } from "../../../mesh/devices/teleport.js";
import type { Result } from "./results.js";
import type { SharedActionHandlers } from "../types.js";

export const teleportHandlers: SharedActionHandlers = {
  teleport: (body, chatId) => teleport(chatId, body.device ?? body.deviceId),
  teleport_back: (_body, chatId) => teleportBack(chatId),
};

async function teleport(chatId: number, query: unknown): Promise<Result> {
  const svc = getMeshService();
  await svc.list();
  const resolved = svc.resolveDevice(query);
  if ("error" in resolved) return { ok: false, text: resolved.error };
  const target = resolved.target;
  if (!target.online) {
    return {
      ok: false,
      text: `${target.name} appears offline — cannot teleport onto a device that isn't connected.`,
    };
  }
  if (target.capabilities && !target.capabilities.includes("exec")) {
    return {
      ok: false,
      text: `${target.name} does not advertise the "exec" capability, so teleport can't run commands on it.`,
    };
  }
  await setTeleport(chatId, target.id, target.name);
  return {
    ok: true,
    text: [
      `🛰️ Teleported onto ${target.name}. Native bash/read/write/edit/glob/search now run ON that device.`,
      `Working dir starts at the device default; \`cd\` in bash persists across calls.`,
      `Call teleport_back to return to the daemon host.`,
    ].join(" "),
  };
}

async function teleportBack(chatId: number): Promise<Result> {
  const prior = await clearTeleport(chatId);
  return {
    ok: true,
    text: prior
      ? `↩️ Teleported back from ${prior.deviceName}. Native tools run on the daemon host again.`
      : "Not teleported — native tools already run on the daemon host.",
  };
}
