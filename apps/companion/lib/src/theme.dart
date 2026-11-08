import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// The Talon visual language: a calm canvas with restrained, mostly
/// monochrome surfaces and a single vivid accent used sparingly. Ships in two
/// palettes — the original near-black dark theme and a soft paper-white light
/// theme — selected by [TalonTheme] (auto / light / dark).
class TalonPalette {
  final Brightness brightness;

  // Base canvas
  final Color void0; // deepest background
  final Color void1; // panels base
  final Color surface; // raised surface
  final Color surfaceHi; // hover / selected

  // Glass strokes & fills (used with opacity over the gradient backdrop)
  final Color glassFill;
  final Color glassStroke;

  // Accent — electric indigo with a cyan partner reserved for the gradient
  // brand mark and the rare hero moment (never every button).
  final Color accent;
  final Color accent2;
  final Color accentDeep;

  // Text
  final Color text;
  final Color textDim;
  final Color textFaint;

  // Status
  final Color ok;
  final Color warn;
  final Color bad;

  /// Backdrop gradient painted behind everything.
  final LinearGradient backdrop;

  const TalonPalette({
    required this.brightness,
    required this.void0,
    required this.void1,
    required this.surface,
    required this.surfaceHi,
    required this.glassFill,
    required this.glassStroke,
    required this.accent,
    required this.accent2,
    required this.accentDeep,
    required this.text,
    required this.textDim,
    required this.textFaint,
    required this.ok,
    required this.warn,
    required this.bad,
    required this.backdrop,
  });

  LinearGradient get accentGradient => LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: [accent, accent2],
      );

  /// A copy of this palette wearing a different accent triple. Everything
  /// else (canvas, glass, text, status) is untouched — the accent is the one
  /// deliberately personalizable stroke in the system.
  TalonPalette copyWithAccent({
    required Color accent,
    required Color accent2,
    required Color accentDeep,
    Color? surfaceHi,
  }) =>
      TalonPalette(
        brightness: brightness,
        void0: void0,
        void1: void1,
        surface: surface,
        surfaceHi: surfaceHi ?? this.surfaceHi,
        glassFill: glassFill,
        glassStroke: glassStroke,
        accent: accent,
        accent2: accent2,
        accentDeep: accentDeep,
        text: text,
        textDim: textDim,
        textFaint: textFaint,
        ok: ok,
        warn: warn,
        bad: bad,
        backdrop: backdrop,
      );
}

const TalonPalette kTalonDark = TalonPalette(
  brightness: Brightness.dark,
  void0: Color(0xFF07070C),
  void1: Color(0xFF0C0D16),
  surface: Color(0xFF13141F),
  surfaceHi: Color(0xFF1B1D2B),
  glassFill: Color(0x14FFFFFF),
  glassStroke: Color(0x1FFFFFFF),
  accent: Color(0xFF7C8CFF),
  accent2: Color(0xFF54E6FF),
  accentDeep: Color(0xFF5B6BF0),
  text: Color(0xFFEDEEF7),
  textDim: Color(0xFFA6A9C2),
  textFaint: Color(0xFF80839F), // >=4.5:1 on every dark surface
  ok: Color(0xFF49E2A0),
  warn: Color(0xFFFFC56B),
  bad: Color(0xFFFF6B81),
  backdrop: LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF0A0B13), Color(0xFF07070C), Color(0xFF0B0A12)],
  ),
);

/// The light theme — the primary, default look. A cool off-white canvas with
/// crisp white cards, a vivid indigo accent, and a teal partner for the
/// gradient mark. Tuned to the settings-screen concept: soft ink hairlines,
/// gentle shadows, colour used in small confident pops.
const TalonPalette kTalonLight = TalonPalette(
  brightness: Brightness.light,
  void0: Color(0xFFEEF0F7), // deepest canvas the cards float on
  void1: Color(0xFFF5F6FB), // panel base
  surface: Color(0xFFFFFFFF), // cards / tiles / fields
  surfaceHi: Color(0xFFEAEDF9), // hover / selected fill
  glassFill: Color(0x0A171A3D),
  glassStroke: Color(0x14171A3D), // soft ink hairline around cards
  accent: Color(0xFF5465ED), // vivid indigo — the signature
  accent2: Color(0xFF43BACC), // teal partner (brand gradient, hero moments)
  accentDeep: Color(0xFF4453D6), // pressed / border-on-accent
  text: Color(0xFF1B1D2A), // near-black slate
  textDim: Color(0xFF565A70),
  textFaint: Color(0xFF656B81), // >=4.5:1 on every light surface
  ok: Color(0xFF12A150), // healthy green (dot, shield, "Good" pill)
  warn: Color(0xFFA9720A),
  bad: Color(0xFFE5484D), // coral red
  backdrop: LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFFF3F4FB), Color(0xFFF6F7FC), Color(0xFFEFF1FA)],
  ),
);

/// Named accent seeds offered in Settings → Appearance, plus the derivation
/// that turns any single seed color into a full accent triple for either
/// brightness. `null` seed = the handcrafted Talon indigo/cyan pair.
class TalonAccents {
  TalonAccents._();

  /// Preset seeds. The derivation below adapts each one per brightness, so a
  /// single color works on both the near-black and paper-white canvases.
  /// Nine of them, which — with the default, the system-colour swatch and the
  /// custom picker — makes twelve tiles: a count that divides evenly by 2, 3,
  /// 4 and 6, so the swatch grid lands on equal rows at every width instead of
  /// leaving a hole in the last one. Fuchsia is also the one gap the ramp had:
  /// rose sits at ~340°, violet at ~260°, and nothing lived between them.
  static const List<(String, Color)> presets = [
    ('Cyan', Color(0xFF38C8F0)),
    ('Emerald', Color(0xFF3ED598)),
    ('Lime', Color(0xFFA3E635)),
    ('Amber', Color(0xFFF5A524)),
    ('Rose', Color(0xFFFF5C8A)),
    ('Fuchsia', Color(0xFFE879F9)),
    ('Violet', Color(0xFFA78BFA)),
    ('Flame', Color(0xFFFF7A59)),
    ('Graphite', Color(0xFF9BA3B5)),
  ];

  /// Derive accent / accent2 / accentDeep from [seed] for [base]'s
  /// brightness and return the re-accented palette. Lightness is clamped so
  /// pastel seeds stay readable on white and dark seeds stay visible on
  /// near-black; the gradient partner is the same seed rotated ~40° of hue.
  static TalonPalette derive(TalonPalette base, Color seed) {
    final dark = base.brightness == Brightness.dark;
    final hsl = HSLColor.fromColor(seed);
    final accent = hsl
        .withLightness(dark
            ? hsl.lightness.clamp(0.58, 0.78)
            : hsl.lightness.clamp(0.30, 0.48))
        .toColor();
    final partner = hsl.withHue((hsl.hue + 40) % 360);
    final accent2 = partner
        .withLightness(dark
            ? (hsl.lightness + 0.08).clamp(0.62, 0.84)
            : (hsl.lightness - 0.02).clamp(0.28, 0.44))
        .toColor();
    final aHsl = HSLColor.fromColor(accent);
    final accentDeep =
        aHsl.withLightness((aHsl.lightness - 0.12).clamp(0.14, 1.0)).toColor();
    final surfaceHi = Color.alphaBlend(
      accent.withValues(alpha: dark ? 0.08 : 0.06),
      dark ? const Color(0xFF141522) : const Color(0xFFF2F4FB),
    );
    return base.copyWithAccent(
      accent: accent,
      accent2: accent2,
      accentDeep: accentDeep,
      surfaceHi: surfaceHi,
    );
  }
}

/// Global theme selection: a persisted [mode] (auto/light/dark) and optional
/// [accentSeed] resolved against the platform brightness into the active
/// [palette]. [revision] bumps whenever the palette actually changes, so
/// pushed routes (Settings, Connect) can subscribe and repaint in place — the
/// root app rebuilds via its own listener in main.dart.
class TalonTheme {
  TalonTheme._();

  // Auto (follow the OS) is the default; Light/Dark are explicit overrides in
  // Settings → Appearance.
  static final ValueNotifier<ThemeMode> mode = ValueNotifier(ThemeMode.system);

  /// Custom accent seed (null = the default Talon indigo). Persisted by
  /// Settings; resolved through [TalonAccents.derive] on [apply].
  static final ValueNotifier<Color?> accentSeed = ValueNotifier(null);

  /// Global UI text scale (1.0 = default). Applied as a [TextScaler] at the
  /// MaterialApp root in main.dart; persisted by Settings.
  static final ValueNotifier<double> textScale = ValueNotifier(1.0);

  static final ValueNotifier<int> revision = ValueNotifier(0);

  static TalonPalette _palette = kTalonDark;
  static TalonPalette get palette => _palette;
  static bool get isDark => _palette.brightness == Brightness.dark;

  /// What the current palette was resolved from — used to skip no-op applies
  /// so [revision] only bumps on an actual visual change. Seeded to the dark
  /// key, consistent with the initial [_palette], so the two never disagree.
  static (bool, int?) _appliedKey = (true, null);

  /// Resolve [mode] + [accentSeed] against the platform brightness and swap
  /// the palette.
  static void apply(Brightness platformBrightness) {
    final dark = switch (mode.value) {
      ThemeMode.dark => true,
      ThemeMode.light => false,
      ThemeMode.system => platformBrightness == Brightness.dark,
    };
    final seed = accentSeed.value;
    final key = (dark, seed?.toARGB32());
    if (key == _appliedKey) return;
    final base = dark ? kTalonDark : kTalonLight;
    _palette = seed == null ? base : TalonAccents.derive(base, seed);
    _appliedKey = key;
    revision.value++;
  }

  /// Restyle the OS chrome (Android status/navigation bars, iOS status bar)
  /// to match the active palette. Without this the bars keep their launch
  /// style, so switching themes visibly changes nothing outside the Flutter
  /// viewport — in light mode that means invisible white status icons.
  /// Separate from [apply] (and called from main.dart after it) because it
  /// needs a live binding, which pure palette resolution — and its tests —
  /// shouldn't require.
  static void syncSystemChrome() {
    final dark = isDark;
    SystemChrome.setSystemUIOverlayStyle(SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarBrightness: _palette.brightness, // iOS
      statusBarIconBrightness:
          dark ? Brightness.light : Brightness.dark, // Android
      systemNavigationBarColor: _palette.void0,
      systemNavigationBarDividerColor: Colors.transparent,
      systemNavigationBarIconBrightness:
          dark ? Brightness.light : Brightness.dark,
    ));
  }
}

/// Color tokens. Same call sites as the original constants, now resolving
/// through the active [TalonTheme.palette] — which is why these can no longer
/// appear in `const` expressions.
class TalonColors {
  TalonColors._();

  static Color get void0 => TalonTheme.palette.void0;
  static Color get void1 => TalonTheme.palette.void1;
  static Color get surface => TalonTheme.palette.surface;
  static Color get surfaceHi => TalonTheme.palette.surfaceHi;
  static Color get glassFill => TalonTheme.palette.glassFill;
  static Color get glassStroke => TalonTheme.palette.glassStroke;
  static Color get accent => TalonTheme.palette.accent;
  static Color get accent2 => TalonTheme.palette.accent2;
  static Color get accentDeep => TalonTheme.palette.accentDeep;
  static Color get text => TalonTheme.palette.text;
  static Color get textDim => TalonTheme.palette.textDim;
  static Color get textFaint => TalonTheme.palette.textFaint;
  static Color get ok => TalonTheme.palette.ok;
  static Color get warn => TalonTheme.palette.warn;
  static Color get bad => TalonTheme.palette.bad;
  static LinearGradient get backdrop => TalonTheme.palette.backdrop;
  static LinearGradient get accentGradient => TalonTheme.palette.accentGradient;
}

/// Input density — the one switch that separates the phone from the desktop.
///
/// The app was originally tuned at a pointer's reading distance: 13.5px tile
/// titles, 11.5px previews, 34px avatars, 36px controls. That rhythm is
/// correct with a mouse 60cm away and wrong in a hand — Material's touch
/// guidance asks for a 48dp minimum target and a body size around 15–16sp,
/// and iOS HIG says the same in different units. Rather than fork the widget
/// tree, every size that matters is expressed as a pair here and resolved
/// once: [d] picks the pointer value on desktop and the touch value on a
/// phone or tablet.
///
/// [overrideTouch] pins the mode for tests and the screenshot gallery, which
/// run under a forced Android target platform and would otherwise render the
/// desktop screens at phone density.
class TalonDensity {
  TalonDensity._();

  /// Test/gallery override. Null = derive from the platform.
  static bool? overrideTouch;

  static bool get touch =>
      overrideTouch ??
      (defaultTargetPlatform == TargetPlatform.android ||
          defaultTargetPlatform == TargetPlatform.iOS);

  /// Pick between a [pointer] value and a [finger] value.
  static double d(double pointer, double finger) => touch ? finger : pointer;

  /// Minimum interactive edge: Material's 48dp touch target on a phone, the
  /// tighter desktop hit box with a mouse.
  static double get tap => touch ? 48 : 36;
}

/// The system navigation bar's height at the bottom of this screen (0 where
/// there isn't one — desktop, or a device with hardware keys).
///
/// Phone surfaces run edge-to-edge: content scrolls UNDER the bar, because
/// Android draws it transparent over the app and stopping short of it leaves
/// a dead band. The cost is that every scrolling surface has to add this to
/// its bottom padding, so the last row can still be scrolled clear of the
/// gesture pill. Uses `padding` rather than `viewPadding` on purpose: with
/// the keyboard up the bar is behind it, and the inset is genuinely gone.
double navInset(BuildContext context) => MediaQuery.of(context).padding.bottom;

/// Spacing scale — an 8pt grid (with a 2/4 half-step for tight insets). Snap
/// every padding/gap to one of these so the layout reads as a system rather
/// than a pile of hand-tuned magic numbers.
class TalonSpace {
  TalonSpace._();

  static const double xxs = 2;
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double xxl = 32;
}

/// Corner-radius tokens. Three steps + a full pill; everything rounds to one of
/// these so panels, cards, and controls feel related.
class TalonRadius {
  TalonRadius._();

  static const double sm = 8; // chips, small controls
  static const double md = 14; // cards, inputs, buttons
  static const double lg = 22; // panels, sheets
  static const double pill = 999;

  static const BorderRadius rSm = BorderRadius.all(Radius.circular(sm));
  static const BorderRadius rMd = BorderRadius.all(Radius.circular(md));
  static const BorderRadius rLg = BorderRadius.all(Radius.circular(lg));
  static const BorderRadius rPill = BorderRadius.all(Radius.circular(pill));
}

/// Type scale. Named, deliberate sizes replace scattered literals so the whole
/// app can be re-tuned in one place. Getters, not consts: they carry the
/// active palette's text colors.
class TalonType {
  TalonType._();

  static TextStyle get display => TextStyle(
        fontFamily: _fontFamily,
        fontSize: TalonDensity.d(22, 24),
        height: 1.2,
        fontWeight: FontWeight.w700,
        letterSpacing: -0.4,
        color: TalonColors.text,
      );

  static TextStyle get title => TextStyle(
        fontFamily: _fontFamily,
        fontSize: TalonDensity.d(16, 17),
        height: 1.3,
        fontWeight: FontWeight.w700,
        letterSpacing: -0.2,
        color: TalonColors.text,
      );

  static TextStyle get subtitle => TextStyle(
        fontFamily: _fontFamily,
        fontSize: TalonDensity.d(14, 15),
        height: 1.3,
        fontWeight: FontWeight.w600,
        color: TalonColors.text,
      );

  static TextStyle get body => TextStyle(
        fontFamily: _fontFamily,
        fontSize: TalonDensity.d(14, 15.5),
        height: 1.5,
        color: TalonColors.text,
      );

  static TextStyle get label => TextStyle(
        fontFamily: _fontFamily,
        fontSize: TalonDensity.d(13, 14),
        height: 1.3,
        color: TalonColors.textDim,
      );

  static TextStyle get caption => TextStyle(
        fontFamily: _fontFamily,
        fontSize: TalonDensity.d(12, 12.5),
        height: 1.4,
        color: TalonColors.textFaint,
      );

  /// All-caps section eyebrow (sidebar groups, settings section headers).
  static TextStyle get eyebrow => TextStyle(
        fontFamily: _fontFamily,
        fontSize: TalonDensity.d(11, 11.5),
        height: 1.2,
        fontWeight: FontWeight.w700,
        letterSpacing: 1.1,
        color: TalonColors.textFaint,
      );

  /// Monospace for tool names, code, tabular readouts.
  static TextStyle get mono => TextStyle(
        fontFamily: 'JetBrains Mono',
        fontSize: TalonDensity.d(13, 13.5),
        height: 1.4,
        color: TalonColors.text,
      );
}

/// Elevation vocabulary: layered soft shadows instead of Material's single
/// hard umbra, plus an accent-tinted glow for the one primary action per
/// screen. Getters so they track the active palette.
class TalonShadows {
  TalonShadows._();

  /// Resting card / tile.
  static List<BoxShadow> get soft => [
        BoxShadow(
          color:
              Colors.black.withValues(alpha: TalonTheme.isDark ? 0.35 : 0.08),
          blurRadius: 14,
          offset: const Offset(0, 4),
        ),
      ];

  /// Floating surface (composer, sheets, FABs).
  static List<BoxShadow> get raised => [
        BoxShadow(
          color:
              Colors.black.withValues(alpha: TalonTheme.isDark ? 0.45 : 0.10),
          blurRadius: 24,
          offset: const Offset(0, 8),
        ),
        BoxShadow(
          color:
              Colors.black.withValues(alpha: TalonTheme.isDark ? 0.30 : 0.06),
          blurRadius: 6,
          offset: const Offset(0, 2),
        ),
      ];

  /// Accent-tinted glow for the primary action (send button, new chat).
  static List<BoxShadow> get glow => [
        BoxShadow(
          color: TalonColors.accent.withValues(alpha: 0.38),
          blurRadius: 18,
          offset: const Offset(0, 4),
        ),
      ];
}

/// Shared motion vocabulary so every surface animates with the same rhythm.
/// Durations climb in a consistent scale; curves favour a soft, "emphasized"
/// deceleration (fast out, gentle settle) that reads as calm rather than
/// bouncy. Keep transitions here so the whole app can be retuned in one place.
class TalonMotion {
  TalonMotion._();

  /// Taps, toggles, small state flips.
  static const Duration fast = Duration(milliseconds: 140);

  /// The default for most transitions (pane swaps, entrances).
  static const Duration base = Duration(milliseconds: 240);

  /// Larger, more deliberate moves (expanding panels, first paint).
  static const Duration slow = Duration(milliseconds: 360);

  /// Per-item offset for staggered list entrances (sidebar, model list).
  static const Duration stagger = Duration(milliseconds: 45);

  /// Standard deceleration — fast to start, easing gently into place.
  static const Curve emphasized = Curves.easeOutCubic;

  /// Symmetric ease for reversible states (selected ⇄ idle).
  static const Curve standard = Curves.easeInOutCubic;
}

ThemeData buildTalonTheme() {
  final dark = TalonTheme.isDark;
  final base = dark
      ? ThemeData.dark(useMaterial3: true)
      : ThemeData.light(useMaterial3: true);
  final accent = TalonColors.accent;

  return base.copyWith(
    scaffoldBackgroundColor: TalonColors.void0,
    colorScheme: base.colorScheme.copyWith(
      brightness: dark ? Brightness.dark : Brightness.light,
      primary: accent,
      secondary: TalonColors.accent2,
      surface: TalonColors.surface,
      onSurface: TalonColors.text,
      error: TalonColors.bad,
    ),
    textTheme: base.textTheme
        .apply(
          bodyColor: TalonColors.text,
          displayColor: TalonColors.text,
          fontFamily: _fontFamily,
        )
        .copyWith(
          // NOTE: copyWith REPLACES these styles wholesale (it does not merge
          // with the apply() above), so they must carry the font family
          // themselves — TalonType styles do. A bare TextStyle here silently
          // drops the family for everything that inherits bodyMedium.
          bodyMedium: TalonType.body,
          // Carries its own colour: DropdownButton draws its closed label
          // and menu items in titleMedium, and a colourless style here fell
          // back to white on the light menu.
          titleMedium: TextStyle(
            fontFamily: _fontFamily,
            fontSize: 16,
            fontWeight: FontWeight.w600,
            color: TalonColors.text,
          ),
        ),
    // Dropdown menus paint on canvasColor — match the popup menus.
    canvasColor: TalonColors.surfaceHi,
    splashFactory: InkSparkle.splashFactory,
    // Predictive back on Android: route pops (conversation → chat list,
    // Settings → home) track the back gesture and peel away with the system
    // animation. Other platforms keep their native transition feel.
    pageTransitionsTheme: const PageTransitionsTheme(
      builders: {
        TargetPlatform.android: PredictiveBackPageTransitionsBuilder(),
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.linux: ZoomPageTransitionsBuilder(),
        TargetPlatform.windows: ZoomPageTransitionsBuilder(),
      },
    ),
    // Pushed routes (Settings, Connect) use transparent AppBars over the
    // backdrop gradient. M3's defaults tint them on scroll and let the bar
    // impose its own system-chrome style — pin both so the bars stay part of
    // the canvas and the status bar keeps the palette's icon brightness.
    appBarTheme: base.appBarTheme.copyWith(
      backgroundColor: Colors.transparent,
      foregroundColor: TalonColors.text,
      elevation: 0,
      scrolledUnderElevation: 0,
      surfaceTintColor: Colors.transparent,
      titleTextStyle: TalonType.title.copyWith(fontSize: 18),
      systemOverlayStyle: SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarBrightness: dark ? Brightness.dark : Brightness.light,
        statusBarIconBrightness: dark ? Brightness.light : Brightness.dark,
        systemNavigationBarColor: TalonColors.void0,
        systemNavigationBarIconBrightness:
            dark ? Brightness.light : Brightness.dark,
      ),
    ),
    dividerColor: TalonColors.glassStroke,
    // Bottom sheets are a touch surface first: give the drag handle the
    // palette's faint ink so it reads on both canvases.
    bottomSheetTheme: base.bottomSheetTheme.copyWith(
      dragHandleColor: TalonColors.textFaint,
      dragHandleSize: const Size(36, 4),
    ),
    iconTheme: IconThemeData(color: TalonColors.textDim, size: 20),
    tooltipTheme: TooltipThemeData(
      decoration: BoxDecoration(
        color: TalonColors.surfaceHi,
        borderRadius: TalonRadius.rSm,
      ),
      textStyle: TextStyle(color: TalonColors.text, fontSize: 12),
    ),
    scrollbarTheme: ScrollbarThemeData(
      thumbColor:
          WidgetStatePropertyAll(TalonColors.text.withValues(alpha: 0.12)),
      thickness: const WidgetStatePropertyAll(6),
      radius: const Radius.circular(8),
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: TalonColors.surfaceHi,
      surfaceTintColor: Colors.transparent,
      elevation: 6,
      shape: RoundedRectangleBorder(
        borderRadius: TalonRadius.rMd,
        side: BorderSide(color: TalonColors.glassStroke),
      ),
      textStyle: TextStyle(
        color: TalonColors.text,
        fontSize: 13.5,
        fontFamily: _fontFamily,
      ),
    ),
    // Material 3's default selected-track has no outline and a thumb that
    // can end up the same color as the track (see settings_screen.dart's
    // _switchRow), reading as a solid undifferentiated pill against this
    // theme's glass surfaces. Give both states an explicit border and
    // a thumb that always contrasts against its track.
    // Every colour resolves the disabled state too. Without it a switch with
    // onChanged: null rendered exactly like a live one — it swallowed taps
    // while still looking on, which reads as a stuck control.
    switchTheme: SwitchThemeData(
      trackColor: WidgetStateProperty.resolveWith((states) {
        final c = states.contains(WidgetState.selected)
            ? TalonColors.accent
            : TalonColors.surfaceHi;
        return states.contains(WidgetState.disabled)
            ? c.withValues(alpha: 0.30)
            : c;
      }),
      trackOutlineColor: WidgetStateProperty.resolveWith((states) {
        final c = states.contains(WidgetState.selected)
            ? TalonColors.accentDeep
            : TalonColors.glassStroke;
        return states.contains(WidgetState.disabled)
            ? c.withValues(alpha: 0.30)
            : c;
      }),
      trackOutlineWidth: const WidgetStatePropertyAll(1.4),
      thumbColor: WidgetStateProperty.resolveWith((states) {
        final c = states.contains(WidgetState.selected)
            ? Colors.white
            : TalonColors.textDim;
        return states.contains(WidgetState.disabled)
            ? c.withValues(alpha: 0.45)
            : c;
      }),
    ),
  );
}

/// Bundled UI typeface (see pubspec fonts). Inter everywhere means the app
/// renders identically on Android, Windows, macOS, and Linux instead of
/// inheriting whatever the platform default happens to be.
const String _fontFamily = 'Inter';
