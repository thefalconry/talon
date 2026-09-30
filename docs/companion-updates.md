# Companion self-update

The companion app keeps itself current: it watches Talon's GitHub releases,
and installs the build for the platform it is running on. This is the "how it
works / what to do when it doesn't" page; the user-facing summary is in
[apps/companion/README.md](../apps/companion/README.md).

## The shape of it

**Automatic checking, manual installing.** A check runs on launch and every six
hours after (`UpdateService.checkInterval`), and costs one ~2 KB request to
`api.github.com/repos/thefalconry/talon/releases/latest`. Nothing downloads
until the user presses **Download & install** in *Settings → Updates* — an app
that silently pulled a 60 MB APK over mobile data, or swapped itself under a
live conversation, would be the wrong kind of automatic. Outside Settings the
only sign of a waiting update is a dot on the settings glyph.

The check can be turned off entirely (*Check automatically*), and a release can
be dismissed with **Skip** — a skipped version is never offered again by a
scheduled check, but **Check now** ignores the skip, because that button is the
user asking.

Source of truth is `/releases/latest`, which excludes drafts and pre-releases,
so only a tagged release-please build is ever offered. Versions are compared as
semver (`4.10.0 > 4.9.0`, `4.2.0-rc.1 < 4.2.0`), never as strings.

## Integrity

Release assets carry a `digest` (`sha256:…`) in the GitHub API. The downloaded
file is checked against it — and against the published size — *before* it is
handed to any installer. A mismatch deletes the download and reports it; it is
never installed. A release whose asset has **no** digest is still offered, but
**Download & install** refuses it up front (nothing is downloaded) with a clear
error pointing at the release page: the length alone cannot tell a swapped
asset from the real one. On Android the elevated path re-hashes the staged copy
in `/data/local/tmp` as well, since that is the file `pm` actually reads.

On Android the APK must also be **this app, signed by this install's key**
before either install path runs: `UpdateBridge.checkSelfUpdateApk` reads the
APK's package name and signing certificates
(`getPackageArchiveInfo(…, GET_SIGNING_CERTIFICATES)`) and compares them with
the running app's (a v3 key-rotation lineage that includes the current key
passes). A mismatch is reported as such and nothing is installed. This check
is for the companion's own update only; the mesh's `install_apk` installs
arbitrary APKs and does not go through it.

The remaining check is the platform's: every desktop swap copies over the
existing install *last*, so a failed unpack leaves the working version in
place.

## Per-platform install path

| Platform | Asset | How it installs |
| --- | --- | --- |
| Android | `talon-companion-android.apk` | Silently via `pm install -r` when root or Shizuku is available (the same pipeline as the daemon's remote `update_device`); otherwise handed to Android's package installer for one tap |
| Linux | `talon-companion-linux.tar.gz` | Unpacked beside the install, then a detached `sh` script waits for the app to exit, `cp -a`s over the install dir and relaunches |
| Windows | `talon-companion-windows.zip` | Same shape, with `Expand-Archive` and a detached PowerShell script (`Wait-Process` → `Copy-Item` → `Start-Process`) |
| macOS | `talon-companion-macos.dmg` | A detached script mounts the DMG, `ditto`s `Talon.app` over the running bundle, clears the quarantine flag and reopens it |

A running binary cannot overwrite itself, which is why every desktop path ends
in a small detached helper that waits on the app's pid. Nothing is touched
until the user presses **Restart now**; the helper is bounded (~60 s) so a
wedged process can never leave a script spinning.

Both Android paths are worth knowing about:

- **Silent** needs root or Shizuku. `DeviceExec.installApk` re-stages the APK
  into `/data/local/tmp` (the system installer cannot read app-FUSE paths) and
  runs `pm install` detached, so the install survives the app being torn down.
  The mesh foreground service restarts on `MY_PACKAGE_REPLACED`, so the app
  comes back on its own.
- **Package installer** is the ordinary case: `UpdateBridge` hands the APK to
  Android through a `FileProvider` content URI (a `file://` URI for an APK
  throws `FileUriExposedException` on Android 7+). It needs *install unknown
  apps* for Talon — requested at that moment rather than up front, so an app
  that never self-updates never asks for the permission.

## When it declines to update itself

A managed install must not be half-overwritten. Before unpacking anything, the
installer probes the install directory for write access; if it cannot write
(Homebrew, a packaged install under `/opt`, `C:\Program Files` without rights),
it says so and points at the release page instead of failing halfway through.

Other honest dead ends: an app not running from an `.app` bundle on macOS
(e.g. `flutter run`), and any platform with no release asset — both report
"install it yourself" rather than an error.

## Where the code is

| Piece | File |
| --- | --- |
| Feed, version compare, download, verify, phases | `apps/companion/lib/src/services/updater.dart` |
| Per-platform install + swap scripts | `apps/companion/lib/src/services/update_installer.dart` |
| Android package-installer handoff | `apps/companion/android/app/src/main/kotlin/org/talon/companion/UpdateBridge.kt` |
| Settings UI | `apps/companion/lib/src/ui/settings/updates_card.dart` |
| Tests | `apps/companion/test/updater_test.dart`, `test/updates_card_test.dart` |

The asset names are fixed by the packaging step in
`.github/workflows/companion.yml` (`talon-companion-<platform>-<version>.<ext>`) —
`assetNameFor` matches both versioned and legacy unversioned names so in-app
updates stay functional across releases.
