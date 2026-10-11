# Headless mesh nodes (talon-node)

Servers and VMs can join the device mesh without the Flutter companion app:
`apps/node` builds **talon-node**, a single static Go binary that speaks the
client bridge protocol directly. The daemon and every companion app see it
as a normal mesh device; `teleport`, `device_exec`, and the streamed file
transfer tools work unchanged.

## Why a separate binary

The companion app is the right client for phones and laptops — GUI, GPS,
battery telemetry, notifications. For a rack server none of that applies,
and shipping Flutter to a headless box is heavy. The bridge protocol is
deliberately client-agnostic (`src/frontend/native/protocol.ts`), so a mesh
device only needs four HTTP touchpoints:

| Touchpoint                     | Purpose                                 |
| ------------------------------ | --------------------------------------- |
| `POST /devices/register`       | registration + 60s heartbeat (presence) |
| `GET /events?deviceId=` (SSE)  | receive `device_command` events         |
| `POST /devices/command-result` | answer commands by correlation id       |
| `GET/POST /devices/file`       | streamed transfers via one-time tokens  |

Each device names itself with `deviceId` on the event stream and on
`/devices/file`. Commands are addressed to the claiming client rather than
broadcast (their params carry transfer tokens and command lines), and a
transfer token is only redeemable by the device it was minted for. Every
command result must carry its `deviceId` too — an unattributed answer is
dropped rather than resolving another device's pending command.

talon-node implements exactly that in ~stdlib Go: static binary, no runtime
dependencies, outbound-only networking, TLS pinned to the bridge cert's
SHA-256 fingerprint (trust-on-first-use, then enforced).

## Capability surface

Advertised at registration — the daemon gates commands on this list:

```
ring, status, exec, read_file, write_file, list_dir, stat, delete,
mkdir, move, upload_file, download_file, update_node
```

That is the app's full device-control surface minus `locate` (no GPS) and
`install_apk` (Android self-update), plus `update_node` — the headless
equivalent of remote self-update (`update_device` for the companion). Because
teleport is built entirely on `exec` + the fs commands, a headless node is a
first-class teleport target, including the capped exec output contract
(192 KB head + rolling 64 KB tail) the teleport cwd marker rides on.

The node's `appVersion` tracks the Talon release it was built against
(`<talon-version>+<sha>`), so the mesh shows exactly which Talon each node
matches, and `update_node` streams a new binary + verifies + swaps + restarts
in place — see `apps/node/README.md`.

A node on macOS additionally advertises `computer` (screenshot,
accessibility snapshot, pointer and keyboard), which the daemon exposes as
the `device_computer` tool — see "Desktop control" in `apps/node/README.md`.
Other platforms recognise the command and answer that it is unavailable.

Apart from that one tool, no daemon-side changes were needed — headless nodes registered against an
unmodified bridge.

## Deploying a node

The one-command path — ask the model for an install link
(`make_node_install_link(os, arch)`), then run the returned command on the
new host:

```sh
curl -fsSk --pinnedpubkey "sha256//<bridge-key-pin>" "https://<daemon>:19880/node/install?provision=<token>" | sh
```

The bridge serves a generated installer over a single-use, expiring grant
token (`src/core/mesh/links/node-provision.ts`): it downloads the matching
talon-node binary from the same bridge, verifies its sha256 against the
digest baked into the script, installs it, pre-pins the bridge TLS
fingerprint, embeds the bearer token, and registers the boot service.
Windows grants produce a PowerShell installer with the same flow.

Over HTTPS both fetches are pinned to the bridge's own key, so a man in the
middle can't swap the script or read the grant's credential. curl gets
`--pinnedpubkey` (the base64 SHA-256 of the key's SPKI); `-k` stays because
the certificate is self-signed and curl would otherwise reject the chain,
but curl enforces the pin with or without `-k`. PowerShell (Windows
PowerShell 5.1 and pwsh 7) compiles a small certificate check that compares
the presented certificate's SHA-256 with the fingerprint talon-node pins
afterwards. Over plain HTTP there is nothing to pin. `bridge_url` and
`native.publicUrl` must be plain http(s) URLs without quotes, `$`,
backticks, backslashes, `%` or whitespace, since they are written into the
generated scripts. The two
routes (`GET /node/install`, `GET /node/binary`) are deliberately pre-auth —
the fresh host holds no credential yet; the grant token is the entire
authorization, exactly like streamed-transfer tokens.

Manual alternative — see `apps/node/README.md` for flags, config, and
service install (systemd/launchd/scheduled task):

```sh
talon-node install --bridge https://<daemon>:19880 --token <bridge-token> --name my-server
```

Remote nodes are best pointed at the daemon over a tailnet/VPN address —
the bridge token grants the full bridge API, so avoid exposing the port
publicly. Scoping per-device tokens is a known follow-up.

## Fallback endpoints

A node dials one URL, its configured `bridge`. If the daemon sets
`native.endpoints`, every node also learns other ways to reach the same
bridge from its register reply (the 60 s heartbeat), saves them in its
config (`endpoints`), and fails over to them when the configured URL stops
working. No re-pairing is needed: nodes pick the list up on their next
heartbeat. Nodes and daemons that predate this ignore it.

```json
"native": {
  "publicUrl": "https://mesh.example.org",
  "endpoints": [
    { "url": "https://mesh.example.org", "dial": "203.0.113.7:443", "label": "direct IPv4, no DNS" }
  ]
}
```

- `url` must be https. Its host goes in TLS SNI and the `Host` header, so a
  reverse proxy in front of the bridge routes it as usual.
- `dial` (optional) is an IP literal and port, e.g. `203.0.113.7:443` or
  `[2001:db8::1]:443`. The node connects there instead of resolving the
  URL's host, so a DNS outage doesn't take the mesh down. It works like
  `curl --resolve`.
- `publicUrl` is always advertised first. On each node, its own configured
  `bridge` is always tried first and can't be removed by a list. Up to 8
  entries.
- Every entry must present the bridge's own certificate. Nodes keep the
  fingerprint they already pin and refuse an entry that presents any other.
  Trust-on-first-use only ever happens on the configured `bridge`, so an
  unpinned node never uses a learned entry.
- A node moves to the next entry only on a transport failure: DNS, connect,
  TLS or pin, a timeout, or a proxy's 502/503/504. An auth error (401/403),
  404 or 429 would be the same on every entry, so it stays put. While on a
  fallback, it probes the configured bridge's `/health` every 5 minutes and
  goes back once it answers. `talon-node status` lists the entries.
- Leaving `endpoints` unset advertises nothing. Setting it to `[]` tells
  nodes to forget a list they learned earlier.

The companion app does not use the list yet.

## Where node binaries come from

`src/core/mesh/links/node-binaries.ts` materializes a binary for any supported
target regardless of how the daemon was installed, trying in order:

1. **source build** — a dev checkout with Go on PATH cross-compiles
   `apps/node` for the target (rebuilt every resolve, stamped
   `<version>+<sha>`);
2. **cache** — `~/.talon/node-bin/<talon-version>/`, digest-re-verified on
   every hit;
3. **release download** — the GitHub release matching the daemon's own
   version, verified against its `talon-node-SHA256SUMS` manifest. This is
   what lets prebuilt installs (npm, deb, standalone binary) provision and
   update nodes with no toolchain.

Everything rides that resolver: `get_node_binary` (stage a binary on the
daemon host), `make_node_install_link` (bridge-served installer), and
`update_node` with no `binary_path` (auto-picks the target's registered
platform/arch — nodes advertise `runtime.GOARCH` at registration).

## Release artifacts

`.github/workflows/node.yml` vets, tests, and cross-compiles
linux/amd64+arm64+arm, darwin/amd64+arm64, and windows/amd64 on every PR
touching `apps/node` (via the platform-neutral `go run ./tools/build`), and
attaches the binaries plus `talon-node-SHA256SUMS` to published releases.
The version.txt drift guard runs on PRs only — release builds stamp from
the tag, so a stale release PR can no longer ship a release with no node
binaries.

A second job on a macOS runner re-signs `talon-node-darwin-amd64` and
`talon-node-darwin-arm64` with the persistent self-signed `Talon Companion`
identity (same secrets as the companion, see
[companion-macos-signing.md](companion-macos-signing.md)) and the fixed
identifier `dev.talon.node`, then recomputes `talon-node-SHA256SUMS` and does
the attestation and release upload. macOS ties Screen Recording and
Accessibility grants to the signature, so with a stable identity they survive
`update_node`. The source-build tier above compiles on the daemon host and
cannot sign with that identity: a darwin binary built that way is ad-hoc
signed, and macOS asks for both grants again after the update.
