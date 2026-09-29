# Companion device control (teleport) + Shizuku

The Talon companion answers remote **exec / filesystem** commands over the
mesh — the device half of `teleport`. This page covers the app-UID and Shizuku
tiers; **root** (and the system-uid ROM build) is
[companion-root.md](companion-root.md), and it outranks everything here.

## 1. App-UID (default, always available)

Shell commands run via `sh -c` as the app's own Linux user; file IO uses
`dart:io`. Reachable surface:

- The app's private storage — always.
- **Shared storage** (Downloads, DCIM, Documents, …) once the app holds
  **All files access** (`MANAGE_EXTERNAL_STORAGE`). Grant it manually:
  Settings → Apps → Talon → Permissions → *Allow management of all files*
  (the permission is declared in the manifest; there is no runtime dialog for
  it, it must be toggled in system settings). Not on the Play Store, so no
  policy justification is needed.
- **Not** other apps' private data or `/data` — that needs root or Shizuku.

This tier is enough for "clean up my Downloads folder", moving/reading/writing
files in shared storage, and running ordinary shell tools that ship with
Android (`ls`, `rm`, `mv`, `find`, `cat`, …).

Toggle in the app: **Settings → Mesh → Device control** (default ON). When
off, the device advertises no exec/fs capabilities and refuses those
commands.

Root and Shizuku are a separate switch, **Settings → Mesh → Elevated access**
(default ON, Android only). While it is off, commands run at this app-UID tier
and the app never asks the root manager or Shizuku for a grant.

Restrictions you can opt into, in the same card:

- **Ask again for each pairing** (default off). Every newly paired bridge
  starts with device control and elevated access off, and a grant holds only
  for the bridge it was given to: pointing the app at another bridge turns
  both off until you enable them there.
- **Commands at once** (default 4) and **Commands waiting** (default 16).
  Beyond both, a command is answered "busy" straight away.
- **Largest file write** (default 4 GiB, the same as talon-node). A
  `write_file` or `download_file` that would grow a file past it is refused.

Upgrading from a release where both switches defaulted to off: an install
that never changed them gets the new defaults. A switch you turned off in
Settings stays off.

## 2. Shizuku (optional, elevated)

When the [Shizuku](https://shizuku.rikka.app/) app is installed and running
(started via wireless ADB or root), exec commands run at **shell (ADB) UID** —
far more of the system than the app UID, without rooting the device.

If Shizuku's own server was started while `adbd` was root (`adb root` first),
that server runs at uid 0 and these commands are really **root** commands.
Talon reads `Shizuku.getUid()` and reports the tier it actually gets.

Wiring (already in this repo):

- `android/app/build.gradle.kts` — `dev.rikka.shizuku:api` + `:provider`.
- `AndroidManifest.xml` — the `rikka.shizuku.ShizukuProvider` and the
  `moe.shizuku.manager.permission.API_V23` permission.
- `ShizukuBridge.kt` — a `MethodChannel("talon/shizuku")` exposing
  `isReady` / `requestPermission` / `exec`. Exec uses the (stable, hidden)
  `Shizuku.newProcess` via reflection.
- Dart `DeviceExec` prefers Shizuku when `isReady()` and **falls back to
  app-UID on any failure**, so the app works with or without Shizuku.

To enable at runtime: install Shizuku, start its service, then let Talon
request permission (first elevated command triggers the grant dialog).

## 3. Remote self-update (`update_device`)

Shizuku's shell UID also lets the companion **silently update itself** over the
mesh, without a manual reopen or losing the connection for more than a couple
of seconds.

The `update_device` tool:

1. Hashes the new APK on the daemon (streamed SHA-256) and **streams it** to
   the device (default `/sdcard/Download/talon-companion-update.apk`).
2. Sends `install_apk` with that digest. The device **re-stages the APK into a
   fresh private directory under `/data/local/tmp`** (`mktemp -d`, mode 0700,
   random name) via the elevated shell, in a single invocation: the push lands on app storage
   (`/sdcard/Download`), which the shell can read but the system installer
   cannot — `pm install` straight off an app-FUSE path fails with
   `Failed transaction`. It then **re-hashes the staged copy** (the file `pm`
   actually reads) and refuses to install on a mismatch — a truncated transfer
   can never be installed. (`pm install -r` also refuses a differently-signed
   APK, so a wrong file can't hijack the app.)
3. The device runs `pm install -r` (keep data; no `-d`, so an older build is
   refused) **detached** via `setsid` after a short delay, re-checking the
   digest of the staged copy immediately before `pm` reads it, so the "staged" ack flushes
   over the mesh *before* `pm` tears the app down, and the install finishes
   even as the app process dies (its parent is the Shizuku server, not the app).

**Why the connection survives:** the mesh runs inside a foreground service with
`autoRunOnMyPackageReplaced = true` (see `mesh_background.dart`). When
`pm install -r` replaces the package, Android broadcasts `MY_PACKAGE_REPLACED`
and the service — hence the whole mesh loop — auto-restarts and reconnects. The
link drops only for the seconds the process is being swapped.

Requirements: **device control on** + **elevated access on** + **Shizuku granted** (silent install needs
shell UID; the app UID can't install a package without a user tapping through
PackageInstaller). Without Shizuku, `install_apk` returns a clear "needs
Shizuku" message and nothing is installed.

Confirm success with `get_device_status` after it reconnects — `appVersion`
should reflect the new build.

### Build note

The Dart layer + tests are verified locally (`flutter analyze` + `flutter
test`, all green). The **Android/Kotlin/Gradle build (Shizuku deps + native
bridge) is device-pending** — it needs a real `flutter build apk` on a machine
with the Android SDK to confirm the Shizuku artifacts resolve and the reflective
`newProcess` call links against the installed Shizuku version. If the Shizuku
deps ever fail to resolve, the app still builds and runs on the app-UID tier;
remove the two `dev.rikka.shizuku` lines + the manifest provider to drop
Shizuku entirely.
