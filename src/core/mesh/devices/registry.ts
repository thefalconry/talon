/**
 * MeshRegistry — persistent storage for companion devices, last-known
 * locations, and a bounded per-device location/battery history.
 *
 * Pure state: validate, upsert, persist (0600 JSON sidecars under the Talon
 * root). No transport and no waiting logic — that policy lives in
 * MeshService, so the registry stays trivially testable.
 */

import { resolve } from "node:path";
import { logWarn } from "../../../util/log.js";
import { dirs } from "../../../util/paths.js";
import { readArray, writePrivateJson } from "../persist.js";
import {
  sanitizeCapabilities,
  toDeviceInfo,
  toDeviceLocation,
  type DeviceInfo,
  type DeviceLocation,
  type DevicePlatform,
} from "../types.js";

/**
 * A device is offline once it misses several heartbeats. The companion
 * re-registers every ~60s, so 180s tolerates two dropped beats (transient
 * radio/network hiccups) before flipping a device offline — wide enough that
 * a single late beat never flaps presence, tight enough that a genuinely
 * gone device is marked offline within ~3 minutes.
 */
const PRESENCE_TIMEOUT_MS = 180_000;
const DEVICE_FILE = resolve(dirs.root, "mesh-devices.json");
const LOCATION_FILE = resolve(dirs.root, "mesh-locations.json");
const HISTORY_FILE = resolve(dirs.root, "mesh-history.json");
/** Newest fixes kept per device (~a day of 5-minute periodic reports). */
const MAX_HISTORY_PER_DEVICE = 500;
/**
 * Registry bounds. Registrations and location reports are client-supplied
 * strings that the daemon persists forever and rewrites in full on every
 * heartbeat — without ceilings, one misbehaving (or malicious) client can
 * grow the sidecars until every mesh operation crawls. The caps are far
 * above anything a real device reports: ids are UUIDs (36 chars), names are
 * human device names, versions are semver-ish.
 */
const MAX_ID_CHARS = 128;
const MAX_NAME_CHARS = 128;
const MAX_VERSION_CHARS = 64;
const MAX_PROVIDER_CHARS = 32;
/**
 * Devices kept in the registry. Well past any plausible personal mesh, and
 * with the per-device history bound it also caps the history sidecar.
 * Reaching it evicts the least-recently-seen entry rather than refusing the
 * newcomer: a live device re-registers every ~60s and takes its slot back,
 * so the mesh stays usable even when the cap is being pushed against.
 */
const MAX_DEVICES = 128;
/**
 * Location entries for device ids that never registered. A fix can legitimately
 * arrive just before the first registration lands, so these aren't refused —
 * but they're the one path where an unknown id creates persisted state, so the
 * set is kept tiny and the stalest orphan is evicted to make room.
 */
const MAX_UNREGISTERED_LOCATIONS = 16;
const PLATFORMS = new Set<DevicePlatform>([
  "android",
  "macos",
  "windows",
  "linux",
  "ios",
]);

export class MeshRegistry {
  private devices = new Map<string, DeviceInfo>();
  private locations = new Map<string, DeviceLocation>();
  private history = new Map<string, DeviceLocation[]>();

  constructor(
    private readonly files = {
      devices: DEVICE_FILE,
      locations: LOCATION_FILE,
      history: HISTORY_FILE,
    },
  ) {}

  async load(): Promise<void> {
    this.devices = new Map(
      (await readArray<DeviceInfo>(this.files.devices))
        .map((d) => sanitizeDevice(d, d.lastSeen, false))
        .filter((d): d is DeviceInfo => d !== null)
        .map((d) => [d.id, d]),
    );
    this.locations = new Map(
      (await readArray<DeviceLocation>(this.files.locations))
        .map(sanitizeLocation)
        .filter((l): l is DeviceLocation => l !== null)
        .map((l) => [l.deviceId, l]),
    );
    this.history = new Map();
    for (const fix of (await readArray<DeviceLocation>(this.files.history))
      .map(sanitizeLocation)
      .filter((l): l is DeviceLocation => l !== null)) {
      this.appendHistory(fix);
    }
    // Sidecars written before the caps existed (or edited by hand) get
    // trimmed on the way in, so an oversized file is a one-boot problem
    // rather than permanent state. No write here — load() only reads; the
    // next mutation persists the trimmed maps.
    this.enforceDeviceCap();
    this.enforceOrphanLocationCap();
  }

  async register(
    body: Record<string, unknown>,
    now = Date.now(),
  ): Promise<DeviceInfo> {
    const next = sanitizeDevice(body, now, true);
    if (!next) throw new Error("Invalid device registration");
    const prev = this.devices.get(next.id);
    const device = toDeviceInfo(
      {
        ...prev,
        ...next,
        online: true,
        lastSeen: now,
      },
      now,
    );
    this.devices.set(device.id, device);
    const evicted = this.enforceDeviceCap();
    await this.persistDevices();
    if (evicted) {
      await this.persistLocations();
      await this.persistHistory();
    }
    return device;
  }

  /**
   * Drop a device (and its location + history) from the registry. Returns
   * the removed device, or undefined when the id is unknown. Note a still-
   * connected companion re-registers on its next heartbeat — removal is for
   * stale entries.
   */
  async removeDevice(deviceId: string): Promise<DeviceInfo | undefined> {
    const device = this.devices.get(deviceId);
    if (!device) return undefined;
    this.devices.delete(deviceId);
    const hadLocation = this.locations.delete(deviceId);
    const hadHistory = this.history.delete(deviceId);
    await this.persistDevices();
    if (hadLocation) await this.persistLocations();
    if (hadHistory) await this.persistHistory();
    return toDeviceInfo(device, device.lastSeen);
  }

  async storeLocation(
    body: Record<string, unknown>,
    now = Date.now(),
  ): Promise<DeviceLocation> {
    const loc = sanitizeLocation(body);
    if (!loc) throw new Error("Invalid device location");
    this.locations.set(loc.deviceId, loc);
    const device = this.devices.get(loc.deviceId);
    if (device) {
      this.devices.set(
        loc.deviceId,
        toDeviceInfo(
          {
            ...device,
            online: true,
            lastSeen: now,
            ...(typeof loc.batteryPct === "number"
              ? { battery: loc.batteryPct }
              : {}),
          },
          now,
        ),
      );
      await this.persistDevices();
    }
    this.appendHistory(loc);
    this.enforceOrphanLocationCap();
    await this.persistLocations();
    await this.persistHistory();
    return loc;
  }

  /**
   * Drop least-recently-seen devices until the registry is inside MAX_DEVICES,
   * taking their location + history with them (an evicted device leaves no
   * residue). Returns whether anything went, so callers know the location and
   * history sidecars need rewriting too.
   *
   * Two devices can legitimately share a `lastSeen` millisecond (a bulk
   * backfill, or two heartbeats landing in the same event-loop tick) —
   * ties are broken by registration order (the earlier registration is
   * treated as staler) so eviction is deterministic rather than depending on
   * `Array.prototype.sort`'s stability guarantee to preserve the `Map`'s
   * insertion order.
   */
  private enforceDeviceCap(): boolean {
    if (this.devices.size <= MAX_DEVICES) return false;
    const stalest = [...this.devices.values()]
      .map((device, insertionIndex) => ({ device, insertionIndex }))
      .sort(
        (a, b) =>
          a.device.lastSeen - b.device.lastSeen ||
          a.insertionIndex - b.insertionIndex,
      )
      .slice(0, this.devices.size - MAX_DEVICES)
      .map(({ device }) => device);
    for (const device of stalest) {
      this.devices.delete(device.id);
      this.locations.delete(device.id);
      this.history.delete(device.id);
    }
    logWarn(
      "mesh",
      `Device registry at its ${MAX_DEVICES}-device cap — evicted ${stalest
        .map((d) => `${d.name} [${d.id}]`)
        .join(", ")} (least recently seen)`,
    );
    return true;
  }

  /**
   * Bound the state an id that never registered can create: locations for
   * unknown device ids past MAX_UNREGISTERED_LOCATIONS are dropped
   * stalest-first, with their history. Registered devices are untouched —
   * their entries are already bounded by the device cap.
   *
   * Same explicit tie-break as {@link enforceDeviceCap}: fixes with an
   * identical `ts` fall back to insertion order instead of leaning on sort
   * stability.
   */
  private enforceOrphanLocationCap(): boolean {
    let dropped = false;
    const orphans = [...this.locations.values()]
      .filter((l) => !this.devices.has(l.deviceId))
      .map((location, insertionIndex) => ({ location, insertionIndex }))
      .sort(
        (a, b) =>
          a.location.ts - b.location.ts || a.insertionIndex - b.insertionIndex,
      )
      .map(({ location }) => location);
    if (orphans.length > MAX_UNREGISTERED_LOCATIONS) {
      for (const loc of orphans.slice(
        0,
        orphans.length - MAX_UNREGISTERED_LOCATIONS,
      )) {
        this.locations.delete(loc.deviceId);
        this.history.delete(loc.deviceId);
      }
      dropped = true;
    }
    // A fix always writes a location before its history entry, so a history
    // key belonging to neither a device nor a location can only come from a
    // hand-edited (or tampered) sidecar — it would otherwise be immortal.
    for (const id of this.history.keys()) {
      if (this.devices.has(id) || this.locations.has(id)) continue;
      this.history.delete(id);
      dropped = true;
    }
    return dropped;
  }

  /** Fixes for one device since `sinceTs`, oldest first. */
  getHistory(deviceId: string, sinceTs = 0): DeviceLocation[] {
    return (this.history.get(deviceId) ?? [])
      .filter((l) => l.ts >= sinceTs)
      .map(toDeviceLocation);
  }

  /** Append one fix to the device's rolling history (dedup on timestamp,
   *  chronological order, bounded to MAX_HISTORY_PER_DEVICE). */
  private appendHistory(fix: DeviceLocation): void {
    const list = this.history.get(fix.deviceId) ?? [];
    if (list.some((l) => l.ts === fix.ts)) return;
    list.push(toDeviceLocation(fix));
    list.sort((a, b) => a.ts - b.ts);
    if (list.length > MAX_HISTORY_PER_DEVICE) {
      list.splice(0, list.length - MAX_HISTORY_PER_DEVICE);
    }
    this.history.set(fix.deviceId, list);
  }

  list(now = Date.now()): {
    devices: DeviceInfo[];
    locations: DeviceLocation[];
  } {
    return {
      devices: [...this.devices.values()]
        .map((d) => toDeviceInfo(d, now, PRESENCE_TIMEOUT_MS))
        .sort((a, b) => b.lastSeen - a.lastSeen),
      locations: [...this.locations.values()]
        .map(toDeviceLocation)
        .sort((a, b) => b.ts - a.ts),
    };
  }

  getLocation(deviceId: string): DeviceLocation | undefined {
    const loc = this.locations.get(deviceId);
    return loc ? toDeviceLocation(loc) : undefined;
  }

  private async persistDevices(): Promise<void> {
    await writePrivateJson(this.files.devices, [...this.devices.values()]);
  }

  private async persistLocations(): Promise<void> {
    await writePrivateJson(this.files.locations, [...this.locations.values()]);
  }

  private async persistHistory(): Promise<void> {
    await writePrivateJson(
      this.files.history,
      [...this.history.values()].flat(),
    );
  }
}

function sanitizeDevice(
  body: Record<string, unknown>,
  now: number,
  requireCore: boolean,
): DeviceInfo | null {
  const id = stringField(body.id);
  // Display-only fields are clamped: an absurd name costs the device its
  // label, not its place on the mesh. The id is the registry's identity key,
  // so it is REFUSED rather than clamped — truncating it would quietly merge
  // two devices (or a device and an attacker's near-miss) onto one entry.
  const name = stringField(body.name)?.slice(0, MAX_NAME_CHARS);
  const appVersion = stringField(body.appVersion)?.slice(0, MAX_VERSION_CHARS);
  const platform = stringField(body.platform) as DevicePlatform | undefined;
  if ((requireCore || id !== undefined) && (!id || id.length > MAX_ID_CHARS)) {
    return null;
  }
  if ((requireCore || name !== undefined) && !name) return null;
  if ((requireCore || appVersion !== undefined) && !appVersion) return null;
  if (
    (requireCore || platform !== undefined) &&
    (!platform || !PLATFORMS.has(platform))
  ) {
    return null;
  }
  const arch = stringField(body.arch)?.toLowerCase().slice(0, 16);
  return {
    id: id ?? "",
    name: name ?? "",
    platform: platform ?? "linux",
    ...(arch ? { arch } : {}),
    appVersion: appVersion ?? "",
    online: body.online === true,
    lastSeen: numberField(body.lastSeen) ?? now,
    ...(numberField(body.battery) !== undefined
      ? { battery: numberField(body.battery) }
      : {}),
    ...(typeof body.charging === "boolean" ? { charging: body.charging } : {}),
    ...(sanitizeCapabilities(body.capabilities)
      ? { capabilities: sanitizeCapabilities(body.capabilities) }
      : {}),
  };
}

function sanitizeLocation(
  body: Record<string, unknown>,
): DeviceLocation | null {
  const deviceId = stringField(body.deviceId);
  const lat = numberField(body.lat);
  const lon = numberField(body.lon);
  const ts = numberField(body.ts);
  if (!deviceId || !Number.isFinite(lat) || !Number.isFinite(lon) || !ts) {
    return null;
  }
  // Same identity-key reasoning as sanitizeDevice: a fix keyed by a clamped
  // id would attach to the wrong device's timeline.
  if (deviceId.length > MAX_ID_CHARS) return null;
  if (lat! < -90 || lat! > 90 || lon! < -180 || lon! > 180) return null;
  return toDeviceLocation({
    deviceId,
    lat: lat!,
    lon: lon!,
    ...(numberField(body.accuracyM) !== undefined
      ? { accuracyM: numberField(body.accuracyM) }
      : {}),
    ...(numberField(body.altitudeM) !== undefined
      ? { altitudeM: numberField(body.altitudeM) }
      : {}),
    ...(numberField(body.speedMps) !== undefined
      ? { speedMps: numberField(body.speedMps) }
      : {}),
    ...(numberField(body.headingDeg) !== undefined
      ? { headingDeg: numberField(body.headingDeg) }
      : {}),
    ts,
    ...(stringField(body.provider)
      ? { provider: stringField(body.provider)!.slice(0, MAX_PROVIDER_CHARS) }
      : {}),
    ...(numberField(body.batteryPct) !== undefined
      ? { batteryPct: numberField(body.batteryPct) }
      : {}),
  });
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
