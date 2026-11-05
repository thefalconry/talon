/**
 * `native_bash` on a teleported device — dispatched over the mesh exec
 * channel.
 *
 * The command is wrapped so the shell's resulting working directory comes
 * back in markers and persists across calls (a `cd` carries forward) without
 * disturbing the real exit code. glob/search reuse this path for their
 * on-device rg/find/grep fallbacks.
 */

import { getMeshService } from "../../../mesh/index.js";
import { getTeleport, setTeleportCwd } from "../../../mesh/devices/teleport.js";
import { renderExec, type Result } from "./results.js";
import { shellQuote } from "./shell.js";

/** Same self-correction hint, phrased for a teleported (on-device) run. */
const TELEPORT_TIMEOUT_HINT =
  "(Streaming/never-ending commands can't ride a teleported foreground call — " +
  "background it in-shell instead: `cmd > /tmp/out.log 2>&1 &`, then poll the log " +
  "with read, or bound the command itself: `logcat -d`, `timeout 30 …`, `head -n 200`.)";
/** Markers used to recover the post-command working dir from a teleport shell. */
const CWD_OPEN = "__TALON_CWD__";
const CWD_CLOSE = "__TALON_CWD_END__";

function stripCwdMarker(stdout: string): string {
  const open = stdout.lastIndexOf(CWD_OPEN);
  return open === -1 ? stdout : stdout.slice(0, open);
}

export async function bashTeleported(
  chatId: number,
  deviceId: string,
  cmd: string,
  timeoutMs: number,
  /** Keep the command running past its budget, on devices that can. */
  detachAtBudget = false,
): Promise<Result> {
  const mesh = getMeshService();
  const detach = detachAtBudget && (await mesh.canDetachExec(deviceId));
  const active = await getTeleport(chatId);
  const cwd = active?.cwd;
  // Wrap so the resulting working dir is reported back and persists across
  // calls (a `cd` in `cmd` carries forward), while the real exit code is
  // preserved. printf can't fail in a way that masks the command's status.
  const wrapped =
    `${cwd ? `cd ${shellQuote(cwd)} 2>/dev/null; ` : ""}` +
    `{ ${cmd}\n}; __talon_rc=$?; ` +
    `printf '${CWD_OPEN}%s${CWD_CLOSE}' "$(pwd 2>/dev/null)"; exit $__talon_rc`;
  const dispatched = await mesh.dispatchCommand(
    deviceId,
    "exec",
    { cmd: wrapped, timeoutMs, ...(detach ? { detachOnTimeout: true } : {}) },
    timeoutMs + 5_000,
  );
  if ("error" in dispatched) return { ok: false, text: dispatched.error };
  const { target, result } = dispatched;
  const detached = mesh.adoptDetachedExec(
    target,
    result,
    cmd,
    timeoutMs,
    String(chatId),
    stripCwdMarker,
  );
  if (detached !== null) {
    return {
      ok: true,
      text: `${detached}\nA cd inside this command won't carry over to later calls.`,
    };
  }
  const data = result.data ?? {};
  let stdout = typeof data.stdout === "string" ? data.stdout : "";
  const stderr = typeof data.stderr === "string" ? data.stderr : "";
  const via =
    typeof data.via === "string" && data.via ? ` via ${data.via}` : "";
  const exitCode =
    typeof data.exitCode === "number" ? data.exitCode : undefined;
  // Recover + strip the trailing cwd marker.
  const open = stdout.lastIndexOf(CWD_OPEN);
  if (open !== -1) {
    const close = stdout.indexOf(CWD_CLOSE, open);
    if (close !== -1) {
      const newCwd = stdout.slice(open + CWD_OPEN.length, close).trim();
      stdout = stdout.slice(0, open);
      if (newCwd) await setTeleportCwd(chatId, newCwd);
    }
  }
  if (!result.ok && exitCode === undefined) {
    return {
      ok: false,
      text: result.message ?? `${target.name} could not run the command.`,
    };
  }
  // The device marks a command it had to kill at its own exec budget with
  // this stderr marker (see the companion's device_exec) — surface the same
  // self-correction hint the local timeout path gets.
  const timedOutOnDevice = stderr.includes("[killed: timeout]");
  const body = renderExec(
    `${target.name}${via}`,
    `exit ${exitCode ?? "?"}`,
    stdout,
    stderr,
  );
  return {
    ok: exitCode === 0,
    text: timedOutOnDevice ? `${body}\n${TELEPORT_TIMEOUT_HINT}` : body,
  };
}
