/// Theme mode, accent colour, text size, and the mobile-only haptics and
/// notification switches. Local prefs only — nothing here talks to the
/// daemon. Owns the resolved platform accent so the Wallpaper swatch can
/// wear the colour it would apply.
library;

import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';

import '../../services/dynamic_accent.dart';
import '../../services/haptics.dart';
import '../../services/linux_theme.dart';
import '../../services/mesh_background.dart';
import '../../services/message_notifications.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../effects.dart';
import 'settings_widgets.dart';

class AppearanceCard extends StatefulWidget {
  final AppState state;
  const AppearanceCard({super.key, required this.state});

  @override
  State<AppearanceCard> createState() => _AppearanceCardState();
}

class _AppearanceCardState extends State<AppearanceCard> {
  /// The platform's own accent (Android's wallpaper palette / the desktop
  /// accent colour), resolved once so the "Wallpaper" swatch can wear the
  /// colour it would actually apply instead of a placeholder glyph. Null
  /// while it's resolving, or where the platform has none.
  Color? _wallpaperAccent;

  @override
  void initState() {
    super.initState();
    if (DynamicAccent.supported) {
      if (defaultTargetPlatform == TargetPlatform.linux &&
          LinuxThemeService.currentAccentColor != null) {
        _wallpaperAccent = LinuxThemeService.currentAccentColor;
      }
      DynamicAccent.seed().then((seed) {
        if (mounted && seed != null) setState(() => _wallpaperAccent = seed);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final current = TalonTheme.mode.value;
    const options = [
      (ThemeMode.system, 'Auto', Icons.brightness_auto_outlined),
      (ThemeMode.light, 'Light', Icons.light_mode_outlined),
      (ThemeMode.dark, 'Dark', Icons.dark_mode_outlined),
    ];
    final seed = TalonTheme.accentSeed.value;
    final dynamicAccent = widget.state.prefs.accentDynamic;
    final isPreset = !dynamicAccent &&
        seed != null &&
        TalonAccents.presets.any((p) => p.$2.toARGB32() == seed.toARGB32());
    final isCustom = !dynamicAccent && seed != null && !isPreset;
    final scale = TalonTheme.textScale.value;
    final mobile = defaultTargetPlatform == TargetPlatform.android ||
        defaultTargetPlatform == TargetPlatform.iOS;
    return SettingsSection(
      title: 'Appearance',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Full-width segmented row: each mode gets the same room, so there
          // is no dead strip after Dark on wider cards.
          Row(
            children: [
              for (final (i, (mode, label, icon)) in options.indexed) ...[
                if (i > 0) const SizedBox(width: 8),
                Expanded(
                  child: _ModeButton(
                    label: label,
                    icon: icon,
                    selected: current == mode,
                    onTap: () {
                      TalonTheme.mode.value = mode;
                      widget.state.prefs.setThemeMode(switch (mode) {
                        ThemeMode.light => 'light',
                        ThemeMode.dark => 'dark',
                        ThemeMode.system => 'system',
                      });
                    },
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 18),
          const Text(
            'Accent color',
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 10),
          _SwatchGrid(
            swatches: [
              _AccentSwatch(
                tooltip: 'Talon (default)',
                gradient: const LinearGradient(
                  colors: [Color(0xFF7C8CFF), Color(0xFF54E6FF)],
                ),
                selected: !dynamicAccent && seed == null,
                onTap: () => _setAccent(null),
              ),
              // Material You: match whatever colour the system is already
              // wearing (Android 12+ wallpaper palette, desktop accent). The
              // swatch wears that colour as soon as it resolves — a picture
              // glyph on grey read as a broken thumbnail, and told you
              // nothing about what you were about to pick. The sparkle is
              // the same mark the voice picker uses for "automatic".
              if (DynamicAccent.supported)
                _AccentSwatch(
                  tooltip: defaultTargetPlatform == TargetPlatform.android
                      ? 'Wallpaper'
                      : 'Desktop theme',
                  color: _wallpaperSwatchColor,
                  icon: Icons.auto_awesome_rounded,
                  selected: dynamicAccent,
                  onTap: _useWallpaperAccent,
                ),
              for (final (label, color) in TalonAccents.presets)
                _AccentSwatch(
                  tooltip: label,
                  color: color,
                  selected: !dynamicAccent &&
                      seed != null &&
                      seed.toARGB32() == color.toARGB32(),
                  onTap: () => _setAccent(color),
                ),
              _AccentSwatch(
                tooltip: 'Custom…',
                gradient: const SweepGradient(
                  colors: [
                    Color(0xFFFF5C5C),
                    Color(0xFFFFC53D),
                    Color(0xFF3ED598),
                    Color(0xFF38C8F0),
                    Color(0xFFA78BFA),
                    Color(0xFFFF5C5C),
                  ],
                ),
                icon: Icons.colorize,
                selected: isCustom,
                onTap: _pickCustomAccent,
              ),
            ],
          ),
          const SizedBox(height: 18),
          Row(
            children: [
              const SizedBox(
                width: 120,
                child: Text(
                  'Text size',
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                ),
              ),
              Expanded(
                child: Slider(
                  value: scale,
                  min: 0.85,
                  max: 1.3,
                  divisions: 9,
                  label: '${(scale * 100).round()}%',
                  onChanged: (v) {
                    setState(() {
                      TalonTheme.textScale.value =
                          double.parse(v.toStringAsFixed(2));
                    });
                  },
                  onChangeEnd: (v) => widget.state.prefs.setTextScale(v),
                ),
              ),
              SizedBox(
                width: 42,
                child: Text(
                  '${(scale * 100).round()}%',
                  textAlign: TextAlign.right,
                  style: TextStyle(fontSize: 12.5, color: TalonColors.textDim),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          settingsSwitchRow(
            'Reduce effects',
            'Static background and no live blur — lighter on CPU, GPU and '
                'battery',
            TalonEffects.reduce.value,
            (v) {
              setState(() => TalonEffects.reduce.value = v);
              widget.state.prefs.setReduceEffects(v);
            },
          ),
          if (mobile) ...[
            const SizedBox(height: 6),
            settingsSwitchRow(
              'Haptic feedback',
              'Vibrate lightly on long-presses and pickers',
              Haptics.enabled,
              (v) {
                setState(() => Haptics.enabled = v);
                widget.state.prefs.setHaptics(v);
                if (v) Haptics.selection();
              },
            ),
            if (MessageNotifications.supported) ...[
              const SizedBox(height: 6),
              settingsSwitchRow(
                'Message notifications',
                'Notify when a reply arrives while Talon is in the background',
                widget.state.prefs.messageNotifications,
                _setMessageNotifications,
              ),
            ],
          ],
        ],
      ),
    );
  }

  /// What the Wallpaper swatch should paint: the accent the palette would
  /// derive from the system colour (so the swatch predicts the result rather
  /// than showing the raw seed), or a neutral while it resolves.
  Color get _wallpaperSwatchColor {
    final seed = _wallpaperAccent;
    if (seed == null) return TalonColors.surfaceHi;
    return TalonAccents.derive(TalonTheme.palette, seed).accent;
  }

  /// Enabling asks for POST_NOTIFICATIONS first — a toggle that reads "on"
  /// while the OS silently drops every notification is worse than no toggle.
  Future<void> _setMessageNotifications(bool v) async {
    Haptics.selection();
    if (v && !await MessageNotifications.requestPermission()) {
      if (!mounted) return;
      setState(() {});
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Notifications are blocked in Android settings'),
        ),
      );
      return;
    }
    await widget.state.prefs.setMessageNotifications(v);
    MeshForegroundController.pushUiState(messageNotifications: v);
    if (!mounted) return;
    setState(() {});
  }

  void _setAccent(Color? seed) {
    Haptics.selection();
    // main.dart listens on accentSeed → re-applies the palette and rebuilds.
    TalonTheme.accentSeed.value = seed;
    widget.state.prefs.setAccentSeed(seed?.toARGB32());
    // Any manual pick leaves the follow-the-system mode.
    if (widget.state.prefs.accentDynamic) {
      widget.state.prefs.setAccentDynamic(false);
      setState(() {});
    }
  }

  /// Follow the platform's own colour. The seed is resolved once here and
  /// re-read on every app resume (main.dart), so a new wallpaper re-tints the
  /// app the next time it comes forward.
  Future<void> _useWallpaperAccent() async {
    Haptics.selection();
    final messenger = ScaffoldMessenger.of(context);
    final seed = await DynamicAccent.seed();
    if (!mounted) return;
    if (seed == null) {
      final msg = defaultTargetPlatform == TargetPlatform.android
          ? 'This device does not expose a system colour'
          : 'This desktop does not expose a theme accent colour';
      messenger.showSnackBar(SnackBar(
        content: Text(msg),
      ));
      return;
    }
    await widget.state.prefs.setAccentDynamic(true);
    await widget.state.prefs.setAccentSeed(seed.toARGB32());
    TalonTheme.accentSeed.value = seed;
    if (mounted) setState(() {});
  }

  Future<void> _pickCustomAccent() async {
    final picked = await showDialog<Color>(
      context: context,
      builder: (_) => _AccentPickerDialog(
        initial: TalonTheme.accentSeed.value ?? TalonColors.accent,
      ),
    );
    if (picked != null) _setAccent(picked);
  }
}

/// One equal-width segment of the Auto / Light / Dark selector.
class _ModeButton extends StatelessWidget {
  final String label;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;
  const _ModeButton({
    required this.label,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(999),
        child: AnimatedContainer(
          duration: TalonMotion.fast,
          height: 36,
          decoration: BoxDecoration(
            color: selected ? TalonColors.accent : TalonColors.surface,
            borderRadius: BorderRadius.circular(999),
            border: Border.all(
              color: selected ? TalonColors.accent : TalonColors.glassStroke,
            ),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                icon,
                size: 15,
                color: selected ? Colors.white : TalonColors.textFaint,
              ),
              const SizedBox(width: 6),
              Text(
                label,
                style: TextStyle(
                  color: selected ? Colors.white : TalonColors.textDim,
                  fontSize: 13,
                  fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Balanced accent grid from the glass-settings pass. Ten swatches become
/// two even rows of five, with free width shared by both margins and gaps.
class _SwatchGrid extends StatelessWidget {
  final List<Widget> swatches;
  const _SwatchGrid({required this.swatches});

  static const double _size = 34;
  static const double _minGap = 12;
  static const double _rowGap = 12;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final n = swatches.length;
        final maxCols = ((constraints.maxWidth + _minGap) / (_size + _minGap))
            .floor()
            .clamp(1, n);
        final rows = (n / maxCols).ceil();
        final cols = (n / rows).ceil();
        return Column(
          children: [
            for (var r = 0; r < rows; r++) ...[
              if (r > 0) const SizedBox(height: _rowGap),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  for (var i = r * cols; i < (r + 1) * cols; i++)
                    i < n
                        ? swatches[i]
                        : const SizedBox(width: _size, height: _size),
                ],
              ),
            ],
          ],
        );
      },
    );
  }
}

/// A circular accent color swatch: solid [color] or [gradient] fill, a check
/// mark when selected, and an optional glyph (the custom picker's eyedropper).
class _AccentSwatch extends StatelessWidget {
  final Color? color;
  final Gradient? gradient;
  final IconData? icon;
  final bool selected;
  final String tooltip;
  final VoidCallback onTap;
  const _AccentSwatch({
    this.color,
    this.gradient,
    this.icon,
    required this.selected,
    required this.tooltip,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    // Pick a glyph color that survives both light swatches (amber) and dark.
    final base = color ?? const Color(0xFF7C8CFF);
    final glyph = base.computeLuminance() > 0.6 ? Colors.black87 : Colors.white;
    return Tooltip(
      message: tooltip,
      waitDuration: const Duration(milliseconds: 400),
      child: Semantics(
        button: true,
        selected: selected,
        label: tooltip,
        child: InkWell(
          onTap: onTap,
          customBorder: const CircleBorder(),
          child: AnimatedContainer(
            duration: TalonMotion.fast,
            width: 34,
            height: 34,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: gradient == null ? color : null,
              gradient: gradient,
              border: Border.all(
                color: selected ? TalonColors.text : TalonColors.glassStroke,
                width: selected ? 2 : 1,
              ),
            ),
            child: selected
                ? Icon(Icons.check, size: 16, color: glyph)
                : (icon == null ? null : Icon(icon, size: 15, color: glyph)),
          ),
        ),
      ),
    );
  }
}

/// Dependency-free custom accent picker: hue + saturation sliders over
/// gradient tracks, with a live preview of the accent the active palette
/// would derive from the chosen seed.
class _AccentPickerDialog extends StatefulWidget {
  final Color initial;
  const _AccentPickerDialog({required this.initial});

  @override
  State<_AccentPickerDialog> createState() => _AccentPickerDialogState();
}

class _AccentPickerDialogState extends State<_AccentPickerDialog> {
  late double _hue;
  late double _sat;

  @override
  void initState() {
    super.initState();
    final hsl = HSLColor.fromColor(widget.initial);
    _hue = hsl.hue;
    // A grey initial (saturation ~0) would make the hue slider feel dead.
    _sat = hsl.saturation < 0.05 ? 0.8 : hsl.saturation;
  }

  Color get _seed => HSLColor.fromColor(Colors.red)
      .withHue(_hue)
      .withSaturation(_sat)
      .withLightness(0.62)
      .toColor();

  @override
  Widget build(BuildContext context) {
    final preview = TalonAccents.derive(TalonTheme.palette, _seed);
    return AlertDialog(
      backgroundColor: TalonColors.surface,
      title: const Text('Custom accent'),
      content: SizedBox(
        width: 320,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Live preview: the derived accent gradient with sample text.
            Container(
              height: 44,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                gradient: preview.accentGradient,
                borderRadius: TalonRadius.rMd,
              ),
              child: Text(
                'Talon',
                style: TextStyle(
                  fontWeight: FontWeight.w700,
                  color: preview.accent.computeLuminance() > 0.6
                      ? Colors.black87
                      : Colors.white,
                ),
              ),
            ),
            const SizedBox(height: 18),
            _gradientSlider(
              label: 'Hue',
              value: _hue,
              max: 360,
              gradient: LinearGradient(
                colors: [
                  for (var h = 0; h <= 360; h += 60)
                    HSLColor.fromAHSL(1, h.toDouble() % 360, _sat, 0.6)
                        .toColor(),
                ],
              ),
              onChanged: (v) => setState(() => _hue = v),
            ),
            const SizedBox(height: 12),
            _gradientSlider(
              label: 'Saturation',
              value: _sat,
              max: 1,
              gradient: LinearGradient(
                colors: [
                  HSLColor.fromAHSL(1, _hue, 0, 0.6).toColor(),
                  HSLColor.fromAHSL(1, _hue, 1, 0.6).toColor(),
                ],
              ),
              onChanged: (v) => setState(() => _sat = v),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          style: FilledButton.styleFrom(
            backgroundColor: preview.accent,
            foregroundColor: preview.accent.computeLuminance() > 0.6
                ? Colors.black87
                : Colors.white,
          ),
          onPressed: () => Navigator.of(context).pop(_seed),
          child: const Text('Use color'),
        ),
      ],
    );
  }

  /// A slider whose track is the given [gradient] — the standard trick of a
  /// rounded gradient bar underneath a Slider with transparent tracks.
  Widget _gradientSlider({
    required String label,
    required double value,
    required double max,
    required Gradient gradient,
    required ValueChanged<double> onChanged,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: TextStyle(fontSize: 12.5, color: TalonColors.textDim),
        ),
        const SizedBox(height: 4),
        SizedBox(
          height: 32,
          child: Stack(
            alignment: Alignment.center,
            children: [
              Container(
                height: 12,
                margin: const EdgeInsets.symmetric(horizontal: 2),
                decoration: BoxDecoration(
                  gradient: gradient,
                  borderRadius: TalonRadius.rPill,
                  border: Border.all(color: TalonColors.glassStroke),
                ),
              ),
              SliderTheme(
                data: SliderTheme.of(context).copyWith(
                  trackHeight: 12,
                  activeTrackColor: Colors.transparent,
                  inactiveTrackColor: Colors.transparent,
                  overlayShape:
                      const RoundSliderOverlayShape(overlayRadius: 14),
                  thumbShape: const RoundSliderThumbShape(
                    enabledThumbRadius: 9,
                    elevation: 2,
                  ),
                  thumbColor: Colors.white,
                ),
                child: Slider(
                  value: value.clamp(0, max),
                  min: 0,
                  max: max,
                  onChanged: onChanged,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
