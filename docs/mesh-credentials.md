# Per-device mesh credentials

Every device on the mesh — a companion app, a headless talon-node — now
authenticates with **its own credential**, bound to its device id and limited
to what it needs. The shared `native.token` is a legacy path on its way out.
Tracking issue: #1042 (this is phase 2).

## Why

With one shared token, any device that leaked it (a lost laptop, a rooted
phone, a log line) could act as every other device, command them, read the
config and pair new devices. Removing one device meant re-pairing all of
them. Now:

- a leaked credential is **one device's**, and can do only what that device
  was allowed to do;
- `talon mesh revoke <device>` cuts that one device off — its live streams
  drop immediately — and nobody else notices.

## The credential

```
tdc1.<id: 16 hex>.<secret: 32 random bytes, base64url>
```

The daemon stores only a SHA-256 of the token plus metadata
(`~/.talon/mesh-credentials.json`, 0600): device id, scopes, how it was
issued, created / last used / revoked times. The id is safe to log and show;
the token exists in exactly one place — on the device.

## Scopes

| Scope | What it allows |
| --- | --- |
| `device` | Register and heartbeat **as itself**, report its location, receive its own commands and answer them, move the files the daemon asked it to move |
| `client` | The chat UI: chats, history, search, sending, models, the device list, reading the non-secret settings snapshot and extension lists |
| `operator` | Config writes, plugin/skill toggles, daemon control, logs |

Every bridge route declares the scope it needs in
`src/frontend/native/bridge/routes/table.ts`; the route tests walk the table
and prove each tier on the wire. On top of the scope check, every request that
names a device id (`/events?deviceId=`, `/devices/register`, `/location`,
`/devices/command-result`, `/devices/file`) is checked against the
credential's own device — a credential for A **cannot act as B**, answer B's
commands or claim B's stream. A `device`-only stream receives its own
commands and mesh `locate` pings, never chat traffic.

Defaults: talon-node gets `device`; a companion gets all three —
`device`, `client` and `operator` — so its settings screen can change config
and toggle extensions, as it could with the shared token.

Narrowing is opt-in:

- `native.companionScopes: ["device", "client"]` — every companion paired or
  upgraded from then on stays out of config, extensions and logs.
- `talon mesh scopes <device> device,client` — one device. Scopes set this
  way are marked as hand-set and survive rotation and default changes.

Devices you consider high-risk (rooted, adb over the network, shared
machines) are good candidates for `device` only.

Upgrading from a release where the companion default was `device` +
`client`: on startup the daemon moves every live credential that still holds
exactly that pair to the current default, unless `native.companionScopes`
is set (your list stands) or the credential's scopes were set by hand. A
`talon mesh scopes <device> device,client` run before this release is not
marked, so it is widened too; run it again to narrow that device.

The shared `native.token` and an open loopback bridge (no token configured)
still carry all three scopes — that is what they meant before.

## How devices get one

- **Pairing links** (`/mesh link`) and **node installers**
  (`make_node_install_link`) carry a fresh per-device credential instead of
  the shared token. It is *unbound* until first used: the first device id it
  names binds it for good, and it can never bind to an id another live
  credential already holds (a pairing link can add a device, never take one
  over). Unbound credentials expire after 7 days. A companion credential
  carries `native.companionScopes` (default all three).
- A companion trading the shared token in band that asks for `client` also
  gets `operator` whenever `native.companionScopes` includes it: shipped
  companions ask for `device` + `client` only, a list written before
  `operator` was part of the default.
- **Existing devices** holding the shared token trade it **in band** — no
  re-pairing. The `/devices/register` reply (the 60 s heartbeat) and
  `GET /auth/whoami` tell a shared-token client `action: "upgrade"`; the
  client calls `POST /auth/upgrade` with its device id, persists the returned
  credential (talon-node: its config file, next to the pinned certificate;
  companion: its connection profile) and uses it from then on. Both clients
  write the new token to storage *before* using it, and the daemon keeps the
  replaced credential valid until the new one is first presented — a crash or
  a lost reply can't strand a device.

Wire shapes: `protocol/fixtures/auth_v1.json`, replayed by the daemon, the
companion and talon-node test suites.

## Operating it

```sh
talon mesh                         # credentials, scopes, last use; devices still on the shared token
talon mesh revoke <device|credId>  # revoke now; drops its live SSE sessions
talon mesh rotate <device>         # device re-issues on its next heartbeat; old one expires in 7 days
talon mesh scopes <device> <list>  # e.g. device,client — drops live sessions so the change applies
```

`<device>` is a device id, a name the registry knows, or a credential id.
The `remove_device` tool also revokes the device's credentials.

## Migrating off the shared token

1. Update the daemon. `native.legacySharedToken` defaults to `true`: remote
   clients may still use the shared token, and the daemon logs each device it
   sees doing so.
2. Let devices connect. Current companions and talon-node upgrade themselves
   on their next connect (both self-update, so this is automatic).
3. Run `talon mesh`. When nothing is listed under *Still on the shared
   native.token*, set `native.legacySharedToken: false`, rotate
   `native.token` (delete `~/.talon/keys/bridge-token` or set a new value) and
   restart.

With legacy mode off, the shared token works **only for same-machine,
unproxied clients** — the desktop app and CLI, which read it from the 0600
discovery file. A request relayed by a reverse proxy (any `X-Forwarded-For`,
`Forwarded`, `X-Real-IP` or `X-Forwarded-Host` header) is never treated as
local.

A node started with `TALON_TOKEN=<shared token>` in its environment re-reads
that variable on every start (env overrides the config file). Replace it with
the per-device credential from the node's config once it has upgraded.

## Not in this phase

- **Per-device mTLS client certificates.** The credential model has the hook
  (a credential is an id + a verifier + scopes), but issuing and verifying
  client certificates natively — a gateway CA, CSR enrollment, renewal —
  is its own change. Companion mTLS behind a reverse proxy (docs/mtls.md)
  keeps working unchanged; the bearer inside it is now per-device.
- Auth-failure backoff, a global failure budget, request timeouts and audit
  lines are phase 1 (separate PR).
