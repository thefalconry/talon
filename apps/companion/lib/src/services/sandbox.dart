import 'dart:io' show File, Platform;

/// Whether the process is running inside a Flatpak sandbox.
///
/// Flatpak exports `FLATPAK_ID` into every sandboxed process and bind-mounts
/// `/.flatpak-info` at the sandbox root; either one is enough. Both probes are
/// injectable so the check is testable off-Flatpak.
///
/// Inside Flatpak the app directory is read-only and Flathub owns updates, and
/// the sandbox only reaches its own filesystem — so callers use this to turn
/// off the self-updater and the mesh device-control (exec/fs) surface.
bool detectFlatpak({
  Map<String, String>? environment,
  bool Function(String path)? fileExists,
}) {
  final env = environment ?? Platform.environment;
  if ((env['FLATPAK_ID'] ?? '').isNotEmpty) return true;
  final exists = fileExists ?? (String p) => File(p).existsSync();
  try {
    return exists('/.flatpak-info');
  } catch (_) {
    return false;
  }
}

/// [detectFlatpak] for this process, computed once. Flatpak only exists on
/// Linux, so every other platform short-circuits without touching the disk.
final bool isFlatpak = Platform.isLinux && detectFlatpak();
