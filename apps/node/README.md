# talon-node — headless Talon mesh device

A single static binary that attaches any server, VM, or headless box to a
Talon daemon's device mesh **without the full companion app**. It speaks the
same client bridge protocol the Flutter companion does, so the daemon — and
every companion app — sees it as just another mesh device, and `teleport`
works out of the box.

- **Zero dependencies** on the host: one static Go binary (`CGO_ENABLED=0`,
  stdlib only), ~6 MB. Linux (amd64/arm64/arm), macOS, and Windows.
- **Outbound-only**: the node dials the bridge; nothing listens on the host.
- **Pinned TLS**: the bridge's self-signed certificate is pinned by SHA-256
  fingerprint (trust-on-first-use, then enforced) — same model as the app.
- **Full mesh surface**: `exec`, `read_file`, `write_file`, `list_dir`,
  `stat`, `delete`, `mkdir`, `move`, streamed `upload_file`/`download_file`,
  `status`, `ring`. That is the entire teleport substrate, so
  `teleport(device)` gives the model a real shell + file tools on the node.
- **Remote self-update**: `update_node` — the daemon streams a new binary,
  the node verifies its hash, atomically swaps its own binary, and restarts
  into it (in-place `execve` on Linux/macOS, so the mesh reconnects in
  seconds). Version tracks the Talon release it was built against.

## Quick start

The fastest path needs nothing on this list: ask the Talon model for an
install link (`make_node_install_link`) and run the returned one-liner on
the host — it fetches a digest-verified binary from the daemon's bridge,
installs it, pins the TLS fingerprint, and registers the boot service.

Manual setup:

```sh
# Build (or grab a release binary, or `get_node_binary` via the daemon):
cd apps/node && go build -o talon-node .

# First run — mints a device id, pins the bridge cert on first connect:
./talon-node run --bridge https://<daemon-host>:19880 --token <bridge-token> --name my-server

# Install as a boot service (systemd / launchd / Windows scheduled task):
./talon-node install --bridge https://<daemon-host>:19880 --token <bridge-token>

# Sanity check:
./talon-node status
```

Config lives at `~/.talon-node/config.json` (0600 — it holds the bearer
token). Flags and env vars (`TALON_BRIDGE`, `TALON_TOKEN`,
`TALON_NODE_NAME`) override the file.

The token is this node's **own credential** (`tdc1.…`, device scope only —
see [docs/mesh-credentials.md](../../docs/mesh-credentials.md)); installer
links embed one. A node configured with the daemon's shared bridge token
trades it for its own credential on its first heartbeat and rewrites
`token` in the config. `talon-node status` shows which kind it holds. If you
pass the shared token through `TALON_TOKEN`, replace it with the credential
from the config once the node has upgraded — the env var wins on every
start.

```json
{
  "bridge": "https://100.64.0.7:19880",
  "token": "…",
  "name": "my-server",
  "deviceId": "node-…",
  "fingerprint": "a1eeb640…"
}
```

`deviceId` is minted once and persisted so redeploys/restarts never create
duplicate registry entries. `fingerprint` is captured on the first
successful authenticated connect (TOFU) and enforced afterwards; pre-seed it
via `--fingerprint` for a fully pinned first contact (`/health` on the
bridge reports it).

When the node pins a certificate on first use it logs a banner with the
fingerprint. Compare it with the `Bridge TLS` line of `talon status` on the
daemon host. If they differ, stop the node, delete `fingerprint` from the
config and reconnect with `--fingerprint <the daemon's value>`.

### Strict TLS (opt-in)

Trust-on-first-use stays the default. To refuse any bridge whose
fingerprint was not configured up front, pass `--strict-tls` to `run` or
`install` (saved as `"strictTls": true` in the config):

```sh
./talon-node install --bridge https://<daemon-host>:19880 --token <token> \
  --fingerprint <sha256 from talon status> --strict-tls
```

With strict TLS on, the node:

- refuses to start (and `install` refuses) without a `fingerprint`, or with
  a plain `http://` bridge URL;
- rejects the TLS handshake with an unpinned bridge instead of adopting the
  certificate it sees.

`talon-node status` shows the mode on its `tls mode:` line.
`--strict-tls=false` turns it back off.

### Local command policy

The optional `policy` block controls what the mesh may do on this host. Only
someone who can edit `config.json` can change it. Filesystem commands never
touch the config directory or the node's own binary.

```json
"policy": {
  "disableExec": true,
  "disableUpdate": false,
  "readPaths": ["/srv/share", "/var/log"],
  "writePaths": ["/srv/share"],
  "maxConcurrent": 8,
  "maxWriteBytes": 4294967296
}
```

| Key             | Effect                                                                                  | Default   |
| --------------- | --------------------------------------------------------------------------------------- | --------- |
| `disableExec`   | refuse `exec` (shell) and stop advertising it                                           | `false`   |
| `disableUpdate` | refuse `update_node` and stop advertising it                                            | `false`   |
| `readPaths`     | confine `read_file` / `list_dir` / `stat` / `upload_file` to these trees                | anywhere  |
| `writePaths`    | confine `write_file` / `delete` / `mkdir` / `move` / `download_file` to these trees     | anywhere  |
| `maxConcurrent` | commands running at once. 32 more can queue. Beyond that the answer is "busy"           | `8`       |
| `maxWriteBytes` | largest file `write_file` / `download_file` may produce                                 | 4 GiB     |

Paths are checked after resolving symlinks. Path limits only mean something
with `disableExec`, because a shell can reach any file.

### Command audit

Every mesh command the node runs is logged to `audit.jsonl` next to
`config.json` (0600, the newest 500–999 entries). One JSON line per command:

```json
{"time":"2026-09-28T10:00:00Z","commandId":"…","name":"exec","target":"sha256:…","ok":true,"durationMs":12,"credential":"device:0123456789abcdef"}
```

`target` is the path a filesystem command touched (`from -> to` for
`move`), or the SHA-256 of an `exec` command line. File contents and command
lines are never recorded. `credential` names the bearer the node was using
(`device:<credential id>`, `shared`), never the secret. `talon-node status`
shows the last 10 entries; `talon-node audit [-n 50] [--json]` prints more.
Writing the log never delays or fails a command.

## How it plugs in

```
talon-node                        Talon daemon (native frontend)
──────────                        ──────────────────────────────
POST /devices/register  ── 60s ─▶ mesh registry (presence, capabilities)
GET  /events (SSE)      ◀────────  device_command events (exec, fs, …)
POST /devices/command-result ───▶ resolves the pending mesh tool call
POST/GET /devices/file  ◀───────▶ streamed transfers (one-time tokens)
```

The daemon needs the `native` frontend enabled (the same bridge companion
apps pair with). No daemon-side changes are required for headless nodes.

## Service management

| OS      | Mechanism                                              | Notes                                                     |
| ------- | ------------------------------------------------------ | --------------------------------------------------------- |
| Linux   | systemd unit (system as root, else user)               | user units need `loginctl enable-linger` for boot         |
| macOS   | LaunchAgent (`com.talon.node`)                         | per-user, `KeepAlive` restarts on crash                   |
| Windows | Scheduled task (`TalonNode`, ONSTART, installing user) | runs as you, unelevated, no stored password (`/RU … /NP`) |

The node always runs as the account that installed it, and it never runs as
SYSTEM on Windows. The binary and config sit in that account's own profile,
so a SYSTEM task would run files the user can rewrite. On Windows, creating
the boot task still needs an elevated PowerShell. `talon-node status` flags a
task registered by an older build that still runs as SYSTEM. Re-run
`talon-node install` to replace it.

A root install on Linux (system unit) refuses to register if the binary, the
config, or any directory above them is owned by another user or is
world-writable. For example, `TALON_NODE_DIR` pointed at a user-writable
directory is refused.

## Building all targets

```sh
go run ./tools/build            # → build/talon-node-<os>-<arch>[.exe]
                                #   + build/talon-node-SHA256SUMS
./scripts/build-all.sh          # same thing, POSIX wrapper
```

The builder is a Go program so it runs anywhere Go does (Windows included).
It also emits the `talon-node-SHA256SUMS` manifest the daemon's node-binary
resolver verifies release downloads against. The `Headless Node` workflow
builds the same matrix in CI and attaches binaries + manifest to published
releases.

## Versioning

The reported version tracks the **Talon release the binary was compiled
against**, so a node's `appVersion` in the mesh tells you exactly which Talon
it matches:

- Release/CI and `go run ./tools/build` builds report `<talon-version>+<sha>`
  (e.g. `3.1.1+c8c7437c`), stamped via `-ldflags -X main.ldflagsVersion=…`.
- A bare `go build .` reports the embedded Talon version (`version.txt`,
  kept in sync with the root `package.json` — CI fails if it drifts).

## Remote self-update

`update_node` (daemon-side mesh tool) streams a replacement binary to the
node, which re-hashes it, atomically swaps its own binary, and restarts into
it — an in-place `execve` on Linux/macOS (same pid, no supervisor
crash-accounting), a rename-aside + relaunch on Windows. The command must
carry the binary's `sha256` (the daemon always sends it); a missing digest,
or a truncated or mismatched binary, is refused before the swap, so the
running node is never left broken. The node also reads the pushed binary's
embedded version and refuses an older release, or the exact build it is
already running, unless the command passes `allow_downgrade: true` (the
`update_node` tool's parameter of the same name). A different build of the
same release (a dev checkout at a newer commit) is allowed. With no
`binary_path` the daemon resolves the right build
itself from the node's registered platform/arch (nodes advertise
`runtime.GOARCH`) — source build in a dev checkout, else the digest-verified
release download. Confirm with `get_device_status` once `appVersion`
changes.

On Unix, `SIGHUP` also reloads the node into whatever binary is on disk —
handy for `systemctl reload`-style restarts after an out-of-band swap.

## Capabilities vs. the companion app

Headless nodes do not advertise `locate` (no GPS) or `install_apk`
(Android-only self-update); instead they advertise `update_node` for the
equivalent self-update. Everything else matches the app's device-control
surface, including the capped exec output contract (192 KB head + rolling
64 KB tail) that teleport's cwd tracking depends on.
