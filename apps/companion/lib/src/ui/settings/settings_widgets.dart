/// Building blocks shared by the settings cards: the glass section frame,
/// the row primitives (switch, text field, interval stepper, health check,
/// info line, stat tile), the control button, the rail tile and chapter
/// model for the wide layout, the loading skeleton, and the two duration
/// formatters. Nothing here holds state of its own beyond a tile's hover.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_animate/flutter_animate.dart';

import '../../models/bridge_models.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../glass.dart';
import '../effects.dart';

/// Severity for a diagnostics check row.
enum SettingsHealth { ok, warn, bad, info }

Widget healthRow(SettingsHealth h, String label, String detail) {
  final (icon, color) = switch (h) {
    SettingsHealth.ok => (Icons.check_circle, TalonColors.ok),
    SettingsHealth.warn => (Icons.error_outline, TalonColors.warn),
    SettingsHealth.bad => (Icons.cancel_outlined, TalonColors.bad),
    SettingsHealth.info => (Icons.info_outline, TalonColors.textFaint),
  };
  return Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 16, color: color),
        const SizedBox(width: 10),
        SizedBox(
          width: 118,
          child: Text(
            label,
            style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
          ),
        ),
        Expanded(
          child: Text(
            detail,
            style: TextStyle(fontSize: 12.5, color: TalonColors.textDim),
          ),
        ),
      ],
    ),
  );
}

Widget infoRow(String label, String value) => Padding(
  padding: const EdgeInsets.symmetric(vertical: 5),
  child: Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      SizedBox(
        width: 128,
        child: Text(
          label,
          style: TextStyle(fontSize: 13, color: TalonColors.textDim),
        ),
      ),
      Expanded(
        child: SelectableText(
          value.isEmpty ? '—' : value,
          style: const TextStyle(fontSize: 13.5),
        ),
      ),
    ],
  ),
);

/// A compact stat tile: an indigo icon square, a small uppercase label, and a
/// bold value (or a green "Good" pill for the health readout).
Widget statTile(
  IconData icon,
  String label,
  String value, {
  bool pill = false,
}) {
  return Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
    decoration: BoxDecoration(
      color: TalonColors.surface,
      borderRadius: BorderRadius.circular(14),
      border: Border.all(color: TalonColors.glassStroke, width: 1),
    ),
    child: Row(
      children: [
        Container(
          width: 30,
          height: 30,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: TalonColors.accent.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(9),
          ),
          child: Icon(icon, size: 17, color: TalonColors.accent),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                label.toUpperCase(),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 9.5,
                  letterSpacing: 0.6,
                  fontWeight: FontWeight.w700,
                  color: TalonColors.textFaint,
                ),
              ),
              const SizedBox(height: 1),
              if (pill)
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 1,
                  ),
                  decoration: BoxDecoration(
                    color: TalonColors.ok.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    value,
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: TalonColors.ok,
                    ),
                  ),
                )
              else
                Text(
                  value,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                  ),
                ),
            ],
          ),
        ),
      ],
    ),
  );
}

Widget settingsTextRow(
  String label,
  TextEditingController c, {
  String? hint,
  required ValueChanged<String> onSubmit,
}) {
  return Row(
    children: [
      SizedBox(
        width: 120,
        child: Text(label, style: const TextStyle(fontSize: 13.5)),
      ),
      Expanded(
        child: TextField(
          controller: c,
          style: const TextStyle(fontSize: 14),
          onSubmitted: onSubmit,
          decoration: InputDecoration(
            isDense: true,
            hintText: hint,
            suffixIcon: IconButton(
              icon: const Icon(Icons.check, size: 16),
              onPressed: () => onSubmit(c.text),
            ),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: BorderSide(color: TalonColors.glassStroke),
            ),
          ),
        ),
      ),
    ],
  );
}

Widget settingsSwitchRow(
  String title,
  String subtitle,
  bool value,
  ValueChanged<bool>? onChanged,
) {
  // A disabled row dims as a whole — title and subtitle too, not just the
  // switch — so it's obvious at a glance that it can't be changed right now.
  return Padding(
    padding: const EdgeInsets.symmetric(vertical: 7),
    child: Row(
      children: [
        Expanded(
          child: AnimatedOpacity(
            opacity: onChanged == null ? 0.5 : 1,
            duration: const Duration(milliseconds: 150),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: TextStyle(
                    fontSize: 12,
                    height: 1.35,
                    color: TalonColors.textFaint,
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(width: 12),
        // Plain Switch, not .adaptive: this app uses fully custom Material
        // theming everywhere (not platform-native widgets), and .adaptive
        // renders a CupertinoSwitch on macOS/iOS that ignores
        // SwitchThemeData entirely, bypassing the border/contrast fix in
        // theme.dart. Colors come from SwitchThemeData now, not a local
        // override here -- the previous override set the thumb to the
        // same accent color as the selected track, making the switch
        // look like one solid pill with no visible thumb.
        Switch(value: value, onChanged: onChanged),
      ],
    ),
  );
}

Widget settingsIntervalRow(
  String label,
  String current,
  int value, {
  required int min,
  required ValueChanged<int> onChange,
}) {
  return Padding(
    padding: const EdgeInsets.only(top: 8, left: 6),
    child: Row(
      children: [
        Expanded(
          child: Text(
            label,
            style: TextStyle(fontSize: 13, color: TalonColors.textDim),
          ),
        ),
        IconButton(
          iconSize: 18,
          onPressed: value > min ? () => onChange(value - 1) : null,
          icon: const Icon(Icons.remove_circle_outline),
        ),
        Text(current, style: const TextStyle(fontSize: 13.5)),
        IconButton(
          iconSize: 18,
          onPressed: () => onChange(value + 1),
          icon: const Icon(Icons.add_circle_outline),
        ),
      ],
    ),
  );
}

String fmtUptime(int ms) {
  final s = ms ~/ 1000;
  if (s < 60) return '${s}s';
  final m = s ~/ 60;
  if (m < 60) return '${m}m';
  final h = m ~/ 60;
  if (h < 24) return '${h}h ${m % 60}m';
  return '${h ~/ 24}d ${h % 24}h';
}

String fmtAge(int ms) {
  final s = (ms ~/ 1000).clamp(0, 1 << 31);
  if (s < 60) return '${s}s ago';
  final m = s ~/ 60;
  if (m < 60) return '${m}m ago';
  final h = m ~/ 60;
  return '${h}h ago';
}

/// Shimmering placeholder cards shown while the daemon config loads — reads as
/// "loading this specific layout" rather than a lonely spinner.
class SettingsSkeleton extends StatelessWidget {
  const SettingsSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.of(context).disableAnimations;
    Widget bar(double w, double h) {
      final box = Container(
        width: w,
        height: h,
        decoration: BoxDecoration(
          color: TalonColors.surfaceHi,
          borderRadius: BorderRadius.circular(6),
        ),
      );
      if (reduceMotion) return box;
      return box
          .animate(onPlay: (c) => c.repeat())
          .shimmer(
            duration: 1200.ms,
            color: Colors.white.withValues(alpha: 0.08),
          )
          .wrapAmbient();
    }

    Widget card(int rows) => Glass(
      radius: TalonRadius.md,
      padding: const EdgeInsets.all(TalonSpace.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          bar(120, 12),
          const SizedBox(height: TalonSpace.lg),
          for (var i = 0; i < rows; i++) ...[
            if (i > 0) const SizedBox(height: TalonSpace.md),
            bar(double.infinity, 16),
          ],
        ],
      ),
    );

    return Column(
      children: [
        card(3),
        const SizedBox(height: TalonSpace.lg),
        card(2),
        const SizedBox(height: TalonSpace.lg),
        card(4),
      ],
    );
  }
}

/// One chapter in the wide layout's rail: what the rail draws, and a builder
/// for the cards the detail pane paints, grouped into the columns they should
/// occupy when the pane is wide enough for two.
///
/// [subtitle] is doing real work rather than decoration: the chapter names are
/// deliberately broad, so it is the line that tells someone hunting for
/// "diagnostics" or "timezone" which chapter to open.
///
/// [columns] is a callback rather than a built list because only the selected
/// chapter is ever constructed. Building all of them eagerly to show one would
/// throw away the main win of this layout, and several cards are not free: the
/// Mesh card walks the device list, the Status card formats uptime.
class SettingsChapter {
  final String title;
  final String subtitle;
  final IconData icon;
  final List<List<Widget>> Function() columns;

  const SettingsChapter({
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.columns,
  });
}

/// A rail entry, wearing the sidebar chat tile's hover / selected / pressed
/// treatment so the app's two rails read as the same piece of furniture.
///
/// Built on [InkWell] rather than the sidebar's bare GestureDetector because
/// this rail is the only route to a section in the wide layout, so it has to be
/// tab-reachable and Enter-activatable. Every ink colour is transparent,
/// though: the splash would land on the Scaffold's far-off Material, beneath
/// the glass panel this sits in, so the visible states are painted here
/// instead — including the focus ring, which is why `onFocusChange` is wired up
/// rather than left to `focusColor`.
class RailTile extends StatefulWidget {
  final String title;
  final String subtitle;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  const RailTile({
    super.key,
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  @override
  State<RailTile> createState() => _RailTileState();
}

class _RailTileState extends State<RailTile> {
  bool _hover = false;
  bool _pressed = false;
  bool _focused = false;

  @override
  Widget build(BuildContext context) {
    final selected = widget.selected;
    final border = selected
        ? TalonColors.accent.withValues(alpha: 0.35)
        : (_focused
              ? TalonColors.accent.withValues(alpha: 0.55)
              : Colors.transparent);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: TalonSpace.xxs),
      child: Semantics(
        button: true,
        selected: selected,
        child: InkWell(
          onTap: widget.onTap,
          onHover: (v) => setState(() => _hover = v),
          onHighlightChanged: (v) => setState(() => _pressed = v),
          onFocusChange: (v) => setState(() => _focused = v),
          borderRadius: TalonRadius.rMd,
          hoverColor: Colors.transparent,
          focusColor: Colors.transparent,
          splashColor: Colors.transparent,
          highlightColor: Colors.transparent,
          child: AnimatedScale(
            scale: _pressed ? 0.975 : 1.0,
            duration: TalonMotion.fast,
            curve: TalonMotion.emphasized,
            child: AnimatedContainer(
              duration: TalonMotion.fast,
              curve: TalonMotion.standard,
              padding: const EdgeInsets.all(TalonSpace.sm),
              decoration: BoxDecoration(
                borderRadius: TalonRadius.rMd,
                color: selected
                    ? TalonColors.accent.withValues(alpha: 0.14)
                    : (_hover ? TalonColors.surface : Colors.transparent),
                border: Border.all(color: border),
              ),
              child: Row(
                children: [
                  // The same accent-tinted glyph square the status card's stat
                  // tiles wear, so the rail reads as part of the same set.
                  AnimatedContainer(
                    duration: TalonMotion.fast,
                    width: 34,
                    height: 34,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: selected
                          ? TalonColors.accent.withValues(alpha: 0.18)
                          : TalonColors.surfaceHi,
                      borderRadius: TalonRadius.rSm,
                    ),
                    child: Icon(
                      widget.icon,
                      size: 18,
                      color: selected
                          ? TalonColors.accent
                          : TalonColors.textDim,
                    ),
                  ),
                  const SizedBox(width: TalonSpace.md - 2),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          widget.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 13.5,
                            fontWeight: selected
                                ? FontWeight.w700
                                : FontWeight.w600,
                            color: selected
                                ? TalonColors.text
                                : TalonColors.textDim,
                          ),
                        ),
                        const SizedBox(height: TalonSpace.xxs),
                        Text(
                          widget.subtitle,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 11.5,
                            height: 1.3,
                            color: TalonColors.textFaint,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class SettingsSection extends StatelessWidget {
  final String title;
  final Widget child;
  const SettingsSection({super.key, required this.title, required this.child});

  @override
  Widget build(BuildContext context) {
    // A crisp solid card — white surface, hairline border, soft shadow —
    // floating on the off-white canvas. Not a blurred glass panel: the light
    // design reads as clean layered paper, not frost.
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: TalonColors.surface,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: TalonColors.glassStroke, width: 1),
        boxShadow: TalonShadows.soft,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title.toUpperCase(), style: TalonType.eyebrow),
          const SizedBox(height: 14),
          child,
        ],
      ),
    );
  }
}

/// A full-width action row for daemon controls (restart / dream): icon,
/// label + subtitle, and a trailing spinner while the action is in flight.
class ControlButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final String subtitle;
  final bool pending;
  final VoidCallback? onTap;
  const ControlButton({
    super.key,
    required this.icon,
    required this.label,
    required this.subtitle,
    required this.pending,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: TalonRadius.rMd,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            borderRadius: TalonRadius.rMd,
            border: Border.all(color: TalonColors.glassStroke),
          ),
          child: Row(
            children: [
              Icon(icon, size: 20, color: TalonColors.textDim),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label,
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: TextStyle(
                        fontSize: 12,
                        height: 1.35,
                        color: TalonColors.textFaint,
                      ),
                    ),
                  ],
                ),
              ),
              if (pending)
                const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              else
                Icon(
                  Icons.chevron_right,
                  size: 18,
                  color: TalonColors.textFaint,
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class ModelRow extends StatelessWidget {
  final AppState state;
  final ConfigSnapshot cfg;
  final ValueChanged<String> onPick;
  const ModelRow({
    super.key,
    required this.state,
    required this.cfg,
    required this.onPick,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        const SizedBox(
          width: 120,
          child: Text('Default model', style: TextStyle(fontSize: 13.5)),
        ),
        Expanded(
          child: InkWell(
            onTap: () => _pick(context),
            borderRadius: BorderRadius.circular(10),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: TalonColors.glassStroke),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      cfg.modelDisplay.isEmpty ? cfg.model : cfg.modelDisplay,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 14),
                    ),
                  ),
                  Icon(
                    Icons.unfold_more,
                    size: 16,
                    color: TalonColors.textFaint,
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _pick(BuildContext context) async {
    HapticFeedback.selectionClick();
    final picked = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: TalonColors.void1,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => SizedBox(
        height: MediaQuery.of(ctx).size.height * 0.7,
        child: ListView(
          padding: EdgeInsets.fromLTRB(12, 12, 12, 12 + navInset(ctx)),
          children: [
            for (final m in state.models)
              ListTile(
                title: Text(m.displayName),
                subtitle: Text(
                  m.provider,
                  style: TextStyle(color: TalonColors.textFaint),
                ),
                trailing: m.id == cfg.model
                    ? Icon(Icons.check, color: TalonColors.accent)
                    : null,
                onTap: () => Navigator.pop(ctx, m.id),
              ),
          ],
        ),
      ),
    );
    if (picked != null) onPick(picked);
  }
}
