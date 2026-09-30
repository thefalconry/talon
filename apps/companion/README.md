# Talon Companion

A beautiful, cross-platform client for [Talon](../../README.md) — one Flutter
codebase for **Windows, macOS, Linux, and Android** (iOS/web build too).

It speaks the **Talon Client Bridge Protocol** (HTTP + Server-Sent Events) to a
Talon daemon running the `native` frontend:

- **Desktop** — zero-config local mode: start Talon on the same machine and
  the app finds its bridge automatically.
- **Mobile / remote** — connects to a Talon bridge over the network by host/IP
  + token, so your phone can drive a Talon running on your desktop or a server.

The bridge is client-agnostic: this app is the reference client, but anything
that speaks the protocol works.

## Features

- Multiple chats with a time-grouped, searchable history sidebar (ChatGPT-style)
- Live streaming replies, with the model's reasoning and tool calls shown inline
- Full Markdown rendering (code blocks, tables, lists, links)
- **Attach anything** — images, archives, PDFs, code, audio/video: any number
  of files per message, picked with the paperclip or **dragged and dropped
  onto the conversation** on desktop. Files stream to the daemon (nothing is
  held in memory) and the model is handed each one's path to read.
- Per-chat **model** + **reasoning effort** + **session reset**
- **Settings sync** — read and change the daemon's own config (default model,
  display name, timezone, pulse/heartbeat/dream) and see live status
- `⌘K` command palette — run an action, jump to a chat, search messages
- Remote bridge profiles for phones or other machines
- Light and dark palettes with a personalizable accent
- **Self-updating** — the app watches Talon's releases and installs the next
  one itself (silently on a rooted/Shizuku phone, swap-and-relaunch on
  desktop). See [Updates](#updates).

See [docs/companion-ui.md](../../docs/companion-ui.md) for a visual tour of the
main surfaces and the reasoning behind their layout.

## Installing (macOS)

Grab `talon-companion-macos.dmg` from the latest release, open it, and drag
**Talon** onto the **Applications** link.

The build is ad-hoc signed but **not notarized** (that requires a paid Apple
Developer account), so Gatekeeper warns on first launch. Either:

- **right-click Talon.app → Open → Open** (only needed once), or
- clear the quarantine flag: `xattr -dr com.apple.quarantine /Applications/Talon.app`

The DMG art (`assets/dmg/`, rendered by `scripts/render-dmg-background.py`)
and the volume icon are wired up in `.github/workflows/companion.yml`.

## Installing (Windows)

Grab `talon-companion-windows-setup.exe` from the latest release and run it —
a standard installer that puts **Talon** under your user profile (no admin
prompt) with Start-menu and optional desktop shortcuts. Prefer no installer?
`talon-companion-windows.zip` is the same build unpacked; extract it anywhere
and run `talon_companion.exe`.

The installer is unsigned, so SmartScreen may warn on first run — choose **More
info → Run anyway**. Its Inno Setup script lives at
`installer/windows/talon-companion.iss` and is compiled in
`.github/workflows/companion.yml`.

## Installing (Linux)

Four options are published for each release:

- **AppImage** (`talon-companion-linux-<version>.AppImage`): standalone portable
  executable. Make it executable (`chmod +x talon-companion-linux-*.AppImage`)
  and run it directly on any modern distribution.
- **Debian / Ubuntu package** (`talon-companion_<version>_amd64.deb`): standard
  `.deb` package. Install with `sudo dpkg -i talon-companion_*.deb` or
  `sudo apt install ./talon-companion_*.deb`.
- **Fedora / RHEL / openSUSE package** (`talon-companion-<version>-1.x86_64.rpm`):
  standard `.rpm` package. Install with `sudo dnf install ./talon-companion-*.rpm`
  or `sudo rpm -i talon-companion-*.rpm`.
- **Portable archive** (`talon-companion-linux-<version>.tar.gz`): unpack anywhere
  and run `talon_companion`.

Packaging manifests and scripts live under `installer/linux/` and run in
`.github/workflows/companion.yml`.

## Updates

*Settings → Updates* shows what's running, what's available, and one button to
move between the two. The app checks Talon's GitHub releases on launch and
every six hours; **nothing downloads until you press Download & install**, and
a waiting update shows up elsewhere only as a dot on the settings glyph.

On desktop the update is unpacked next to the install and applied by a small
detached helper when you press **Restart now** — a running binary can't
overwrite itself. On Android it installs silently with root or Shizuku, and
otherwise goes through Android's own package installer (one tap; Talon asks
for *install unknown apps* only at that point).

Downloads are checked against the release's published SHA-256 before anything
is installed, and a managed install the app can't write to (Homebrew, `/opt`,
`C:\Program Files`) is reported rather than half-overwritten.

Full mechanism: [docs/companion-updates.md](../../docs/companion-updates.md).

## App lock

*Settings → App lock* (off by default) puts a passcode — 6+ digits or a
password — in front of the app, with Touch ID / Windows Hello / Android
fingerprint or face as an optional shortcut (Linux: passcode only). The app
locks on launch and after a chosen time away or idle (default 5 minutes).

- **What it covers:** the UI (every screen, dialog and `talon://pair` prompt
  waits behind it), the offline chat cache, which is encrypted at rest while
  the lock is on, and notification text, which is hidden. With *Require unlock
  for elevated commands*, mesh shell/file/install commands also wait for an
  approval on the device, and are refused when the app isn't open.
- **What it doesn't:** the connection and the background mesh keep running
  while locked, so locking the app never takes the device off the mesh.
- The passcode is never stored. An Argon2id verifier and a passcode-wrapped
  data key sit in the platform secure store. Failed attempts back off 1s, 2s,
  4s and so on up to 60s. *Erase connection after 10 failed attempts* is
  optional. *Forgot passcode?* resets the lock and the pairing.

## Running it

Requires the [Flutter SDK](https://docs.flutter.dev/get-started/install)
(3.27+). `macos/` and `android/` are committed real source (with the
required entitlement/manifest patches already applied — see below), so
there's no scaffold step for those. `windows/`, `linux/`, `ios/`, and
`web/` are still generated on demand:

```bash
cd apps/companion
flutter create --platforms=windows,linux .   # one-time scaffold for the rest
flutter pub get
flutter run -d macos       # or android / windows / linux
flutter run -d <android-device>
```

**Why `macos/`/`android/` are committed instead of scaffolded:** Flutter's
default macOS template enables App Sandbox but omits the outbound-network
entitlement (`com.apple.security.network.client`), and Android blocks plain
HTTP by default since API 28 — and this bridge is HTTP-only, no TLS. Both
silently break remote-bridge connections (`SocketException ... Operation
not permitted, errno = 1` on macOS; a cleartext-blocked error on Android)
even with a correct host/port/token, and a fresh `flutter create` would
re-drop the fix every time. So instead of a script someone has to remember
to re-run, those two platforms are tracked as normal source, just like any
other Flutter app ships. If you ever need to re-scaffold either from
scratch, use `scripts/fix-macos-entitlements.sh` /
`scripts/fix-android-cleartext.sh` (idempotent) or dispatch
`.github/workflows/companion-scaffold.yml`.

On first launch, pick **This computer** (desktop) or **Remote bridge** (enter a
host/IP + token).

In **This computer** mode, Talon must already be running with the `native`
frontend. When the native bridge starts, Talon writes
`~/.talon/native-bridge.json` with the loopback host, actual bound port,
optional token, scheme, process id, protocol version, and timestamps. The file
is mode `0600` because it can contain the bridge token. The companion reads
that file and connects to `127.0.0.1` automatically, including when Talon had to
fall back to the next free port.

For remote access, run the daemon with a reachable bridge:

```jsonc
// ~/.talon/config.json
{
  "frontend": "native",
  "native": { "host": "0.0.0.0", "port": 19880, "token": "your-secret" }
}
```

An off-loopback bridge serves **HTTPS by default** with a certificate the
daemon mints and keeps under `~/.talon/keys/` (`"tls": false` opts out). The
app pins the certificate's SHA-256 fingerprint on the first successful
connect — compare it against the one the daemon logs at startup — and
refuses to connect if it ever changes; reconnecting from the connection
screen resets the pin. Local zero-config discovery reads the fingerprint
from `native-bridge.json` directly, so no first-use adoption is needed
there.

**Behind a reverse proxy with client certificates** (the Immich setup, see
[docs/mtls.md](../../docs/mtls.md)):

- **Import certificate** on the connect screen takes a `.p12`/`.pfx` and its
  password, and the app presents the certificate on every connection. The
  bridge token is still required as usual.
- **Local network address** (optional) is used whenever it answers, and the
  main address otherwise. The app re-checks when the network changes, and the
  background mesh service re-checks on every reconnect.

## Protocol

The wire contract lives on the daemon side in
[`src/frontend/native/protocol.ts`](../../src/frontend/native/protocol.ts)
and is mirrored in Dart under [`lib/src/models/`](lib/src/models). Endpoints:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/health` | Identity + status (unauthenticated) |
| GET  | `/events` | SSE stream of all events |
| GET/POST | `/chats` `/chats/rename` `/chats/delete` `/chats/reset` `/chats/pulse` | Chat management |
| POST | `/queue` | Set/replace/clear a chat's queued follow-up |
| GET  | `/history?chatId=` | Recent messages |
| POST | `/send` | Send a user message |
| GET/POST | `/models` `/model` `/effort` | Model + effort |
| GET/POST | `/config` | Read / change daemon settings |
| POST | `/control` | Daemon-level actions (`restart`, `dream`) |

All non-`/health` routes accept a bearer token (`Authorization: Bearer …`, or
`?token=` for the SSE stream) when the daemon is configured with one.
