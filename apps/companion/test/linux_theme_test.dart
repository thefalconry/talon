import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/services/dynamic_accent.dart';
import 'package:talon_companion/src/services/linux_theme.dart';

void main() {
  tearDown(() {
    LinuxThemeService.commandRunnerOverride = null;
    LinuxThemeService.currentBrightness = null;
    LinuxThemeService.currentAccentColor = null;
    LinuxThemeService.stopMonitoring();
  });

  group('detectDesktop', () {
    test('detects KDE from XDG_SESSION_DESKTOP', () {
      expect(
        LinuxThemeService.detectDesktop({'XDG_SESSION_DESKTOP': 'KDE'}),
        LinuxDesktop.kde,
      );
    });

    test('detects KDE Plasma from DESKTOP_SESSION', () {
      expect(
        LinuxThemeService.detectDesktop({'DESKTOP_SESSION': 'plasma'}),
        LinuxDesktop.kde,
      );
    });

    test('detects GNOME / Ubuntu from XDG_CURRENT_DESKTOP', () {
      expect(
        LinuxThemeService.detectDesktop({'XDG_CURRENT_DESKTOP': 'ubuntu:GNOME'}),
        LinuxDesktop.gnome,
      );
    });

    test('detects GNOME from XDG_SESSION_DESKTOP', () {
      expect(
        LinuxThemeService.detectDesktop({'XDG_SESSION_DESKTOP': 'gnome'}),
        LinuxDesktop.gnome,
      );
    });

    test('detects LXDE from XDG_CURRENT_DESKTOP', () {
      expect(
        LinuxThemeService.detectDesktop({'XDG_CURRENT_DESKTOP': 'LXDE'}),
        LinuxDesktop.lxde,
      );
    });

    test('falls back to other for unknown environments', () {
      expect(
        LinuxThemeService.detectDesktop({'XDG_CURRENT_DESKTOP': 'sway'}),
        LinuxDesktop.other,
      );
    });
  });

  group('parseRgbString', () {
    test('parses comma-separated integer triplet', () {
      final color = LinuxThemeService.parseRgbString('61,174,233');
      expect(color, const Color.fromARGB(255, 61, 174, 233));
    });

    test('handles whitespace and trims', () {
      final color = LinuxThemeService.parseRgbString('  233 , 84 , 32  \n');
      expect(color, const Color.fromARGB(255, 233, 84, 32));
    });

    test('clamps out-of-range values', () {
      final color = LinuxThemeService.parseRgbString('300,-10,50');
      expect(color, const Color.fromARGB(255, 255, 0, 50));
    });

    test('returns null for invalid inputs', () {
      expect(LinuxThemeService.parseRgbString(null), isNull);
      expect(LinuxThemeService.parseRgbString(''), isNull);
      expect(LinuxThemeService.parseRgbString('abc,def,ghi'), isNull);
      expect(LinuxThemeService.parseRgbString('61,174'), isNull);
    });
  });

  group('KDE Globals parsers', () {
    test('extracts AccentColor from [General] section only', () {
      const ini = '''
[Colors:Window]
AccentColor=0,0,0
[General]
AccentColor=61,174,233
ColorScheme=BreezeDark
''';
      final color = LinuxThemeService.parseKdeGlobalsAccent(ini);
      expect(color, const Color.fromARGB(255, 61, 174, 233));
    });

    test('extracts ColorScheme from [General] section and recognizes dark', () {
      const ini = '''
[General]
ColorScheme=BreezeDark
AccentColor=61,174,233
''';
      expect(
        LinuxThemeService.parseKdeGlobalsColorScheme(ini),
        Brightness.dark,
      );
    });

    test('recognizes light KDE color schemes', () {
      const ini = '''
[General]
ColorScheme=BreezeLight
''';
      expect(
        LinuxThemeService.parseKdeGlobalsColorScheme(ini),
        Brightness.light,
      );
    });
  });

  group('parseKdeColorScheme', () {
    test('identifies dark variants', () {
      expect(LinuxThemeService.parseKdeColorScheme('BreezeDark'), Brightness.dark);
      expect(LinuxThemeService.parseKdeColorScheme('Breeze-Dark'), Brightness.dark);
      expect(LinuxThemeService.parseKdeColorScheme('BlackTheme'), Brightness.dark);
      expect(LinuxThemeService.parseKdeColorScheme('NightCity'), Brightness.dark);
      expect(LinuxThemeService.parseKdeColorScheme('HighContrastInverse'), Brightness.dark);
    });

    test('identifies light variants', () {
      expect(LinuxThemeService.parseKdeColorScheme('BreezeLight'), Brightness.light);
      expect(LinuxThemeService.parseKdeColorScheme('WhiteTheme'), Brightness.light);
    });

    test('returns null for ambiguous scheme names', () {
      expect(LinuxThemeService.parseKdeColorScheme('Oxygen'), isNull);
      expect(LinuxThemeService.parseKdeColorScheme(null), isNull);
    });
  });

  group('parseGnomeAccent', () {
    test('maps all 10 standard GNOME accent names', () {
      expect(LinuxThemeService.parseGnomeAccent('blue'), const Color(0xFF0073E5));
      expect(LinuxThemeService.parseGnomeAccent("'teal'"), const Color(0xFF308280));
      expect(LinuxThemeService.parseGnomeAccent('green'), const Color(0xFF4B8501));
      expect(LinuxThemeService.parseGnomeAccent('yellow'), const Color(0xFFC88800));
      expect(LinuxThemeService.parseGnomeAccent("'orange'"), const Color(0xFFE95420));
      expect(LinuxThemeService.parseGnomeAccent('red'), const Color(0xFFDA3450));
      expect(LinuxThemeService.parseGnomeAccent('pink'), const Color(0xFFB34CB3));
      expect(LinuxThemeService.parseGnomeAccent('purple'), const Color(0xFF7764D8));
      expect(LinuxThemeService.parseGnomeAccent('slate'), const Color(0xFF657B69));
      expect(LinuxThemeService.parseGnomeAccent('brown'), const Color(0xFFB39169));
    });

    test('returns null for unknown accent names', () {
      expect(LinuxThemeService.parseGnomeAccent('magenta'), isNull);
      expect(LinuxThemeService.parseGnomeAccent(null), isNull);
    });
  });

  group('parseGnomeColorScheme', () {
    test('parses prefer-dark and dark gtk themes', () {
      expect(LinuxThemeService.parseGnomeColorScheme("'prefer-dark'"), Brightness.dark);
      expect(LinuxThemeService.parseGnomeColorScheme('prefer-dark'), Brightness.dark);
      expect(LinuxThemeService.parseGnomeColorScheme("'Adwaita-dark'"), Brightness.dark);
      expect(LinuxThemeService.parseGnomeColorScheme("'Yaru-dark'"), Brightness.dark);
    });

    test('parses prefer-light and default', () {
      expect(LinuxThemeService.parseGnomeColorScheme("'prefer-light'"), Brightness.light);
      expect(LinuxThemeService.parseGnomeColorScheme("'default'"), Brightness.light);
      expect(LinuxThemeService.parseGnomeColorScheme('Adwaita'), isNull);
    });
  });

  group('parseLxdeDesktopConf', () {
    test('parses 6-character hex selected_bg_color', () {
      const conf = '''
[GTK]
sGtk/ColorScheme=selected_bg_color:#3f88e3\\nselected_fg_color:#ffffff
''';
      expect(
        LinuxThemeService.parseLxdeDesktopConf(conf),
        const Color(0xFF3F88E3),
      );
    });

    test('parses 12-character interleaved hex selected_bg_color', () {
      const conf = '''
[GTK]
sGtk/ColorScheme=selected_bg_color:#3f008800e300\\nselected_fg_color:#ffffff
''';
      expect(
        LinuxThemeService.parseLxdeDesktopConf(conf),
        const Color(0xFF3F88E3),
      );
    });
  });

  group('Portal parsers', () {
    test('parses portal color-scheme integer output', () {
      expect(
        LinuxThemeService.parsePortalColorScheme('variant       uint32 1'),
        Brightness.dark,
      );
      expect(
        LinuxThemeService.parsePortalColorScheme('(<uint32 2>,)'),
        Brightness.light,
      );
      expect(
        LinuxThemeService.parsePortalColorScheme('(<uint32 0>,)'),
        isNull,
      );
    });

    test('parses portal accent-color triple doubles', () {
      final color = LinuxThemeService.parsePortalAccentColor(
        'variant       (0.23921568627450981, 0.5294117647058824, 0.9019607843137255)',
      );
      expect(color, isNotNull);
      expect(color!.r, closeTo(61 / 255.0, 0.02));
      expect(color.g, closeTo(135 / 255.0, 0.02));
      expect(color.b, closeTo(230 / 255.0, 0.02));
    });
  });

  group('parseGtkSettings', () {
    test('parses gtk-application-prefer-dark-theme', () {
      const conf = '''
[Settings]
gtk-theme-name=Adwaita
gtk-application-prefer-dark-theme=1
''';
      expect(LinuxThemeService.parseGtkSettings(conf), Brightness.dark);
    });

    test('parses dark gtk-theme-name', () {
      const conf = '''
[Settings]
gtk-theme-name=Breeze-Dark
gtk-application-prefer-dark-theme=0
''';
      expect(LinuxThemeService.parseGtkSettings(conf), Brightness.dark);
    });
  });

  group('End-to-end theme & accent querying with command overrides', () {
    test('KDE queries kreadconfig6 and returns accent + dark brightness', () async {
      LinuxThemeService.commandRunnerOverride = (cmd, args) async {
        if (cmd == 'kreadconfig6' && args.contains('AccentColor')) {
          return '61,174,233';
        }
        if (cmd == 'kreadconfig6' && args.contains('ColorScheme')) {
          return 'BreezeDark';
        }
        return null;
      };

      final accent = await LinuxThemeService.getAccentColor(
        environment: {'XDG_SESSION_DESKTOP': 'KDE'},
      );
      expect(accent, const Color.fromARGB(255, 61, 174, 233));
      expect(LinuxThemeService.currentAccentColor, accent);

      final brightness = await LinuxThemeService.getBrightness(
        environment: {'XDG_SESSION_DESKTOP': 'KDE'},
      );
      expect(brightness, Brightness.dark);
      expect(LinuxThemeService.currentBrightness, Brightness.dark);
    });

    test('GNOME queries gsettings and returns accent + dark brightness', () async {
      LinuxThemeService.commandRunnerOverride = (cmd, args) async {
        if (cmd == 'gsettings' && args.contains('accent-color')) {
          return "'orange'";
        }
        if (cmd == 'gsettings' && args.contains('color-scheme')) {
          return "'prefer-dark'";
        }
        return null;
      };

      final accent = await LinuxThemeService.getAccentColor(
        environment: {'XDG_CURRENT_DESKTOP': 'ubuntu:GNOME'},
      );
      expect(accent, const Color(0xFFE95420)); // orange

      final brightness = await LinuxThemeService.getBrightness(
        environment: {'XDG_CURRENT_DESKTOP': 'ubuntu:GNOME'},
      );
      expect(brightness, Brightness.dark);
    });

    test('Portal fallback returns accent and light brightness', () async {
      LinuxThemeService.commandRunnerOverride = (cmd, args) async {
        if (cmd == 'dbus-send' && args.contains('string:accent-color')) {
          return 'variant       (0.188, 0.510, 0.502)';
        }
        if (cmd == 'dbus-send' && args.contains('string:color-scheme')) {
          return 'variant       uint32 2'; // light
        }
        return null;
      };

      final accent = await LinuxThemeService.getAccentColor(
        environment: {'XDG_SESSION_DESKTOP': 'unknown'},
      );
      expect(accent, isNotNull);

      final brightness = await LinuxThemeService.getBrightness(
        environment: {'XDG_SESSION_DESKTOP': 'unknown'},
      );
      expect(brightness, Brightness.light);
    });
  });

  group('DynamicAccent Linux integration', () {
    test('DynamicAccent reports supported on Linux', () {
      debugDefaultTargetPlatformOverride = TargetPlatform.linux;
      try {
        expect(DynamicAccent.supported, isTrue);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });

    test('DynamicAccent.seed delegates to LinuxThemeService on Linux', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.linux;
      LinuxThemeService.commandRunnerOverride = (cmd, args) async {
        if (cmd == 'kreadconfig6' && args.contains('AccentColor')) {
          return '233,84,32';
        }
        return null;
      };

      try {
        final seed = await DynamicAccent.seed();
        expect(seed, const Color.fromARGB(255, 233, 84, 32));
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });
  });
}
