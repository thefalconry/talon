/**
 * talon-fusefs — TypeScript boundary over the FUSE addon
 * (native/talon-fusefs, `bin/talon-fusefs.node`).
 *
 * The addon mounts the talon:// namespace at ~/.talon/ns while the
 * daemon runs: file-backed mounts are served as symlinks (the kernel
 * follows them — heavy file I/O never crosses the FUSE boundary) and
 * synthetic mounts (proc/, plugins/) are served live through a
 * threadsafe callback bridge into the JS Vfs.
 *
 * Per-arch artifact like blake3-napi: present on binary-channel and
 * source installs, absent otherwise — absence simply means the FUSE
 * layer is off and the namespace falls back to the symlink farm.
 * `TALON_FUSEFS_NODE` overrides the location, `TALON_NO_FUSEFS=1`
 * disables it. Linux-only: fuser's pure-Rust mount path (no libfuse
 * link) needs only /dev/fuse + fusermount3 at runtime.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { logDebug, logWarn } from "../util/log.js";

/** One root symlink entry the mount serves (a file-backed mount). */
interface FuseSymlinkSpec {
  name: string;
  target: string;
}

/**
 * A bridge request from the FUSE thread. Answer by calling `reply(id,
 * json)` — every request MUST be answered or the kernel caller waits
 * out the addon's internal timeout and gets EIO. `path` is
 * namespace-relative ("proc/tasks/7"). The reply JSON shapes are
 * defined by `serveNamespaceRequest` in core/vfs/fusefs.ts.
 */
type FuseBridgeHandler = (id: number, op: string, path: string) => void;

/** The N-API surface exported by native/talon-fusefs. */
export interface NativeFuseFs {
  version(): string;
  /**
   * Mount at `mountpoint` and return once the kernel accepted the
   * mount. Throws when mounting fails (no /dev/fuse, no fusermount,
   * mountpoint busy). The FUSE session runs on its own thread until
   * `unmount()`.
   */
  mount(
    mountpoint: string,
    symlinks: FuseSymlinkSpec[],
    synthetic: string[],
    onRequest: FuseBridgeHandler,
  ): void;
  /** Answer a bridge request. Unknown/expired ids are ignored. */
  reply(id: number, json: string): void;
  /** Tear the mount down. Idempotent. */
  unmount(): void;
}

let addon: NativeFuseFs | null | undefined;

/** Resolve the addon, or null when the FUSE layer must stay off. */
export function nativeFuseFs(): NativeFuseFs | null {
  if (addon === undefined) addon = loadNativeFuseFs();
  return addon;
}

function loadNativeFuseFs(): NativeFuseFs | null {
  if (process.env.TALON_NO_FUSEFS === "1") return null;

  let candidate = process.env.TALON_FUSEFS_NODE;
  if (!candidate) {
    try {
      // Beside bin/talon.js — where build:fusefs and packaging put it.
      // Throws under bun single-binary builds (no real fs URL): those
      // ship through channels that set TALON_FUSEFS_NODE, or fall back.
      candidate = fileURLToPath(
        new URL("../../bin/talon-fusefs.node", import.meta.url),
      );
    } catch {
      return null;
    }
  }
  try {
    const requireAddon = createRequire(import.meta.url);
    const loaded = requireAddon(candidate) as NativeFuseFs;
    // Trust nothing that can't state its version — a truncated or
    // wrong-arch artifact fails here and the FUSE layer stays off.
    if (typeof loaded.version() !== "string") {
      reportAddonRejected(candidate, "no version");
      return null;
    }
    return loaded;
  } catch (err) {
    reportAddonRejected(candidate, err);
    return null;
  }
}

/**
 * The FUSE layer stays off either way; the log says why. An absent
 * default artifact is normal off-Linux or on npm installs; an explicit
 * TALON_FUSEFS_NODE that fails to load is config not taking effect.
 */
function reportAddonRejected(candidate: string, reason: unknown): void {
  const code = (reason as { code?: unknown } | null)?.code;
  const why = reason instanceof Error ? reason.message : String(reason);
  if (process.env.TALON_FUSEFS_NODE) {
    logWarn(
      "fusefs",
      `TALON_FUSEFS_NODE addon rejected, FUSE off path=${candidate}: ${why}`,
    );
  } else if (code !== "MODULE_NOT_FOUND") {
    logDebug("fusefs", `addon rejected, FUSE off path=${candidate}: ${why}`);
  }
}
