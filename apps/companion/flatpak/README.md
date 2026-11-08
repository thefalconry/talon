# Talon Companion — Flatpak

Packaging for publishing the Linux desktop companion on
[Flathub](https://flathub.org) as `io.github.thefalconry.TalonCompanion`.

| File | Purpose |
| --- | --- |
| `io.github.thefalconry.TalonCompanion.yml` | flatpak-builder manifest |
| `io.github.thefalconry.TalonCompanion.metainfo.xml` | AppStream metadata (store listing) |
| `io.github.thefalconry.TalonCompanion.desktop` | Desktop entry |
| `icons/` | 128/256 px PNG + scalable SVG, derived from `assets/icon/talon_icon.*` |

The manifest **repackages the prebuilt release bundle**
(`talon-companion-linux.tar.gz`, built by `.github/workflows/companion.yml`)
instead of compiling Flutter inside flatpak-builder. That keeps the Flatpak in
lockstep with the tarball everyone else downloads, and needs no Flutter SDK in
the build sandbox.

## Test it locally

Needs `flatpak` and `flatpak-builder` (Fedora: `sudo dnf install flatpak
flatpak-builder`), plus the Flathub remote:

```sh
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo

cd apps/companion/flatpak
# The manifest pulls libayatana-appindicator from Flathub's shared-modules
# (a git submodule in the Flathub repo). Locally, just clone it alongside:
git clone --depth 1 https://github.com/flathub/shared-modules.git

flatpak-builder --user --install-deps-from=flathub --install --force-clean \
  build-dir io.github.thefalconry.TalonCompanion.yml

flatpak run io.github.thefalconry.TalonCompanion
```

Worth checking on a test run:

- The window opens (Wayland and, with `--nosocket=wayland`, X11) and renders.
- It attaches to a daemon on this machine (`127.0.0.1`) and to a remote one.
- **Attach file** opens the desktop's own file chooser (portal), and a chosen
  file uploads. Dragging a file from the file manager onto the chat works.
- Settings → Updates reads *"Updates are managed by Flatpak"* and makes no
  requests; Settings → Mesh shows **Device control** greyed out.
- Links in replies open in the host browser.

Lint the manifest and metadata the way Flathub CI does:

```sh
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest io.github.thefalconry.TalonCompanion.yml
flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo repo   # after building with --repo=repo
appstreamcli validate io.github.thefalconry.TalonCompanion.metainfo.xml
desktop-file-validate io.github.thefalconry.TalonCompanion.desktop
```

## Submitting to Flathub

Flathub builds from its own per-app repo, not from this one:

1. Fork [flathub/flathub](https://github.com/flathub/flathub) and branch off
   its `new-pr` branch.
2. Add the manifest, metainfo, desktop file and icons (same layout as here),
   and add shared-modules as a submodule:
   `git submodule add https://github.com/flathub/shared-modules.git`.
3. Open a PR against `new-pr`. Reviewers build it and review the permissions;
   the verification step for an `io.github.thefalconry.*` id is done by the
   owner of that GitHub account.
4. Once merged, Flathub creates `flathub/io.github.thefalconry.TalonCompanion`
   and gives the maintainer push access. From then on that repo is where the
   manifest lives.
5. Updates are automatic: the `x-checker-data` block on the release archive
   makes Flathub's
   [external data checker](https://github.com/flathub-infra/flatpak-external-data-checker)
   watch `releases/latest` and open a PR bumping `url` + `sha256` (and adding a
   `<release>` to the metainfo) whenever a new `vX.Y.Z` is published. Merging
   that PR ships the update.

Keep the copy in this directory in sync with the Flathub repo (or delete it
here after the first merge and link to the Flathub repo instead).

## How the app behaves inside the sandbox

`lib/src/services/sandbox.dart` detects Flatpak (`FLATPAK_ID` set, or
`/.flatpak-info` present). When it does:

- **Self-updater off.** `/app` is read-only and Flathub owns updates, so
  `UpdateService` never checks, schedules or downloads, and the Updates card
  says updates are managed by Flatpak.
- **Client-only mesh.** Mesh device control (exec, file read/write, streamed
  transfers, `install_apk`) is neither advertised nor answered: inside the
  sandbox those commands would only reach the sandbox, not the host. `locate`,
  `ring` and `status` still work.

## Known limitations

- **Client only.** The Flatpak cannot start a Talon daemon (the "launch if not
  running" path finds no `talon` binary in the sandbox and reports it); it
  attaches to one that is already running — locally over `127.0.0.1`
  (`--share=network` shares the host's network namespace) or remotely.
- **x86_64 only.** CI only publishes an x86_64 Linux bundle. aarch64 needs an
  arm64 Linux build in `companion.yml` (e.g. an `ubuntu-24.04-arm` runner) and
  a second arch-gated source in the manifest.
- **Wayland app id.** The bundle's GTK application id is
  `org.talon.talon_companion` (set by `flutter create` in CI), not the Flatpak
  id. The desktop file's `StartupWMClass` maps it back so docks show the right
  icon. Changing `APPLICATION_ID` in CI would be cleaner, but it also moves
  `shared_preferences` storage for existing non-Flatpak Linux users (saved
  connections) — so it needs a migration first.
- **Launch at login** writes an autostart entry inside the sandbox, where the
  session never reads it. The proper fix is the Background portal
  (`org.freedesktop.portal.Background.RequestBackground`).
- **Prebuilt binary.** Flathub accepts repackaged upstream binaries, but
  prefers building from source. A later step would be a source build with the
  Flutter SDK as a module and the pub dependencies vendored as generated
  sources (e.g. with [flatpak-flutter](https://github.com/TheAppgineer/flatpak-flutter)).
  That is a lot more manifest for the same output, so this starts with the
  release bundle.
