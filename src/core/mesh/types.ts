/**
 * Device-mesh domain types + normalizers.
 *
 * The canonical shapes for companion devices and their reported locations.
 * They live in core (not a frontend) because the mesh is daemon-wide state:
 * devices register through the native bridge transport, but the model reads
 * them from ANY frontend via the shared `list_devices` /
 * `get_device_location` gateway actions. The bridge protocol re-exports
 * these types so the wire contract is unchanged.
 */

export type DevicePlatform = "android" | "macos" | "windows" | "linux" | "ios";

export type DeviceInfo = {
  id: string;
  name: string;
  platform: DevicePlatform;
  /**
   * CPU architecture in Go spelling (amd64/arm64/arm), as talon-node
   * advertises it. Lets the daemon pick the right release binary for
   * update_node without being told. Absent for companion apps and node
   * builds that predate arch reporting.
   */
  arch?: string;
  appVersion: string;
  online: boolean;
  /** Epoch milliseconds. */
  lastSeen: number;
  /** Battery percent, 0-100. */
  battery?: number;
  charging?: boolean;
  /**
   * Command names this device can execute (e.g. "locate", "ring",
   * "open_url"). Reported by the device at registration; absent for app
   * versions that predate the command channel — treat as unknown, not
   * empty.
   */
  capabilities?: string[];
  /**
   * Operator-assigned labels (e.g. "gpu", "build"), addressable as
   * "tag:<name>". Set only through set_device_tags: a device's own
   * registration can neither set nor clear them.
   */
  tags?: string[];
};

/**
 * An on-demand command pushed to one companion device over the mesh
 * transport. The device executes it and answers with a DeviceCommandResult
 * carrying the same `id`.
 */
export type DeviceCommand = {
  /** Correlation id — echoed back as the result's `commandId`. */
  id: string;
  deviceId: string;
  /** Command name (e.g. "ring", "open_url", "clipboard_get", "status"). */
  name: string;
  params: Record<string, unknown>;
};

/** A device's answer to a DeviceCommand. */
export type DeviceCommandResult = {
  commandId: string;
  deviceId: string;
  ok: boolean;
  /** Human-readable outcome (shown to the model). */
  message?: string;
  /** Structured payload (e.g. clipboard text, status fields). */
  data?: Record<string, unknown>;
};

export type DeviceLocation = {
  deviceId: string;
  lat: number;
  lon: number;
  accuracyM?: number;
  altitudeM?: number;
  speedMps?: number;
  headingDeg?: number;
  /** Epoch milliseconds. */
  ts: number;
  provider?: string;
  batteryPct?: number;
};

export function toDeviceInfo(
  value: DeviceInfo,
  now = Date.now(),
  offlineAfterMs = 90_000,
): DeviceInfo {
  const battery =
    typeof value.battery === "number"
      ? Math.max(0, Math.min(100, Math.round(value.battery)))
      : undefined;
  return {
    id: value.id,
    name: value.name,
    platform: value.platform,
    ...(value.arch ? { arch: value.arch } : {}),
    appVersion: value.appVersion,
    online: now - value.lastSeen <= offlineAfterMs && value.online,
    lastSeen: value.lastSeen,
    ...(battery !== undefined ? { battery } : {}),
    ...(typeof value.charging === "boolean"
      ? { charging: value.charging }
      : {}),
    ...(value.capabilities?.length
      ? { capabilities: [...value.capabilities] }
      : {}),
    ...(value.tags?.length ? { tags: [...value.tags] } : {}),
  };
}

/**
 * Normalize a device's advertised capability list: strings only, trimmed,
 * lowercased, deduped, and bounded so a misbehaving client can't bloat the
 * persisted registry. Undefined when nothing valid remains.
 */
export function sanitizeCapabilities(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const cap = item.trim().toLowerCase().slice(0, 32);
    if (cap) seen.add(cap);
    if (seen.size >= 16) break;
  }
  return seen.size ? [...seen] : undefined;
}

export function toDeviceLocation(value: DeviceLocation): DeviceLocation {
  return {
    deviceId: value.deviceId,
    lat: value.lat,
    lon: value.lon,
    ...(typeof value.accuracyM === "number"
      ? { accuracyM: value.accuracyM }
      : {}),
    ...(typeof value.altitudeM === "number"
      ? { altitudeM: value.altitudeM }
      : {}),
    ...(typeof value.speedMps === "number" ? { speedMps: value.speedMps } : {}),
    ...(typeof value.headingDeg === "number"
      ? { headingDeg: value.headingDeg }
      : {}),
    ts: value.ts,
    ...(value.provider ? { provider: value.provider } : {}),
    ...(typeof value.batteryPct === "number"
      ? { batteryPct: Math.max(0, Math.min(100, Math.round(value.batteryPct))) }
      : {}),
  };
}
