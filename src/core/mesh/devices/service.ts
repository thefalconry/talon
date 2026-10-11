/**
 * MeshService — the daemon-wide device-mesh facade.
 *
 * One instance serves every consumer in the process:
 *
 *   - Transports (the native bridge server) feed it registrations, location
 *     reports, and command results, and plug in a MeshTransport so locate
 *     requests and device commands reach connected companion apps. The
 *     service never imports a transport — dependencies point inward.
 *   - The model reads and drives it through the shared mesh gateway actions
 *     (list_devices, get_device_location, get_device_history, ring_device,
 *     get_device_status), so full mesh access works identically from
 *     Telegram, Discord, Teams, terminal, and native chats — the mesh is
 *     daemon state, not a native-frontend feature.
 *
 * Two request/response flows ride the same SSE-out / HTTP-POST-back loop:
 *
 *   locate   → `locate` event   → device POSTs /location            (legacy,
 *              kept verbatim so pre-command app builds keep working)
 *   command  → `device_command` → device POSTs /devices/command-result with
 *              the command's correlation id; sendCommand resolves the
 *              pending promise or times out.
 *
 * With no transport registered (daemon running without the native bridge),
 * everything degrades gracefully: locate answers from the last persisted
 * fix immediately, and commands fail fast with a clear explanation.
 *
 * The service keeps the registry, the transport fan-out, the command
 * channel, device resolution, and the model-facing summaries. Two
 * collaborators own the rest and are reached through thin delegations so
 * the public surface stays one object: {@link DeviceFiles} (chunked and
 * streamed file transfer, the companion/node self-update flows) and
 * {@link BridgeLinks} (node provisioning, companion pairing, reachability).
 */

import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { clampExecOutput } from "../../../util/exec-output.js";
import { BridgeLinks, type MeshBridgeInfo } from "../links/bridge-links.js";
import {
  age,
  formatBytes,
  FS_COMMAND_TIMEOUT_MS,
  requirePath,
  type MeshToolResult,
} from "../tool-surface.js";
import { DeviceFiles } from "../transfers/device-files.js";
import {
  resolveNodeBinary,
  type NodeBinaryResolver,
} from "../links/node-binaries.js";
import {
  COMPUTER_COMMAND_TIMEOUT_MS,
  computerCommandParams,
  formatComputerResult,
} from "./computer.js";
import { MeshRegistry } from "./registry.js";
import {
  auditErrorText,
  auditIssuer,
  hashCommandArgs,
  MeshAuditLog,
  type MeshAuditEntry,
  type MeshAuditQuery,
} from "../audit.js";
import { logDebug, logWarn } from "../../../util/log.js";
import {
  DeviceCredentialStore,
  type CredentialAdminContext,
} from "../credentials/index.js";
import type {
  DeviceCommand,
  DeviceCommandResult,
  DeviceInfo,
  DeviceLocation,
} from "../types.js";

/** How a transport pushes mesh traffic to connected companion devices. */
export type MeshTransport = {
  /** Ask one device (or all, when undefined) for a fresh location fix. */
  locate(deviceId?: string): void;
  /**
   * Deliver an on-demand command to its target device. Return `false` when
   * the device has no live connection on this transport right now (it is
   * reconnecting): the mesh then holds the command and offers it again on
   * `MeshService.deviceConnected`. Anything else counts as handed off.
   */
  command(command: DeviceCommand): boolean | void;
};

/** Outcome of pinging one device (see {@link MeshService.pingAll}). */
export type MeshPingResult = {
  device: DeviceInfo;
  /** True when the device answered the probe (offline devices are false). */
  reachable: boolean;
  /** Round-trip time of the probe, present only when reachable. */
  latencyMs?: number;
  /** Why the probe didn't land (offline, no transport, timeout). */
  error?: string;
};

export type MeshServiceOptions = {
  /** How long a locate waits for a fresh fix before last-known fallback. */
  freshFixTimeoutMs?: number;
  /** Upper bound between staleness re-checks while waiting. */
  pollIntervalMs?: number;
  /** How long a device command waits for its result before timing out. */
  commandTimeoutMs?: number;
  /** How often a long command re-checks that its device is still present. */
  presenceWatchIntervalMs?: number;
  /**
   * How long an undelivered command (no transport has a live connection to
   * its device) waits for the device to reconnect before failing. Default
   * {@link DEFAULT_COMMAND_HOLD_MS}; 0 fails it at once.
   */
  commandHoldMs?: number;
  /** Node-binary resolver override (tests — the real one builds/downloads). */
  nodeBinaryResolver?: NodeBinaryResolver;
  /**
   * Per-device credential store. With one, pairing links and installers
   * carry a device's own credential and removing a device revokes it;
   * without one (tests, embedders) links carry the shared bridge token.
   */
  credentials?: DeviceCredentialStore;
  /**
   * Where every dispatched command is recorded (who, which device, which
   * command, an args hash, outcome, duration). Absent (tests, embedders) =
   * nothing is recorded.
   */
  audit?: MeshAuditLog;
};

const DEFAULT_FRESH_FIX_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 12_000;
/**
 * Default hold for a command whose device is between connections. Nodes are
 * back within ~1–16 s of a daemon restart; the companion's first retry
 * lands in a few seconds. Longer than that and the device is not coming
 * back soon, so the caller is better served by a clear failure.
 */
const DEFAULT_COMMAND_HOLD_MS = 20_000;
const MOBILE_PLATFORMS = new Set(["android", "ios"]);
const DEFAULT_HISTORY_HOURS = 24;
const MAX_HISTORY_LINES = 24;

// ── Exec / filesystem channel ───────────────────────────────────────────────
/** Default wall-clock budget for a remote shell command. */
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
/** Hard ceiling on a caller-requested exec timeout. */
const MAX_EXEC_TIMEOUT_MS = 300_000;
/** How often a long-running command re-checks that its device is still up. */
const PRESENCE_WATCH_INTERVAL_MS = 15_000;
export class MeshService {
  private readonly waiters = new Set<() => void>();
  private readonly transports = new Set<MeshTransport>();
  private readonly pendingCommands = new Map<
    string,
    {
      deviceId: string;
      resolve: (result: DeviceCommandResult) => void;
    }
  >();
  /**
   * Commands no transport could deliver yet, by id, in send order. Each is
   * also in `pendingCommands`; `deviceConnected` offers it again, and its
   * hold timer fails it when the device stays away.
   */
  private readonly heldCommands = new Map<string, DeviceCommand>();
  /**
   * Server-side receipt time (this process's clock) of the last fix per
   * device. Freshness is judged against THIS, never the device-supplied
   * `loc.ts` — a companion whose clock runs behind would otherwise have
   * genuinely fresh fixes rejected (every locate burning the full timeout),
   * and one running ahead would have stale fixes accepted as fresh.
   */
  private readonly receivedAt = new Map<string, number>();
  private readonly resolveNode: NodeBinaryResolver;
  /** Chunked + streamed file transfer and the self-update flows. */
  private readonly files: DeviceFiles;
  /** Node provisioning, companion pairing, and bridge reachability. */
  private readonly links: BridgeLinks;
  private readonly freshFixTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly commandTimeoutMs: number;
  private readonly presenceWatchIntervalMs: number;
  private commandHoldMs: number;
  private loading: Promise<void> | null = null;
  /** Per-device credentials (null = shared-token-only mesh). */
  readonly credentials: DeviceCredentialStore | null;
  /** The command audit (null = commands are not recorded). */
  private readonly audit: MeshAuditLog | null;
  /** `native.legacySharedToken` as the bridge last reported it. */
  private legacySharedToken = true;

  constructor(
    private readonly registry = new MeshRegistry(),
    options: MeshServiceOptions = {},
  ) {
    this.freshFixTimeoutMs =
      options.freshFixTimeoutMs ?? DEFAULT_FRESH_FIX_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.commandTimeoutMs =
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.presenceWatchIntervalMs =
      options.presenceWatchIntervalMs ?? PRESENCE_WATCH_INTERVAL_MS;
    this.commandHoldMs = options.commandHoldMs ?? DEFAULT_COMMAND_HOLD_MS;
    this.resolveNode = options.nodeBinaryResolver ?? resolveNodeBinary;
    this.files = new DeviceFiles({
      load: () => this.load(),
      resolveDevice: (query) => this.resolveDevice(query),
      dispatchCommand: (query, name, params, timeoutMs) =>
        this.dispatchCommand(query, name, params, timeoutMs),
      commandTimeoutMs: this.commandTimeoutMs,
      resolveNode: this.resolveNode,
    });
    this.credentials = options.credentials ?? null;
    this.audit = options.audit ?? null;
    const store = this.credentials;
    this.links = new BridgeLinks(
      this.resolveNode,
      store
        ? (scopes, origin) =>
            store.mintNow({ deviceId: null, scopes, origin }).token
        : undefined,
    );
  }

  /**
   * `native.commandHoldMs`: how long an undelivered command waits for its
   * device to reconnect. Undefined restores the default.
   */
  setCommandHoldMs(ms: number | undefined): void {
    this.commandHoldMs = Math.max(0, ms ?? DEFAULT_COMMAND_HOLD_MS);
  }

  /**
   * A transport reports that `deviceId` has a live connection again. Every
   * command held for it is offered once more, oldest first; one that is
   * still not taken stays held until its window ends.
   */
  deviceConnected(deviceId: string): void {
    for (const [id, command] of Array.from(this.heldCommands)) {
      if (command.deviceId !== deviceId) continue;
      if (this.dispatchToTransports(command)) {
        this.heldCommands.delete(id);
        logDebug(
          "mesh",
          `mesh.command event=flushed device=${deviceId} command=${command.name} id=${id}`,
        );
      }
    }
  }

  /** The native bridge reports its reachable identity here (null on stop). */
  setBridgeInfo(info: MeshBridgeInfo | null): void {
    this.links.setBridgeInfo(info);
    this.legacySharedToken = info?.legacySharedToken ?? true;
  }

  /**
   * What `talon mesh` operates on, or null for a shared-token-only mesh.
   * Resolves registry names to ids, so callers should `load()` first.
   */
  credentialAdminContext(): CredentialAdminContext | null {
    const store = this.credentials;
    if (!store) return null;
    return {
      store,
      resolveDeviceId: (query) => {
        const resolved = this.resolveDevice(query);
        return "error" in resolved ? undefined : resolved.target.id;
      },
      legacySharedToken: () => this.legacySharedToken,
    };
  }

  /** Hydrate persisted devices/locations. Idempotent — safe to await from
   *  every entry point; the first caller does the read, the rest share it. */
  load(): Promise<void> {
    this.loading ??= Promise.all([
      this.registry.load(),
      this.credentials?.load(),
    ]).then(() => undefined);
    return this.loading;
  }

  /**
   * Plug a transport in. Returns an unsubscribe so the transport detaches
   * cleanly on shutdown (no stale broadcasts into a stopped server).
   */
  registerTransport(transport: MeshTransport): () => void {
    this.transports.add(transport);
    return () => this.transports.delete(transport);
  }

  /** Fan a locate request out to every transport. True when at least one
   *  transport is attached (i.e. waiting for a fresh fix can pay off). */
  requestLocate(deviceId?: string): boolean {
    for (const transport of this.transports) {
      try {
        transport.locate(deviceId);
      } catch {
        // One broken transport must not stop the others.
      }
    }
    return this.transports.size > 0;
  }

  async register(
    body: Record<string, unknown>,
    now?: number,
  ): Promise<DeviceInfo> {
    await this.load();
    return this.registry.register(body, now);
  }

  /** Store a reported fix and wake anyone waiting on a fresh location. */
  async storeLocation(body: Record<string, unknown>): Promise<DeviceLocation> {
    await this.load();
    const loc = await this.registry.storeLocation(body);
    // Stamp arrival against our own clock so waitForFreshLocation is immune
    // to device clock skew.
    this.receivedAt.set(loc.deviceId, Date.now());
    // Snapshot: a notified waiter removes itself (and new waiters may be
    // added) mid-iteration — iterate a copy, not the live set.
    for (const notify of Array.from(this.waiters)) notify();
    return loc;
  }

  async list(): Promise<{
    devices: DeviceInfo[];
    locations: DeviceLocation[];
  }> {
    await this.load();
    return this.registry.list();
  }

  async getLocation(deviceId: string): Promise<DeviceLocation | undefined> {
    await this.load();
    return this.registry.getLocation(deviceId);
  }

  // ── Command channel ────────────────────────────────────────────────────────

  /**
   * A device answered a command (bridge route POST /devices/command-result).
   * Resolves the pending sendCommand; false when nothing was waiting (late
   * or unknown correlation id — harmless, just ignored).
   *
   * The result must come from the device the command was sent to: a reply
   * whose deviceId names a DIFFERENT device is dropped (a confused or
   * misbehaving companion must not be able to answer for its peers).
   *
   * An ABSENT deviceId is dropped too: omitting the field would skip the
   * ownership check, which is exactly what a spoofer would do to feed the
   * model fabricated exec stdout or a fake install success. Accepting it
   * when only one command is pending still cannot attribute the reply — it
   * only narrows the window to whenever the mesh is idle. `deviceId` is part
   * of the command-result wire contract (protocol/fixtures/mesh_v1.json) and
   * every shipped client sends it, so an unattributable reply is left to
   * time out with "did not answer" rather than resolving with someone's data.
   */
  completeCommand(body: Record<string, unknown>): boolean {
    const commandId = typeof body.commandId === "string" ? body.commandId : "";
    const pending = this.pendingCommands.get(commandId);
    if (!pending) return false;
    const from = typeof body.deviceId === "string" ? body.deviceId : "";
    if (from !== pending.deviceId) return false;
    const { resolve } = pending;
    this.pendingCommands.delete(commandId);
    resolve({
      commandId,
      deviceId: from,
      ok: body.ok === true,
      ...(typeof body.message === "string" && body.message.trim()
        ? { message: body.message.trim().slice(0, 2_000) }
        : {}),
      ...(body.data &&
      typeof body.data === "object" &&
      !Array.isArray(body.data)
        ? { data: body.data as Record<string, unknown> }
        : {}),
    });
    return true;
  }

  /** Resolve every command still waiting on `deviceId` as failed. */
  private failPendingCommands(deviceId: string, message: string): void {
    for (const [commandId, pending] of this.pendingCommands) {
      if (pending.deviceId !== deviceId) continue;
      this.pendingCommands.delete(commandId);
      pending.resolve({ commandId, deviceId, ok: false, message });
    }
  }

  /**
   * Fail a pending command early when its device stops heartbeating.
   *
   * A device that drops mid-command will never answer, so waiting out the
   * remaining budget only buys silence — and on a transfer budget that
   * silence is minutes of a tool call, and therefore a chat, wedged behind
   * a device that is plainly gone. Presence is derived from `lastSeen`, so
   * this reports one presence grace period after the device goes quiet
   * rather than instantly; short budgets aren't watched at all, since their
   * own timeout lands first. Returns a stop function.
   */
  private watchPresence(
    deviceId: string,
    timeoutMs: number,
    onGone: (device: DeviceInfo) => void,
  ): () => void {
    const every = this.presenceWatchIntervalMs;
    if (timeoutMs <= every) return () => {};
    const timer = setInterval(() => {
      const current = this.registry
        .list()
        .devices.find((d) => d.id === deviceId);
      // Unknown device: leave it to the timeout — an entry evicted from the
      // registry is not evidence that the device stopped answering.
      if (!current || current.online) return;
      clearInterval(timer);
      onGone(current);
    }, every);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * Push one command to a device and await its result (or time out). The
   * low-level primitive under every command tool; exposed for tests and
   * future tools. Every dispatch lands in the command audit.
   */
  sendCommand(
    device: DeviceInfo,
    name: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.commandTimeoutMs,
  ): Promise<DeviceCommandResult> {
    const finishAudit = this.beginAudit(device, name, params);
    const pending = this.deliverCommand(device, name, params, timeoutMs);
    if (!finishAudit) return pending;
    // The delivery promise only ever resolves, so this adds no rejection.
    return pending.then((result) => {
      finishAudit(result);
      return result;
    });
  }

  /**
   * Open the audit record for one dispatch. The issuer is read now, while
   * the issuing turn's scope is live. Returns the completion hook, or null
   * when nothing is audited. Never throws: a broken audit must not stop a
   * command.
   */
  private beginAudit(
    device: DeviceInfo,
    name: string,
    params: Record<string, unknown>,
  ): ((result: DeviceCommandResult) => void) | null {
    const audit = this.audit;
    if (!audit) return null;
    try {
      const startedAt = Date.now();
      const base = {
        time: new Date(startedAt).toISOString(),
        issuer: auditIssuer(),
        deviceId: device.id,
        deviceName: device.name,
        command: name,
        argsHash: hashCommandArgs(params),
      };
      return (result) => {
        try {
          audit.record({
            ...base,
            ok: result.ok,
            ...(result.ok ? {} : { error: auditErrorText(result.message) }),
            durationMs: Date.now() - startedAt,
          });
        } catch (err) {
          logWarn("mesh", `mesh.audit event=record_failed err=${String(err)}`);
        }
      };
    } catch (err) {
      logWarn("mesh", `mesh.audit event=record_failed err=${String(err)}`);
      return null;
    }
  }

  /** `talon mesh audit`: the newest recorded dispatches, oldest first. */
  readAudit(query: MeshAuditQuery = {}): Promise<MeshAuditEntry[]> {
    return this.audit ? this.audit.read(query) : Promise.resolve([]);
  }

  /**
   * Deliver one command; resolves with its result, a timeout, or a loss.
   *
   * When no transport has a live connection to the device (it is between
   * streams: a daemon restart, a network change), the command is held for
   * `commandHoldMs` and sent the moment the device reconnects
   * (`deviceConnected`). If it does not come back in that window the
   * command fails then, saying it was never delivered, instead of waiting
   * out its whole timeout for an answer that cannot come.
   */
  private deliverCommand(
    device: DeviceInfo,
    name: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<DeviceCommandResult> {
    const command: DeviceCommand = {
      id: randomUUID(),
      deviceId: device.id,
      name,
      params,
    };
    const holdMs = Math.min(this.commandHoldMs, timeoutMs);
    const undelivered = (): string =>
      `${device.name} has no live connection to the bridge` +
      (holdMs > 0
        ? ` and did not reconnect within ${Math.round(holdMs / 1000)}s`
        : "") +
      `, so "${name}" was not delivered.`;
    return new Promise<DeviceCommandResult>((resolve) => {
      let settled = false;
      let stopWatch: () => void = () => {};
      let holdTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: DeviceCommandResult): void => {
        if (settled) return;
        settled = true;
        this.pendingCommands.delete(command.id);
        this.heldCommands.delete(command.id);
        clearTimeout(timer);
        clearTimeout(holdTimer);
        stopWatch();
        resolve(result);
      };
      const fail = (message: string): void =>
        finish({
          commandId: command.id,
          deviceId: device.id,
          ok: false,
          message,
        });
      const timer = setTimeout(() => {
        fail(
          this.heldCommands.has(command.id)
            ? undelivered()
            : `${device.name} did not answer within ${Math.round(timeoutMs / 1000)}s (device ${device.online ? "was online" : "appears offline"}).`,
        );
      }, timeoutMs);
      timer.unref?.();
      stopWatch = this.watchPresence(device.id, timeoutMs, (current) => {
        fail(
          `${device.name} went offline (last seen ${age(Date.now() - current.lastSeen)}) before answering "${name}".`,
        );
      });
      this.pendingCommands.set(command.id, {
        deviceId: device.id,
        resolve: finish,
      });
      if (this.dispatchToTransports(command) || settled) return;
      this.heldCommands.set(command.id, command);
      logDebug(
        "mesh",
        `mesh.command event=held device=${device.id} command=${name} id=${command.id} holdMs=${holdMs}`,
      );
      holdTimer = setTimeout(() => {
        if (this.heldCommands.has(command.id)) fail(undelivered());
      }, holdMs);
      holdTimer.unref?.();
    });
  }

  /**
   * Offer a command to every transport. True when at least one took it —
   * did not report "no live connection to that device". A transport that
   * throws has not taken it.
   */
  private dispatchToTransports(command: DeviceCommand): boolean {
    let taken = false;
    for (const transport of this.transports) {
      try {
        if (transport.command(command) !== false) taken = true;
      } catch {
        // One broken transport must not stop the others.
      }
    }
    return taken;
  }

  // ── Model-facing tool surface ──────────────────────────────────────────────

  /** `list_devices`: every mesh device with presence, battery, last-known
   *  position, and capabilities — the model's full view of the mesh. */
  async describeDevices(): Promise<MeshToolResult> {
    const { devices } = await this.list();
    if (devices.length === 0) {
      return { ok: true, text: "No mesh devices have registered yet." };
    }
    return {
      ok: true,
      text: devices.map((d) => this.deviceLine(d)).join("\n"),
    };
  }

  /**
   * Ping every registered device: read the registry, then actively probe
   * each ONLINE device with a lightweight `status` command (concurrently)
   * and measure round-trip latency. Offline devices are reported from
   * presence without a probe (a probe would just burn the timeout). The
   * structured result powers frontend surfaces like Telegram's /mesh — the
   * mesh tools stay text-only for the model, this is for humans.
   */
  async pingAll(timeoutMs = 5_000): Promise<MeshPingResult[]> {
    const { devices } = await this.list();
    const hasTransport = this.transports.size > 0;
    return Promise.all(
      devices.map(async (device): Promise<MeshPingResult> => {
        if (!device.online) return { device, reachable: false };
        if (!hasTransport) {
          return { device, reachable: false, error: "no transport connected" };
        }
        const start = Date.now();
        const result = await this.sendCommand(device, "status", {}, timeoutMs);
        return result.ok
          ? { device, reachable: true, latencyMs: Date.now() - start }
          : {
              device,
              reachable: false,
              error: result.message ?? "no response",
            };
      }),
    );
  }

  /**
   * `get_device_location`: resolve the target (id, name fragment, or the
   * most recent mobile device), push a locate to connected transports, wait
   * briefly for a fresh fix, then fall back to the last persisted location.
   */
  async locateDevice(query?: unknown): Promise<MeshToolResult> {
    await this.load();
    const resolved = this.resolveDevice(query);
    if ("error" in resolved) return { ok: false, text: resolved.error };
    const target = resolved.target;
    const requestedAt = Date.now();
    // Only wait out the fresh-fix window when a transport can actually
    // deliver the locate AND the device is currently present — pinging an
    // offline device just burns the whole timeout for a fix that won't come,
    // so answer from persistence immediately in that case.
    const dispatched = this.requestLocate(target.id);
    const fresh =
      dispatched && target.online
        ? await this.waitForFreshLocation(target.id, requestedAt)
        : undefined;
    const loc = fresh ?? this.registry.getLocation(target.id);
    if (!loc) {
      return {
        ok: false,
        text: !dispatched
          ? `No location is known for ${target.name}, and no companion transport is connected to request one.`
          : target.online
            ? `No location is known for ${target.name}. A locate request was sent, but no fix arrived within ${Math.round(this.freshFixTimeoutMs / 1000)}s.`
            : `No location is known for ${target.name}, and it appears offline (last seen ${age(Date.now() - target.lastSeen)}).`,
      };
    }
    return { ok: true, text: this.locationSummary(target, loc) };
  }

  /**
   * `remove_device`: drop a stale device from the mesh registry (with its
   * location + history). Destructive, so it requires an explicit target —
   * no "default to the most recent device" like the read tools.
   */
  async removeDevice(query?: unknown): Promise<MeshToolResult> {
    await this.load();
    if (typeof query !== "string" || !query.trim()) {
      return {
        ok: false,
        text: "remove_device needs an explicit device id or name — there is no default target for a destructive operation. See list_devices.",
      };
    }
    const resolved = this.resolveDevice(query);
    if ("error" in resolved) return { ok: false, text: resolved.error };
    const target = resolved.target;
    const removed = await this.registry.removeDevice(target.id);
    if (!removed) {
      return { ok: false, text: this.noSuchDevice(query).text };
    }
    // A removed device keeps no way back in: its own credential dies with
    // the registry entry (its live sessions drop with it).
    const revoked =
      (await this.credentials?.revokeDevice(removed.id, "device removed")) ??
      [];
    // With its credential gone it can no longer post a result, and presence
    // can't fail these for it (the registry entry is gone too) — without
    // this, a command in flight waits out its whole budget.
    if (revoked.length > 0) {
      this.failPendingCommands(
        removed.id,
        `${removed.name} was removed from the mesh before it answered.`,
      );
    }
    return {
      ok: true,
      text:
        `Removed ${removed.name} [id: ${removed.id}] (${removed.platform}, last seen ${age(Date.now() - removed.lastSeen)}) from the mesh registry.` +
        (revoked.length > 0
          ? ` Revoked its ${revoked.length} per-device credential(s); it must be paired again to rejoin.`
          : target.online
            ? " Note: it was still online — a connected companion re-registers within ~60s, so quit the app first if it keeps coming back."
            : ""),
    };
  }

  /** `ring_device`: make the device sound/vibrate so it can be found. */
  ringDevice(query?: unknown, message?: unknown): Promise<MeshToolResult> {
    const note =
      typeof message === "string" && message.trim()
        ? message.trim().slice(0, 200)
        : undefined;
    return this.commandTool(query, "ring", note ? { message: note } : {});
  }

  /**
   * `get_device_history`: the device's movement + battery over a window,
   * computed from the fixes the daemon has been receiving all along —
   * timeline, distance traveled, and battery trend.
   */
  async deviceHistory(
    query?: unknown,
    hours?: unknown,
  ): Promise<MeshToolResult> {
    await this.load();
    const resolved = this.resolveDevice(query);
    if ("error" in resolved) return { ok: false, text: resolved.error };
    const target = resolved.target;
    const windowHours = clampHours(hours);
    const sinceTs = Date.now() - windowHours * 3_600_000;
    const fixes = this.registry.getHistory(target.id, sinceTs);
    if (fixes.length === 0) {
      return {
        ok: true,
        text: `No location reports from ${target.name} in the last ${windowHours}h. Enable periodic reporting in the companion app for a movement history.`,
      };
    }
    return { ok: true, text: this.historySummary(target, fixes, windowHours) };
  }

  /** `get_device_status`: live telemetry straight from the device. */
  getDeviceStatus(query?: unknown): Promise<MeshToolResult> {
    return this.commandTool(query, "status", {});
  }

  // ── Exec + filesystem tools (teleport substrate) ───────────────────────────

  /**
   * Run a shell command on a device and return its stdout/stderr/exit code.
   * The primitive under `device_exec` and the teleported native `bash` tool.
   */
  async execOnDevice(
    query: unknown,
    cmd: unknown,
    cwd?: unknown,
    timeoutSec?: unknown,
  ): Promise<MeshToolResult> {
    const command = typeof cmd === "string" ? cmd : "";
    if (!command.trim()) {
      return { ok: false, text: "No command given to run on the device." };
    }
    const budgetMs = clampExecTimeout(timeoutSec);
    const dispatched = await this.dispatchCommand(
      query,
      "exec",
      {
        cmd: command,
        ...(typeof cwd === "string" && cwd.trim() ? { cwd: cwd.trim() } : {}),
        timeoutMs: budgetMs,
      },
      budgetMs + 5_000, // let the device's own timeout fire first
    );
    if ("error" in dispatched) return { ok: false, text: dispatched.error };
    return {
      ok: dispatched.result.ok,
      text: formatExecResult(dispatched.target, dispatched.result),
    };
  }

  /**
   * `device_computer`: look at and drive a device's desktop (screenshot,
   * accessibility snapshot, pointer, keyboard). See devices/computer.ts.
   */
  async computerOnDevice(
    query: unknown,
    input: Record<string, unknown>,
  ): Promise<MeshToolResult> {
    const built = computerCommandParams(input);
    if ("error" in built) return { ok: false, text: built.error };
    const dispatched = await this.dispatchCommand(
      query,
      "computer",
      built.params,
      COMPUTER_COMMAND_TIMEOUT_MS,
    );
    if ("error" in dispatched) return { ok: false, text: dispatched.error };
    return formatComputerResult(
      dispatched.target,
      built.action,
      dispatched.result,
    );
  }

  /** `device_list_dir`: list a directory on the device. */
  async listDirOnDevice(
    query: unknown,
    path: unknown,
  ): Promise<MeshToolResult> {
    const dir = requirePath(path);
    if (!dir) return { ok: false, text: "A directory path is required." };
    const dispatched = await this.dispatchCommand(
      query,
      "list_dir",
      { path: dir },
      FS_COMMAND_TIMEOUT_MS,
    );
    if ("error" in dispatched) return { ok: false, text: dispatched.error };
    const { target, result } = dispatched;
    if (!result.ok) {
      return { ok: false, text: result.message ?? `Could not list ${dir}.` };
    }
    const entries = Array.isArray(result.data?.entries)
      ? (result.data!.entries as Array<Record<string, unknown>>)
      : [];
    if (entries.length === 0) {
      return { ok: true, text: `${dir} on ${target.name} is empty.` };
    }
    const lines = entries.map((e) => {
      const name = String(e.name ?? "?");
      const type = e.type === "dir" ? "/" : "";
      const size =
        typeof e.size === "number" && e.type !== "dir"
          ? ` (${formatBytes(e.size)})`
          : "";
      return `- ${name}${type}${size}`;
    });
    return {
      ok: true,
      text: `${dir} on ${target.name} — ${entries.length} item(s):\n${lines.join("\n")}`,
    };
  }

  /** `device_stat`: metadata for one path on the device. */
  async statOnDevice(query: unknown, path: unknown): Promise<MeshToolResult> {
    const p = requirePath(path);
    if (!p) return { ok: false, text: "A path is required." };
    const dispatched = await this.dispatchCommand(
      query,
      "stat",
      { path: p },
      FS_COMMAND_TIMEOUT_MS,
    );
    if ("error" in dispatched) return { ok: false, text: dispatched.error };
    const { result } = dispatched;
    if (!result.ok) {
      return { ok: false, text: result.message ?? `Cannot stat ${p}.` };
    }
    const d = result.data ?? {};
    const fields = Object.entries(d)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}: ${String(v)}`);
    return { ok: true, text: `${p} — ${fields.join(" · ")}` };
  }

  // ── File transfer + self-update (see transfers/device-files.ts) ───────────

  /** POST /devices/file — a device streams a pull's file body up. */
  acceptFileUpload(
    token: string,
    body: Readable,
    fromDeviceId?: string,
  ): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
    return this.files.acceptFileUpload(token, body, fromDeviceId);
  }

  /** GET /devices/file — a device asks for a push's file body. */
  openFileDownload(
    token: string,
    fromDeviceId?: string,
  ): Promise<{ path: string; size: number } | null> {
    return this.files.openFileDownload(token, fromDeviceId);
  }

  /** Raw file bytes off a device — the primitive under the read tools. */
  readFileBytes(
    query: unknown,
    path: unknown,
  ): Promise<{ data: Buffer; deviceName: string } | { error: string }> {
    return this.files.readFileBytes(query, path);
  }

  /** `device_read_file`: read a (text) file off the device. */
  readFileFromDevice(query: unknown, path: unknown): Promise<MeshToolResult> {
    return this.files.readFileFromDevice(query, path);
  }

  /** `device_write_file`: write text content to a file on the device. */
  writeFileToDevice(
    query: unknown,
    path: unknown,
    content: unknown,
  ): Promise<MeshToolResult> {
    return this.files.writeFileToDevice(query, path, content);
  }

  /** `device_pull_file`: copy a device file to the daemon host. */
  pullFileFromDevice(
    query: unknown,
    remotePath: unknown,
    localPath?: unknown,
  ): Promise<MeshToolResult> {
    return this.files.pullFileFromDevice(query, remotePath, localPath);
  }

  /** `device_push_file`: copy a daemon-host file to the device. */
  pushFileToDevice(
    query: unknown,
    localPath: unknown,
    remotePath: unknown,
  ): Promise<MeshToolResult> {
    return this.files.pushFileToDevice(query, localPath, remotePath);
  }

  /** `update_device`: remote self-update for the companion app. */
  updateDeviceApp(
    query: unknown,
    localApkPath: unknown,
    remotePath?: unknown,
    allowDowngrade?: unknown,
  ): Promise<MeshToolResult> {
    return this.files.updateDeviceApp(
      query,
      localApkPath,
      remotePath,
      allowDowngrade,
    );
  }

  /** `update_node`: remote self-update for a headless talon-node. */
  updateNodeBinary(
    query: unknown,
    localBinaryPath?: unknown,
    remotePath?: unknown,
    allowDowngrade?: unknown,
  ): Promise<MeshToolResult> {
    return this.files.updateNodeBinary(
      query,
      localBinaryPath,
      remotePath,
      allowDowngrade,
    );
  }

  // ── Provisioning + pairing (see links/bridge-links.ts) ────────────────────

  /** `get_node_binary`: materialize a talon-node binary on the daemon host. */
  getNodeBinary(os: unknown, arch: unknown): Promise<MeshToolResult> {
    return this.links.getNodeBinary(os, arch);
  }

  /** `make_node_install_link`: mint a single-use node provisioning URL. */
  makeNodeInstallLink(
    os: unknown,
    arch: unknown,
    name?: unknown,
    bridgeUrl?: unknown,
  ): Promise<MeshToolResult> {
    return this.links.makeNodeInstallLink(os, arch, name, bridgeUrl);
  }

  /** Mint a single-use link that connects a phone to this bridge. */
  makeCompanionPairLink(
    label?: unknown,
    bridgeUrl?: unknown,
  ): ReturnType<BridgeLinks["makeCompanionPairLink"]> {
    return this.links.makeCompanionPairLink(label, bridgeUrl);
  }

  /** The bridge base URL a bridge-served link should use (secret drop). */
  bridgeBaseUrl(
    explicit?: unknown,
  ): ReturnType<BridgeLinks["bridgeBaseUrlFor"]> {
    return this.links.bridgeBaseUrlFor(explicit);
  }

  /** `make_companion_pair_link`: the pairing link as a tool result. */
  makeCompanionPairLinkText(
    label?: unknown,
    bridgeUrl?: unknown,
  ): MeshToolResult {
    return this.links.makeCompanionPairLinkText(label, bridgeUrl);
  }

  /** GET /pair — serve a pairing grant (single-use). */
  openCompanionPair(
    token: string,
    format: "html" | "json",
  ): { contentType: string; body: string } | null {
    return this.links.openCompanionPair(token, format);
  }

  /** How this bridge is reachable, for an operator asking where to point a device. */
  bridgeReachability(): ReturnType<BridgeLinks["bridgeReachability"]> {
    return this.links.bridgeReachability();
  }

  /** GET /node/install — serve a grant's installer script (single-use). */
  openNodeInstall(
    token: string,
    os?: string | null,
    arch?: string | null,
  ): Promise<{ script: string; filename: string } | null> {
    return this.links.openNodeInstall(token, os, arch);
  }

  /** GET /node/binary — serve a grant's binary (single-use). */
  openNodeBinary(token: string): { path: string; size: number } | null {
    return this.links.openNodeBinary(token);
  }

  /**
   * Shared command-tool flow: resolve the target, check its advertised
   * capabilities, require a transport, send, and render the device's answer.
   */
  private async commandTool(
    query: unknown,
    name: string,
    params: Record<string, unknown>,
  ): Promise<MeshToolResult> {
    const dispatched = await this.dispatchCommand(query, name, params);
    if ("error" in dispatched) return { ok: false, text: dispatched.error };
    return {
      ok: dispatched.result.ok,
      text: this.commandSummary(dispatched.target, name, dispatched.result),
    };
  }

  /**
   * Resolve a target, validate capability + reachability, then send the
   * command and return the raw result — the shared primitive under both the
   * human-summary command tools (ring/status) and the structured exec/fs
   * tools that format the payload themselves. Returns `{ error }` for the
   * pre-flight failures (no device, unsupported, offline, no transport).
   */
  async dispatchCommand(
    query: unknown,
    name: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<
    { target: DeviceInfo; result: DeviceCommandResult } | { error: string }
  > {
    await this.load();
    const resolved = this.resolveDevice(query);
    if ("error" in resolved) return { error: resolved.error };
    const target = resolved.target;
    // Devices advertise what they can do; an explicit list that lacks the
    // command is a clean "can't" — absent list means an older app build, so
    // attempt it and let the timeout speak.
    if (target.capabilities && !target.capabilities.includes(name)) {
      return {
        error: `${target.name} does not support "${name}" (supports: ${target.capabilities.join(", ")}).`,
      };
    }
    if (this.transports.size === 0) {
      return {
        error: `No companion transport is connected, so "${name}" cannot reach ${target.name}.`,
      };
    }
    // Don't wait out a full timeout for a device that's plainly gone.
    if (!target.online) {
      return {
        error: `${target.name} appears offline (last seen ${age(Date.now() - target.lastSeen)}), so "${name}" was not sent.`,
      };
    }
    const result = await this.sendCommand(target, name, params, timeoutMs);
    return { target, result };
  }

  /** Resolve a device by exact id, exact name, or unique name fragment;
   *  undefined when nothing (or more than one device) matches. */
  chooseDevice(query?: unknown): DeviceInfo | undefined {
    const resolved = this.resolveDevice(query);
    return "target" in resolved ? resolved.target : undefined;
  }

  /**
   * Device resolution with a caller-facing error. Matching order: exact id,
   * exact name (case-insensitive), then name fragment — with names and
   * queries compared separator-insensitively ("pixel 10" finds
   * "Google-Pixel10"). When several devices match, a sole ONLINE match wins
   * (a stale duplicate registration must not shadow the live device);
   * otherwise it's an explicit error, never a silent first pick — exec and
   * file commands aimed at "pixel" must not land on whichever Pixel
   * happened to register first. No query defaults to the most recently
   * seen mobile device, then the most recent device overall.
   */
  resolveDevice(query?: unknown): { target: DeviceInfo } | { error: string } {
    const devices = this.registry.list().devices;
    if (typeof query === "string" && query.trim()) {
      const raw = query.trim();
      const q = raw.toLowerCase();
      const byId = devices.find((d) => d.id.toLowerCase() === q);
      if (byId) return { target: byId };

      const fold = (s: string): string =>
        s.toLowerCase().replace(/[^a-z0-9]+/g, "");
      const folded = fold(raw);
      const pick = (
        candidates: DeviceInfo[],
      ): { target: DeviceInfo } | { error: string } | undefined => {
        if (candidates.length === 1) return { target: candidates[0]! };
        if (candidates.length > 1) {
          const exactNames = new Set(candidates.map((d) => fold(d.name)));
          const online = candidates.filter((d) => d.online);
          if (online.length === 1) return { target: online[0]! };
          return {
            error: `"${raw}" matches ${candidates.length} devices: ${candidates
              .map(
                (d) =>
                  `${d.name} [id: ${d.id}, ${d.online ? "online" : "offline"}]`,
              )
              .join(
                ", ",
              )}. Use the device id${exactNames.size > 1 ? " or full name" : ""}.`,
          };
        }
        return undefined;
      };

      const exactMatch = pick(devices.filter((d) => fold(d.name) === folded));
      if (exactMatch) return exactMatch;

      if (q.length >= 6) {
        const byPrefix = devices.filter((d) =>
          d.id.toLowerCase().startsWith(q),
        );
        if (byPrefix.length === 1) return { target: byPrefix[0]! };
        if (byPrefix.length > 1) {
          return {
            error: `Device id prefix "${raw}" matches ${byPrefix.length} devices: ${byPrefix
              .map((d) => `${d.name} [id: ${d.id}]`)
              .join(", ")}. Provide more characters of the id.`,
          };
        }
      }

      return (
        (folded
          ? pick(devices.filter((d) => fold(d.name).includes(folded)))
          : undefined) ?? { error: this.noSuchDevice(query).text }
      );
    }
    const fallback =
      devices.find((d) => MOBILE_PLATFORMS.has(d.platform)) ?? devices[0];
    return fallback
      ? { target: fallback }
      : { error: this.noSuchDevice(query).text };
  }

  // ── Formatting ─────────────────────────────────────────────────────────────

  private noSuchDevice(query: unknown): MeshToolResult {
    const known = this.registry.list().devices;
    return {
      ok: false,
      text:
        typeof query === "string" && query.trim() && known.length > 0
          ? `No mesh device matches "${query.trim()}". Known devices:\n${known.map((d) => this.deviceLine(d)).join("\n")}`
          : "No mesh devices are registered.",
    };
  }

  private deviceLine(device: DeviceInfo): string {
    const parts = [
      `${device.name} [id: ${device.id}] (${device.platform}${device.arch ? `/${device.arch}` : ""})`,
      device.online ? "online" : "offline",
      `last seen ${age(Date.now() - device.lastSeen)}`,
    ];
    if (typeof device.battery === "number") {
      parts.push(`${device.battery}%${device.charging ? " charging" : ""}`);
    }
    const loc = this.registry.getLocation(device.id);
    if (loc) {
      parts.push(
        `at ${loc.lat.toFixed(6)},${loc.lon.toFixed(6)} (fix ${age(Date.now() - loc.ts)})`,
      );
    }
    if (device.capabilities?.length) {
      parts.push(`can: ${device.capabilities.join(", ")}`);
    }
    return `- ${parts.join(" · ")}`;
  }

  private locationSummary(device: DeviceInfo, loc: DeviceLocation): string {
    const ageText = age(Date.now() - loc.ts);
    const accuracy =
      typeof loc.accuracyM === "number"
        ? ` Accuracy ${Math.round(loc.accuracyM)}m.`
        : "";
    return [
      `${device.name} is at ${loc.lat.toFixed(6)}, ${loc.lon.toFixed(6)}.`,
      `${accuracy} Fix age ${ageText}.`,
      `Reverse-geocode pair: ${loc.lat},${loc.lon}`,
    ]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private commandSummary(
    device: DeviceInfo,
    name: string,
    result: DeviceCommandResult,
  ): string {
    if (!result.ok) {
      return result.message ?? `${device.name} rejected "${name}".`;
    }
    const detail = result.message ? ` ${result.message}` : "";
    switch (name) {
      case "ring":
        return `${device.name} is ringing.${detail}`;
      case "status": {
        const fields = Object.entries(result.data ?? {})
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => `${k}: ${String(v)}`);
        return fields.length
          ? `${device.name} status — ${fields.join(" · ")}`
          : `${device.name} answered but reported no status fields.${detail}`;
      }
      default:
        return (
          result.message ??
          (result.data
            ? `${device.name} answered: ${JSON.stringify(result.data)}`
            : `${device.name} completed "${name}".`)
        );
    }
  }

  /** Render a window of fixes: headline (count, span, distance, battery
   *  trend) plus a bounded, evenly-sampled timeline oldest-first. */
  private historySummary(
    device: DeviceInfo,
    fixes: DeviceLocation[],
    windowHours: number,
  ): string {
    let distanceM = 0;
    for (let i = 1; i < fixes.length; i++) {
      distanceM += haversineM(fixes[i - 1], fixes[i]);
    }
    const batteries = fixes
      .map((f) => f.batteryPct)
      .filter((b): b is number => typeof b === "number");
    const headline = [
      `${device.name}: ${fixes.length} fix${fixes.length === 1 ? "" : "es"} in the last ${windowHours}h`,
      `moved ~${formatDistance(distanceM)}`,
      ...(batteries.length >= 2
        ? [`battery ${batteries[0]}% → ${batteries[batteries.length - 1]}%`]
        : []),
    ].join(" · ");
    const lines = sampleEvenly(fixes, MAX_HISTORY_LINES).map((f) => {
      const parts = [
        `${formatWhen(f.ts)} — ${f.lat.toFixed(5)},${f.lon.toFixed(5)}`,
      ];
      if (typeof f.accuracyM === "number")
        parts.push(`±${Math.round(f.accuracyM)}m`);
      if (typeof f.batteryPct === "number") parts.push(`${f.batteryPct}%`);
      return `- ${parts.join(" · ")}`;
    });
    const omitted = fixes.length - Math.min(fixes.length, MAX_HISTORY_LINES);
    return [
      headline,
      ...lines,
      ...(omitted > 0
        ? [`(${omitted} more fixes omitted; timeline sampled evenly)`]
        : []),
    ].join("\n");
  }

  private async waitForFreshLocation(
    deviceId: string,
    requestedAt: number,
  ): Promise<DeviceLocation | undefined> {
    // Judge freshness by server-side arrival time, not the device-reported
    // `loc.ts` (which is subject to the companion's clock skew).
    if ((this.receivedAt.get(deviceId) ?? 0) >= requestedAt) {
      return this.registry.getLocation(deviceId);
    }
    const deadline = Date.now() + this.freshFixTimeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(
          done,
          Math.min(remaining, this.pollIntervalMs),
        );
        this.waiters.add(done);
      });
      if ((this.receivedAt.get(deviceId) ?? 0) >= requestedAt) {
        return this.registry.getLocation(deviceId);
      }
    }
    return undefined;
  }
}

/** Clamp the requested history window to 1..168 hours (default 24). */
function clampHours(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HISTORY_HOURS;
  return Math.min(168, Math.max(1, Math.round(n)));
}

/** Great-circle distance between two fixes in meters. */
function haversineM(a: DeviceLocation, b: DeviceLocation): number {
  const R = 6_371_000;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(meters: number): string {
  if (meters < 1_000) return `${Math.round(meters)}m`;
  return `${(meters / 1_000).toFixed(1)}km`;
}

/** Local wall-clock stamp for history lines (date + HH:MM). */
function formatWhen(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Up to `max` items spread evenly across the list, endpoints included. */
function sampleEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    out.push(items[Math.round((i * (items.length - 1)) / (max - 1))]);
  }
  return out;
}

/** Clamp a caller-supplied exec timeout (seconds) to the allowed window. */
function clampExecTimeout(value: unknown): number {
  const sec = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_EXEC_TIMEOUT_MS;
  return Math.min(
    MAX_EXEC_TIMEOUT_MS,
    Math.max(1_000, Math.round(sec * 1_000)),
  );
}

/** Render an exec result: exit code headline + stdout/stderr blocks. */
function formatExecResult(
  device: DeviceInfo,
  result: DeviceCommandResult,
): string {
  if (!result.ok && !result.data) {
    return result.message ?? `${device.name} could not run the command.`;
  }
  const d = result.data ?? {};
  const exit = typeof d.exitCode === "number" ? d.exitCode : "?";
  const stdout = typeof d.stdout === "string" ? d.stdout : "";
  const stderr = typeof d.stderr === "string" ? d.stderr : "";
  const via = typeof d.via === "string" && d.via ? ` via ${d.via}` : "";
  const parts = [`[${device.name}${via}] exit ${exit}`];
  if (stdout.trim())
    parts.push(
      `--- stdout ---\n${clampExecOutput(stdout.replace(/\s+$/, ""))}`,
    );
  if (stderr.trim())
    parts.push(
      `--- stderr ---\n${clampExecOutput(stderr.replace(/\s+$/, ""))}`,
    );
  if (!stdout.trim() && !stderr.trim()) parts.push("(no output)");
  return parts.join("\n");
}

// ── Process-wide instance ─────────────────────────────────────────────────────

let instance: MeshService | null = null;

/** The daemon's shared mesh service (lazily created). */
export function getMeshService(): MeshService {
  instance ??= new MeshService(undefined, {
    credentials: new DeviceCredentialStore(),
    audit: new MeshAuditLog(),
  });
  return instance;
}

/** Swap the shared instance — composition/test seam. Pass null to reset. */
export function setMeshService(service: MeshService | null): void {
  instance = service;
}
