import 'package:dynamic_color/dynamic_color.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'linux_theme.dart';
import 'log.dart';

/// Material You: the accent colour the *platform* is already wearing.
///
/// On Android 12+ that's the tonal palette Android extracts from the
/// wallpaper — the same source every Google app themes itself from — so
/// picking "Wallpaper" in Settings makes Talon match the home screen it
/// launches from. macOS and Windows expose their single system accent colour
/// instead, which serves the same purpose there. On Linux, this queries the
/// desktop environment's accent colour (KDE Plasma, GNOME/Ubuntu, LXDE,
/// XDG Desktop Portal). Everywhere else this resolves to null and the swatch
/// simply isn't offered.
///
/// The value is a *seed*: it goes through [TalonAccents.derive] like any
/// preset, so the lightness clamping that keeps an accent readable on both
/// the near-black and paper-white canvases still applies. A garish wallpaper
/// can't produce an unreadable UI.
class DynamicAccent {
  DynamicAccent._();

  /// Whether this platform can report a system colour at all.
  static bool get supported =>
      defaultTargetPlatform == TargetPlatform.android ||
      defaultTargetPlatform == TargetPlatform.macOS ||
      defaultTargetPlatform == TargetPlatform.windows ||
      defaultTargetPlatform == TargetPlatform.linux;

  /// Reads the current system seed, or null when unavailable (Android 11 and
  /// older, a platform without one, or any plugin error — never throws).
  static Future<Color?> seed() async {
    if (!supported) return null;
    if (defaultTargetPlatform == TargetPlatform.linux) {
      return await LinuxThemeService.getAccentColor();
    }
    try {
      final core = await DynamicColorPlugin.getCorePalette();
      // Tone 40 is the Material 3 "primary" tone: saturated enough to read as
      // the wallpaper's colour, not so light it disappears on white.
      if (core != null) return Color(core.primary.get(40));
      return await DynamicColorPlugin.getAccentColor();
    } catch (e) {
      AppLog.warn('theme', 'dynamic accent unavailable', e);
      return null;
    }
  }
}
