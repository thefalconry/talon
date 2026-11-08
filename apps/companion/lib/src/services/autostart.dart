import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:launch_at_startup/launch_at_startup.dart';

import 'log.dart';
import 'sandbox.dart';

/// Desktop launch-at-login.
///
/// Completes the residency story: macOS (menu bar) and Windows (system tray)
/// keep the mesh alive after the window closes; this keeps it alive from
/// boot. Backed by launch_at_startup — SMAppService on macOS, the HKCU Run
/// registry key on Windows, an autostart .desktop entry on Linux.
class Autostart {
  Autostart._();

  /// Whether the launch-at-login toggle can do anything on this build.
  ///
  /// Not inside Flatpak. `launch_at_startup` writes a `.desktop` entry into
  /// `~/.config/autostart` pointing at [Platform.resolvedExecutable], which
  /// inside the sandbox is `/app/bin/...` — a path the host session cannot
  /// run. The entry is written, the toggle reports enabled, and the app
  /// never starts at login: the toggle lies. Flatpak apps request this
  /// through the XDG Background portal instead, so until that exists the
  /// honest thing is not to offer the switch. Same treatment the self-updater
  /// and mesh device control already get.
  ///
  /// [sandboxed] is a test seam; production reads [isFlatpak].
  static bool isSupportedIn({bool? sandboxed}) =>
      !kIsWeb &&
      !(sandboxed ?? isFlatpak) &&
      (Platform.isMacOS || Platform.isWindows || Platform.isLinux);

  static bool get isSupported => isSupportedIn();

  static bool _setup = false;

  static void _ensureSetup() {
    if (_setup) return;
    _setup = true;
    launchAtStartup.setup(
      appName: 'Talon',
      appPath: Platform.resolvedExecutable,
    );
  }

  /// Whether the app is currently registered to start at login. Returns
  /// false (never throws) when unsupported or the OS query fails.
  static Future<bool> isEnabled() async {
    if (!isSupported) return false;
    _ensureSetup();
    try {
      return await launchAtStartup.isEnabled();
    } catch (e) {
      AppLog.warn('autostart', 'isEnabled failed', e);
      return false;
    }
  }

  /// Register/unregister start-at-login. Returns the resulting state so the
  /// UI can reconcile (OS may refuse — e.g. login items disabled by policy).
  static Future<bool> setEnabled(bool enabled) async {
    if (!isSupported) return false;
    _ensureSetup();
    try {
      if (enabled) {
        await launchAtStartup.enable();
      } else {
        await launchAtStartup.disable();
      }
    } catch (e) {
      AppLog.warn('autostart', 'setEnabled($enabled) failed', e);
    }
    return isEnabled();
  }
}
