import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'log.dart';

enum LinuxDesktop {
  kde,
  gnome,
  lxde,
  other,
}

/// Linux desktop theme mode (dark/light) and accent colour detection.
///
/// Flutter's Linux embedder does not reliably observe dark mode or accent
/// colours across desktop environments (especially KDE Plasma, GNOME 42+
/// XDG portals, and LXDE). This service queries the active desktop
/// environment using native configuration tools, configuration files, and
/// the FreeDesktop Settings portal.
class LinuxThemeService {
  LinuxThemeService._();

  static Brightness? currentBrightness;
  static Color? currentAccentColor;

  static StreamSubscription<FileSystemEvent>? _kdeWatcher;
  static StreamSubscription<FileSystemEvent>? _dconfWatcher;
  static Timer? _pollTimer;

  @visibleForTesting
  static Future<String?> Function(String executable, List<String> arguments)?
      commandRunnerOverride;

  /// Detect the active desktop environment from environment variables.
  static LinuxDesktop detectDesktop([Map<String, String>? environment]) {
    final env = environment ?? (kIsWeb ? const {} : Platform.environment);
    final session = (env['XDG_SESSION_DESKTOP'] ?? '').toLowerCase();
    final current = (env['XDG_CURRENT_DESKTOP'] ?? '').toLowerCase();
    final desktopSession = (env['DESKTOP_SESSION'] ?? '').toLowerCase();

    final all = '$session:$current:$desktopSession';
    if (all.contains('kde') || all.contains('plasma')) {
      return LinuxDesktop.kde;
    }
    if (all.contains('gnome') ||
        all.contains('ubuntu') ||
        all.contains('unity') ||
        all.contains('cinnamon') ||
        all.contains('pop') ||
        all.contains('pantheon')) {
      return LinuxDesktop.gnome;
    }
    if (all.contains('lxde')) {
      return LinuxDesktop.lxde;
    }
    return LinuxDesktop.other;
  }

  /// Execute an external command safely with a timeout.
  static Future<String?> runCommand(
    String executable,
    List<String> arguments, {
    Duration timeout = const Duration(seconds: 2),
  }) async {
    if (commandRunnerOverride != null) {
      return commandRunnerOverride!(executable, arguments);
    }
    if (kIsWeb) return null;
    try {
      final result = await Process.run(
        executable,
        arguments,
        runInShell: false,
      ).timeout(timeout);
      if (result.exitCode == 0) {
        final out = result.stdout.toString().trim();
        return out.isEmpty ? null : out;
      }
    } catch (_) {}
    return null;
  }

  /// Parse a comma-separated RGB string like "61,174,233".
  static Color? parseRgbString(String? input) {
    if (input == null) return null;
    final cleaned = input.trim();
    if (cleaned.isEmpty) return null;
    final parts =
        cleaned.split(',').map((s) => int.tryParse(s.trim())).toList();
    if (parts.length >= 3 &&
        parts[0] != null &&
        parts[1] != null &&
        parts[2] != null) {
      return Color.fromARGB(
        255,
        parts[0]!.clamp(0, 255),
        parts[1]!.clamp(0, 255),
        parts[2]!.clamp(0, 255),
      );
    }
    return null;
  }

  /// Parse AccentColor from ~/.config/kdeglobals.
  static Color? parseKdeGlobalsAccent(String content) {
    bool inGeneral = false;
    for (final line in content.split('\n')) {
      final trimmed = line.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        inGeneral = trimmed.toLowerCase() == '[general]';
        continue;
      }
      if (inGeneral && trimmed.startsWith('AccentColor=')) {
        final value = trimmed.substring('AccentColor='.length).trim();
        return parseRgbString(value);
      }
    }
    return null;
  }

  /// Parse ColorScheme name (e.g. BreezeDark, BreezeLight) into Brightness.
  static Brightness? parseKdeColorScheme(String? name) {
    if (name == null || name.trim().isEmpty) return null;
    final lower = name.trim().toLowerCase();
    if (lower.contains('dark') ||
        lower.contains('black') ||
        lower.contains('night') ||
        lower.contains('inverse')) {
      return Brightness.dark;
    }
    if (lower.contains('light') || lower.contains('white')) {
      return Brightness.light;
    }
    return null;
  }

  /// Parse ColorScheme from ~/.config/kdeglobals into Brightness.
  static Brightness? parseKdeGlobalsColorScheme(String content) {
    bool inGeneral = false;
    for (final line in content.split('\n')) {
      final trimmed = line.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        inGeneral = trimmed.toLowerCase() == '[general]';
        continue;
      }
      if (inGeneral && trimmed.startsWith('ColorScheme=')) {
        final value = trimmed.substring('ColorScheme='.length).trim();
        return parseKdeColorScheme(value);
      }
    }
    return null;
  }

  /// Parse GNOME/Ubuntu named accent color into Color.
  /// Matches standard Ubuntu / GNOME accent palette.
  static Color? parseGnomeAccent(String? input) {
    if (input == null) return null;
    final cleaned =
        input.trim().replaceAll("'", '').replaceAll('"', '').toLowerCase();
    return switch (cleaned) {
      'blue' => const Color(0xFF0073E5), // 0, 115, 229
      'teal' => const Color(0xFF308280), // 48, 130, 128
      'green' => const Color(0xFF4B8501), // 75, 133, 1
      'yellow' => const Color(0xFFC88800), // 200, 136, 0
      'orange' => const Color(0xFFE95420), // 233, 84, 32
      'red' => const Color(0xFFDA3450), // 218, 52, 80
      'pink' => const Color(0xFFB34CB3), // 179, 76, 179
      'purple' => const Color(0xFF7764D8), // 119, 100, 216
      'slate' => const Color(0xFF657B69), // 101, 123, 105
      'brown' => const Color(0xFFB39169), // 179, 145, 105
      _ => null,
    };
  }

  /// Parse GNOME color-scheme or gtk-theme string into Brightness.
  static Brightness? parseGnomeColorScheme(String? input) {
    if (input == null) return null;
    final val =
        input.trim().replaceAll("'", '').replaceAll('"', '').toLowerCase();
    if (val == 'prefer-dark' || val.contains('dark')) {
      return Brightness.dark;
    }
    if (val == 'prefer-light' || val == 'default') {
      return Brightness.light;
    }
    return null;
  }

  /// Parse LXDE desktop.conf ColorScheme into Color.
  static Color? parseLxdeDesktopConf(String content) {
    for (final line in content.split('\n')) {
      final trimmed = line.trim();
      if (!trimmed.startsWith('sGtk/ColorScheme')) continue;
      final eq = trimmed.indexOf('=');
      if (eq == -1) continue;
      final value = trimmed.substring(eq + 1);
      final parts = value.split(r'\n');
      for (final part in parts) {
        if (part.startsWith('selected_bg_color:#') ||
            part.startsWith('selected_bg_color: #')) {
          final hex = part.split(':#').last.trim().replaceAll('#', '');
          if (hex.length == 6) {
            final rgb = int.tryParse(hex, radix: 16);
            if (rgb != null) return Color(0xFF000000 | rgb);
          } else if (hex.length >= 10) {
            final r = int.tryParse(hex.substring(0, 2), radix: 16);
            final g = int.tryParse(hex.substring(4, 6), radix: 16);
            final b = int.tryParse(hex.substring(8, 10), radix: 16);
            if (r != null && g != null && b != null) {
              return Color.fromARGB(255, r, g, b);
            }
          }
        }
      }
    }
    return null;
  }

  /// Parse FreeDesktop portal color-scheme (0=none, 1=dark, 2=light).
  static Brightness? parsePortalColorScheme(String? output) {
    if (output == null) return null;
    final match = RegExp(r'\b(?:uint32\s+)?([0-2])\b').firstMatch(output);
    if (match != null) {
      final code = int.tryParse(match.group(1)!);
      if (code == 1) return Brightness.dark;
      if (code == 2) return Brightness.light;
    }
    return null;
  }

  /// Parse FreeDesktop portal accent-color tuple (r, g, b) of doubles 0.0..1.0.
  static Color? parsePortalAccentColor(String? output) {
    if (output == null) return null;
    final regex = RegExp(
      r'([0-9]*\.?[0-9]+)\s*,\s*([0-9]*\.?[0-9]+)\s*,\s*([0-9]*\.?[0-9]+)',
    );
    final match = regex.firstMatch(output);
    if (match != null) {
      final r = double.tryParse(match.group(1)!);
      final g = double.tryParse(match.group(2)!);
      final b = double.tryParse(match.group(3)!);
      if (r != null && g != null && b != null) {
        return Color.fromARGB(
          255,
          (r * 255).round().clamp(0, 255),
          (g * 255).round().clamp(0, 255),
          (b * 255).round().clamp(0, 255),
        );
      }
    }
    return null;
  }

  /// Parse GTK 3 settings.ini.
  static Brightness? parseGtkSettings(String content) {
    for (final line in content.split('\n')) {
      final trimmed = line.trim();
      if (trimmed.startsWith('gtk-application-prefer-dark-theme')) {
        final val = trimmed.split('=').last.trim().toLowerCase();
        if (val == '1' || val == 'true') return Brightness.dark;
        if (val == '0' || val == 'false') return Brightness.light;
      }
      if (trimmed.startsWith('gtk-theme-name')) {
        final name = trimmed.split('=').last.trim().toLowerCase();
        if (name.contains('dark')) return Brightness.dark;
      }
    }
    return null;
  }

  static Future<Color?> _getKdeAccent(Map<String, String> env) async {
    // 1. Try kreadconfig6
    var out = await runCommand('kreadconfig6', [
      '--key',
      'AccentColor',
      '--group',
      'General',
    ]);
    // 2. Try kreadconfig5
    out ??= await runCommand('kreadconfig5', [
      '--key',
      'AccentColor',
      '--group',
      'General',
    ]);
    var color = parseRgbString(out);
    if (color != null) return color;

    // 3. Fallback to kdeglobals file
    if (!kIsWeb) {
      final home = env['HOME'] ?? '';
      final configDir = env['XDG_CONFIG_HOME'] ?? '$home/.config';
      final file = File('$configDir/kdeglobals');
      if (file.existsSync()) {
        try {
          color = parseKdeGlobalsAccent(await file.readAsString());
          if (color != null) return color;
        } catch (_) {}
      }
    }
    return null;
  }

  static Future<Brightness?> _getKdeBrightness(Map<String, String> env) async {
    var out = await runCommand('kreadconfig6', [
      '--file',
      'kdeglobals',
      '--group',
      'General',
      '--key',
      'ColorScheme',
    ]);
    out ??= await runCommand('kreadconfig5', [
      '--file',
      'kdeglobals',
      '--group',
      'General',
      '--key',
      'ColorScheme',
    ]);
    var brightness = parseKdeColorScheme(out);
    if (brightness != null) return brightness;

    if (!kIsWeb) {
      final home = env['HOME'] ?? '';
      final configDir = env['XDG_CONFIG_HOME'] ?? '$home/.config';
      final file = File('$configDir/kdeglobals');
      if (file.existsSync()) {
        try {
          brightness = parseKdeGlobalsColorScheme(await file.readAsString());
          if (brightness != null) return brightness;
        } catch (_) {}
      }
    }
    return null;
  }

  static Future<Color?> _getGnomeAccent() async {
    final out = await runCommand('gsettings', [
      'get',
      'org.gnome.desktop.interface',
      'accent-color',
    ]);
    return parseGnomeAccent(out);
  }

  static Future<Brightness?> _getGnomeBrightness() async {
    final out = await runCommand('gsettings', [
      'get',
      'org.gnome.desktop.interface',
      'color-scheme',
    ]);
    var brightness = parseGnomeColorScheme(out);
    if (brightness != null) return brightness;

    final theme = await runCommand('gsettings', [
      'get',
      'org.gnome.desktop.interface',
      'gtk-theme',
    ]);
    return parseGnomeColorScheme(theme);
  }

  static Color? _getLxdeAccent(Map<String, String> env) {
    if (kIsWeb) return null;
    final home = env['HOME'] ?? '';
    final file = File('$home/.config/lxsession/LXDE/desktop.conf');
    if (file.existsSync()) {
      try {
        return parseLxdeDesktopConf(file.readAsStringSync());
      } catch (_) {}
    }
    return null;
  }

  static Future<Color?> _getPortalAccent() async {
    var out = await runCommand('dbus-send', [
      '--session',
      '--print-reply=literal',
      '--dest=org.freedesktop.portal.Desktop',
      '/org/freedesktop/portal/desktop',
      'org.freedesktop.portal.Settings.Read',
      'string:org.freedesktop.appearance',
      'string:accent-color',
    ]);
    out ??= await runCommand('gdbus', [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.portal.Desktop',
      '--object-path',
      '/org/freedesktop/portal/desktop',
      '--method',
      'org.freedesktop.portal.Settings.Read',
      'org.freedesktop.appearance',
      'accent-color',
    ]);
    return parsePortalAccentColor(out);
  }

  static Future<Brightness?> _getPortalBrightness() async {
    var out = await runCommand('dbus-send', [
      '--session',
      '--print-reply=literal',
      '--dest=org.freedesktop.portal.Desktop',
      '/org/freedesktop/portal/desktop',
      'org.freedesktop.portal.Settings.Read',
      'string:org.freedesktop.appearance',
      'string:color-scheme',
    ]);
    out ??= await runCommand('gdbus', [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.portal.Desktop',
      '--object-path',
      '/org/freedesktop/portal/desktop',
      '--method',
      'org.freedesktop.portal.Settings.Read',
      'org.freedesktop.appearance',
      'color-scheme',
    ]);
    return parsePortalColorScheme(out);
  }

  static Brightness? _getGtkSettingsBrightness(Map<String, String> env) {
    if (kIsWeb) return null;
    final home = env['HOME'] ?? '';
    final configDir = env['XDG_CONFIG_HOME'] ?? '$home/.config';
    final file = File('$configDir/gtk-3.0/settings.ini');
    if (file.existsSync()) {
      try {
        return parseGtkSettings(file.readAsStringSync());
      } catch (_) {}
    }
    return null;
  }

  static Brightness? _getEnvBrightness(Map<String, String> env) {
    final gtkTheme = (env['GTK_THEME'] ?? '').toLowerCase();
    if (gtkTheme.contains('dark')) return Brightness.dark;
    if (gtkTheme.contains('light')) return Brightness.light;
    return null;
  }

  /// Query the Linux system accent colour.
  static Future<Color?> getAccentColor({
    Map<String, String>? environment,
  }) async {
    final env = environment ?? (kIsWeb ? const {} : Platform.environment);
    final de = detectDesktop(env);

    Color? color;
    switch (de) {
      case LinuxDesktop.kde:
        color = await _getKdeAccent(env);
        color ??= await _getPortalAccent();
        color ??= await _getGnomeAccent();
      case LinuxDesktop.gnome:
        color = await _getGnomeAccent();
        color ??= await _getPortalAccent();
        color ??= await _getKdeAccent(env);
      case LinuxDesktop.lxde:
        color = _getLxdeAccent(env);
        color ??= await _getPortalAccent();
      case LinuxDesktop.other:
        color = await _getPortalAccent();
        color ??= await _getKdeAccent(env);
        color ??= await _getGnomeAccent();
    }

    if (color != null) {
      currentAccentColor = color;
    }
    return color;
  }

  /// Query the Linux system brightness (dark/light mode).
  static Future<Brightness?> getBrightness({
    Map<String, String>? environment,
  }) async {
    final env = environment ?? (kIsWeb ? const {} : Platform.environment);
    final de = detectDesktop(env);

    Brightness? brightness;

    if (de == LinuxDesktop.kde) {
      brightness = await _getKdeBrightness(env);
      brightness ??= await _getPortalBrightness();
    } else {
      brightness = await _getPortalBrightness();
      if (brightness == null) {
        if (de == LinuxDesktop.gnome) {
          brightness = await _getGnomeBrightness();
        } else {
          brightness = await _getKdeBrightness(env);
          brightness ??= await _getGnomeBrightness();
        }
      }
    }

    brightness ??= _getGtkSettingsBrightness(env);
    brightness ??= _getEnvBrightness(env);

    if (brightness != null) {
      currentBrightness = brightness;
    }
    return brightness;
  }

  /// Synchronous fast initialization before the first frame is rendered.
  static void initSync([Map<String, String>? environment]) {
    if (kIsWeb) return;
    final env = environment ?? Platform.environment;
    final home = env['HOME'] ?? '';
    if (home.isEmpty) return;

    final configDir = env['XDG_CONFIG_HOME'] ?? '$home/.config';
    final kdeFile = File('$configDir/kdeglobals');
    if (kdeFile.existsSync()) {
      try {
        final content = kdeFile.readAsStringSync();
        final scheme = parseKdeGlobalsColorScheme(content);
        if (scheme != null) currentBrightness = scheme;
        final accent = parseKdeGlobalsAccent(content);
        if (accent != null) currentAccentColor = accent;
      } catch (_) {}
    }

    currentBrightness ??= _getGtkSettingsBrightness(env);
    currentBrightness ??= _getEnvBrightness(env);
  }

  /// Start monitoring system theme changes.
  static void startMonitoring({VoidCallback? onChanged}) {
    stopMonitoring();
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.linux) return;

    final home = Platform.environment['HOME'] ?? '';
    final configDir =
        Platform.environment['XDG_CONFIG_HOME'] ?? '$home/.config';

    final kdeFile = File('$configDir/kdeglobals');
    if (kdeFile.existsSync()) {
      try {
        _kdeWatcher = kdeFile.watch().listen((_) async {
          await refresh();
          onChanged?.call();
        });
      } catch (e) {
        AppLog.warn('theme', 'failed to watch kdeglobals', e);
      }
    }

    final dconfFile = File('$configDir/dconf/user');
    if (dconfFile.existsSync()) {
      try {
        _dconfWatcher = dconfFile.watch().listen((_) async {
          await refresh();
          onChanged?.call();
        });
      } catch (e) {
        AppLog.warn('theme', 'failed to watch dconf/user', e);
      }
    }

    _pollTimer = Timer.periodic(const Duration(seconds: 5), (_) async {
      final oldBrightness = currentBrightness;
      final oldAccent = currentAccentColor;
      await refresh();
      if (oldBrightness != currentBrightness ||
          oldAccent != currentAccentColor) {
        onChanged?.call();
      }
    });

    unawaited(refresh().then((_) {
      onChanged?.call();
    }));
  }

  /// Stop watching for system theme changes.
  static void stopMonitoring() {
    _kdeWatcher?.cancel();
    _kdeWatcher = null;
    _dconfWatcher?.cancel();
    _dconfWatcher = null;
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  /// Refresh brightness and accent asynchronously.
  static Future<void> refresh([Map<String, String>? environment]) async {
    try {
      await getBrightness(environment: environment);
      await getAccentColor(environment: environment);
    } catch (e) {
      AppLog.warn('theme', 'failed to refresh Linux theme', e);
    }
  }
}
