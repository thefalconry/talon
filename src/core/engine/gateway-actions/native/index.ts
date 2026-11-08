/**
 * Native tools — Talon's own shell/filesystem tools, replacing the SDK's
 * built-in Bash/Read/Write/Edit/Glob/Grep when `config.nativeTools` is on.
 *
 * Their defining feature: every one checks the current chat's active
 * `teleport` target. With no teleport for that chat, they run on the daemon
 * host (local spawn / local fs / local ripgrep). With a teleport engaged, they
 * run ON the companion device via the mesh exec/fs channel — so
 * `bash`/`read`/`write`/… transparently operate on the phone for that chat.
 *
 *   teleport(device)  → native tools target that device
 *   teleport_back()   → native tools run locally again
 *
 * The teleported path reuses the exec/fs command surface on MeshService; the
 * local path is a thin, well-scoped reimplementation of the built-ins.
 *
 * One module per concern; this file is only the registry:
 *
 *   - `teleport`        — teleport / teleport_back
 *   - `exec`            — native_bash (dispatch + local foreground run)
 *   - `exec-background` — the detached background launch
 *   - `exec-remote`     — the on-device run over the mesh exec channel
 *   - `read`            — native_read
 *   - `write`           — native_write / native_edit
 *   - `search`          — native_glob / native_search
 *
 * The spread order below reproduces the key order of the single object
 * literal these came from. Action names are the model's tool vocabulary and
 * sit in the prompt-cache prefix via the tool descriptions, so neither the
 * names nor their order may change (pinned by native-tools.test.ts).
 */

import { teleportHandlers } from "./teleport.js";
import { execHandlers } from "./exec.js";
import { readHandlers } from "./read.js";
import { writeHandlers } from "./write.js";
import { searchHandlers } from "./search.js";
import type { SharedActionHandlers } from "../types.js";
import type { ActionResult } from "../../../types.js";

export const nativeHandlers: SharedActionHandlers = {
  ...teleportHandlers,
  ...execHandlers,
  ...readHandlers,
  ...writeHandlers,
  ...searchHandlers,
};

/**
 * Whether the native tool actions may run at all. Off unless
 * `config.nativeTools` turns them on (bootstrap calls the setter): with the
 * option off the tools are never offered to the model, so a request for
 * one can only come from outside the daemon's own tool surface.
 */
let nativeToolsEnabled = false;

export function setNativeToolsEnabled(enabled: boolean): void {
  nativeToolsEnabled = enabled;
}

/** The refusal for a native action while native tools are off, else null. */
export function nativeActionRefusal(action: string): ActionResult | null {
  if (nativeToolsEnabled || !Object.hasOwn(nativeHandlers, action)) {
    return null;
  }
  return {
    ok: false,
    error: `${action} is unavailable: native tools are disabled (set "nativeTools": true in config.json to enable them).`,
  };
}
