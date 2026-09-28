import { z } from "zod";
import type { ToolDefinition } from "../types.js";

/**
 * Device-mesh tools. Deliberately NOT frontend-restricted: the mesh is
 * daemon-wide state served by shared gateway actions, so the model can see,
 * locate, and command companion devices from any chat surface.
 */

/** Shared device-target parameter: id or name fragment; default = mobile. */
const deviceParam = z
  .string()
  .optional()
  .describe(
    "Device id, exact name, or unique name fragment (case/separator-insensitive; see list_devices). A fragment matching several devices errors unless exactly one is online — prefer the id when duplicates exist. Defaults to the most recently seen mobile mesh device.",
  );

export const meshTools: ToolDefinition[] = [
  {
    name: "list_devices",
    description:
      "List all Talon companion mesh devices with id, platform, online presence, last-seen age, battery state, last-known location, and supported commands.",
    schema: {},
    execute: (_params, bridge) => bridge("list_devices", {}),
    tag: "mesh",
  },
  {
    name: "get_device_location",
    description:
      "Get any Talon companion device's current or last-known location. Sends an on-demand locate request first, waits briefly for a fresh GPS fix, then falls back to last-known. With no device, uses the most recently seen mobile device.",
    schema: { device: deviceParam },
    execute: (params, bridge) => bridge("get_device_location", params),
    tag: "mesh",
  },
  {
    name: "get_device_history",
    description:
      "Movement and battery history for a Talon companion device: a timeline of its reported locations over a window (default 24h, max 168h), with distance traveled and battery trend. Answers questions like where a device was earlier or how fast its battery is draining.",
    schema: {
      device: deviceParam,
      hours: z
        .number()
        .optional()
        .describe("History window in hours (1-168, default 24)."),
    },
    execute: (params, bridge) => bridge("get_device_history", params),
    tag: "mesh",
  },
  {
    name: "ring_device",
    description:
      "Make a Talon companion device ring/vibrate so it can be found (find-my-phone). Optionally include a short message the device may display.",
    schema: {
      device: deviceParam,
      message: z
        .string()
        .optional()
        .describe("Optional short note to show on the device."),
    },
    execute: (params, bridge) => bridge("ring_device", params),
    tag: "mesh",
  },
  {
    name: "remove_device",
    description:
      "Remove a stale device from the mesh registry (with its stored location and history). Use for superseded installs and old duplicates — e.g. a reinstalled companion that re-registered under a new id, leaving the old entry as an offline ghost. Requires an explicit device id or name (no default target). Removing a still-connected device is pointless: it re-registers on its next heartbeat within ~60s.",
    schema: {
      device: z
        .string()
        .describe(
          "Device id, exact name, or unique name fragment of the entry to remove (see list_devices). Prefer the id when duplicates share a name.",
        ),
    },
    execute: (params, bridge) => bridge("remove_device", params),
    tag: "mesh",
  },
  {
    name: "get_device_status",
    description:
      "Get live status straight from a Talon companion device: battery and charging state, platform/OS details, app version, and mesh sharing settings.",
    schema: { device: deviceParam },
    execute: (params, bridge) => bridge("get_device_status", params),
    tag: "mesh",
  },
  {
    name: "device_exec",
    description:
      "Run a shell command ON a Talon companion device (e.g. the phone) and return its stdout/stderr/exit code. The device executes it at the highest privilege it has (Android: root if the device grants it, else Shizuku's shell UID, else the app UID; the result's `via` says which). Use for on-device tasks like tidying a folder. Prefer `teleport` for a sustained session. For persistent streams (log tailing, watchers), background with output redirected to a file — `cmd > /tmp/out.log 2>&1 &` returns immediately; poll the file with device_read_file.",
    schema: {
      device: deviceParam,
      cmd: z.string().describe("The shell command to run on the device."),
      cwd: z
        .string()
        .optional()
        .describe("Working directory on the device to run in."),
      timeout_sec: z
        .number()
        .optional()
        .describe("Max seconds to allow (default 60, max 300)."),
    },
    execute: (params, bridge) => bridge("device_exec", params),
    tag: "mesh",
  },
  {
    name: "device_list_dir",
    description:
      "List a directory on a Talon companion device (name, type, size per entry).",
    schema: {
      device: deviceParam,
      path: z.string().describe("Absolute directory path on the device."),
    },
    execute: (params, bridge) => bridge("device_list_dir", params),
    tag: "mesh",
  },
  {
    name: "device_read_file",
    description:
      "Read a (text) file off a Talon companion device and return its contents. Small files ride the command channel; big files stream over HTTP automatically. No size cap.",
    schema: {
      device: deviceParam,
      path: z.string().describe("Absolute file path on the device."),
    },
    execute: (params, bridge) => bridge("device_read_file", params),
    tag: "mesh",
  },
  {
    name: "device_write_file",
    description:
      "Write text content to a file on a Talon companion device (creates/overwrites).",
    schema: {
      device: deviceParam,
      path: z.string().describe("Absolute file path on the device."),
      content: z.string().describe("Text content to write."),
    },
    execute: (params, bridge) => bridge("device_write_file", params),
    tag: "mesh",
  },
  {
    name: "device_pull_file",
    description:
      "Copy a file FROM a Talon companion device to the daemon host (workspace). Streams disk-to-disk in a single HTTP request at full throughput (no size cap; chunked fallback for old app builds). Lands in workspace/mesh-pull/ unless a local path is given.",
    schema: {
      device: deviceParam,
      remote_path: z.string().describe("Absolute source path on the device."),
      local_path: z
        .string()
        .optional()
        .describe("Destination under the workspace (optional)."),
    },
    execute: (params, bridge) => bridge("device_pull_file", params),
    tag: "mesh",
  },
  {
    name: "device_push_file",
    description:
      "Copy a file FROM the daemon host (workspace) TO a Talon companion device. Streams disk-to-disk in a single HTTP request at full throughput (no size cap; chunked fallback for old app builds).",
    schema: {
      device: deviceParam,
      local_path: z.string().describe("Source path under the workspace."),
      remote_path: z
        .string()
        .describe("Absolute destination path on the device."),
    },
    execute: (params, bridge) => bridge("device_push_file", params),
    tag: "mesh",
  },
  {
    name: "update_device",
    description:
      "Remotely update a Talon companion (Android): stream a new APK from the daemon to the device and silently reinstall it at an elevated tier (root or Shizuku), keeping app data. The companion's mesh runs in a foreground service that auto-restarts after the package is replaced, so the connection returns on its own within seconds — no manual reopen. The APK is hashed and the device verifies it before installing (a truncated push is refused; a differently-signed APK is refused by Android). Requires the device to have device control on and either root or Shizuku granted. Confirm success with get_device_status afterwards (appVersion should change).",
    schema: {
      device: deviceParam,
      apk_path: z
        .string()
        .describe(
          "Path to the new APK, relative to the workspace (or absolute).",
        ),
      remote_path: z
        .string()
        .optional()
        .describe(
          "Where to stage the APK on the device (default /sdcard/Download/talon-companion-update.apk).",
        ),
      allow_downgrade: z
        .boolean()
        .optional()
        .describe(
          "Install even when the APK has a lower versionCode (pm install -d), for a deliberate rollback.",
        ),
    },
    execute: (params, bridge) => bridge("update_device", params),
    tag: "mesh",
  },
  {
    name: "update_node",
    description:
      "Remotely update a headless talon-node (Linux/macOS/Windows server on the mesh): stream a new node binary from the daemon and have the node verify its hash, atomically swap its own binary, and restart into it. On Linux/macOS this is an in-place execve so the mesh connection returns within seconds; the node re-hashes the pushed file and refuses a truncated or mismatched binary. With no binary_path, the daemon auto-resolves the right build for the node's registered platform/arch (source build in a dev checkout, else the digest-verified release download matching this Talon version) — the normal call is just update_node(device). Confirm success with get_device_status afterwards (appVersion should change). This is the node counterpart of update_device — use update_device for Android companions.",
    schema: {
      device: deviceParam,
      binary_path: z
        .string()
        .optional()
        .describe(
          "Optional explicit binary, relative to the workspace (or absolute), built for the node's OS/arch. Omit to auto-resolve.",
        ),
      remote_path: z
        .string()
        .optional()
        .describe(
          "Where to stage the binary on the node (default /tmp/talon-node.update; the node re-stages next to its own executable before the atomic swap).",
        ),
      allow_downgrade: z
        .boolean()
        .optional()
        .describe(
          "Install even when the binary is an older version, or the exact build already running. The node refuses both without it.",
        ),
    },
    execute: (params, bridge) => bridge("update_node", params),
    tag: "mesh",
  },
  {
    name: "get_node_binary",
    description:
      "Materialize a talon-node binary (the headless mesh device) for any supported platform/arch on the daemon host and return its path, version, and sha256. Resolution order: built from source when running in a dev checkout with Go, else the cached copy, else the digest-verified download from this Talon version's GitHub release — so it works on prebuilt installs with no toolchain. Use it to stage a binary for manual deployment (scp, device_push_file); for onboarding a fresh host prefer make_node_install_link, and for updating an existing node just call update_node (which resolves automatically).",
    schema: {
      os: z.string().describe("Target OS: linux, macos/darwin, or windows."),
      arch: z
        .string()
        .describe("Target arch: amd64/x86_64, arm64/aarch64, or arm."),
    },
    execute: (params, bridge) => bridge("get_node_binary", params),
    tag: "mesh",
  },
  {
    name: "make_node_install_link",
    description:
      "Mint a single-use install link served by this daemon's bridge and return the one command that attaches a fresh Linux/macOS/Windows host to the mesh as a headless talon-node. Running it on the host downloads the installer script and binary from the bridge (sha256-verified), installs talon-node, pre-pins the bridge TLS certificate, embeds the bearer token, and registers a boot service — no toolchain, package manager, or manual config on the host. The link expires in 30 minutes and each leg serves exactly once; the host only needs to reach the bridge URL. Requires the native bridge running on a non-loopback bind with a token.",
    schema: {
      os: z.string().describe("Host OS: linux, macos/darwin, or windows."),
      arch: z
        .string()
        .describe("Host arch: amd64/x86_64, arm64/aarch64, or arm."),
      name: z
        .string()
        .optional()
        .describe(
          "Device name to register with (default: the host's hostname).",
        ),
      bridge_url: z
        .string()
        .optional()
        .describe(
          "Bridge base URL as reachable FROM the new host (e.g. https://100.64.0.7:19880). Default: derived from the bridge bind (wildcard binds use this host's first external IPv4).",
        ),
    },
    execute: (params, bridge) => bridge("make_node_install_link", params),
    tag: "mesh",
  },
];
