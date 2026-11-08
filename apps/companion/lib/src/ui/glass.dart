import 'dart:ui';

import 'package:flutter/material.dart';

import '../theme.dart';
import 'effects.dart';

/// A frosted-glass panel: blurred translucent fill, hairline stroke, soft
/// rounding. The building block of the whole UI.
///
/// Under "Reduce effects" ([TalonEffects.liveBlur] false) the live
/// `BackdropFilter` is switched off and the panel paints the same translucent fill
/// statically. Everything behind a panel is the backdrop's soft radial
/// gradients — already smooth — so the two read almost identically, but the
/// static one needs no offscreen blur pass on every frame.
class Glass extends StatelessWidget {
  final Widget child;
  final double radius;
  final EdgeInsetsGeometry? padding;
  final double blur;
  final Color? fill;
  final Color? stroke;
  final Gradient? glow;

  /// Optional drop shadows painted outside the blur clip (e.g.
  /// [TalonShadows.soft]) so a panel can float off the backdrop.
  final List<BoxShadow>? shadows;

  const Glass({
    super.key,
    required this.child,
    this.radius = 18,
    this.padding,
    this.blur = 18,
    this.fill,
    this.stroke,
    this.glow,
    this.shadows,
  });

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: TalonEffects.reduce,
      builder: (context, _, __) => _panel(liveBlur: TalonEffects.liveBlur),
    );
  }

  Widget _panel({required bool liveBlur}) {
    final r = BorderRadius.circular(radius);
    final surface = Container(
      padding: padding,
      decoration: BoxDecoration(
        gradient: glow,
        color: glow == null ? (fill ?? TalonColors.glassFill) : null,
        borderRadius: r,
        border: Border.all(
          color: stroke ?? TalonColors.glassStroke,
          width: 1,
        ),
      ),
      child: child,
    );
    // Same widget shape either way (the filter is switched off, not removed)
    // so flipping the setting never remounts — and resets — what's inside.
    final panel = ClipRRect(
      borderRadius: r,
      clipBehavior: liveBlur ? Clip.antiAlias : Clip.none,
      child: BackdropFilter(
        enabled: liveBlur,
        filter: ImageFilter.blur(sigmaX: blur, sigmaY: blur),
        child: surface,
      ),
    );
    if (shadows == null) return panel;
    return DecoratedBox(
      decoration: BoxDecoration(borderRadius: r, boxShadow: shadows),
      child: panel,
    );
  }
}

/// The themed canvas behind every screen: the palette's backdrop gradient with
/// the ambient glow on top. RootView paints it once for the main shell; pushed
/// routes (Settings, Connect) are opaque and render outside that tree, so they
/// must wrap their transparent Scaffolds in this too — otherwise nothing
/// paints behind them and the route shows as pitch black in light mode.
///
/// The glow and the content sit behind separate [RepaintBoundary]s: a
/// streaming reply repainting the chat never repaints the blobs, and a blob
/// step never repaints the chat.
class TalonBackdrop extends StatelessWidget {
  final Widget child;
  const TalonBackdrop({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(gradient: TalonColors.backdrop),
      child: Stack(
        children: [
          const Positioned.fill(child: RepaintBoundary(child: AmbientGlow())),
          Positioned.fill(child: RepaintBoundary(child: child)),
        ],
      ),
    );
  }
}

/// A whisper of radial colour behind the backdrop, giving the near-black canvas
/// depth without tinting the whole surface.
///
/// The blobs drift on a slow ping-pong sweep — but only while someone is
/// looking: the sweep stops under reduce-motion, "Reduce effects", when the
/// window is unfocused or hidden, and once the user has been idle for
/// [TalonEffects.idleAfter] (checked at the end of each sweep, so there is no
/// timer). A stopped glow schedules no frames, so an idle window renders
/// nothing at all instead of redrawing — and re-blurring — at the display
/// refresh rate forever (#1058). Any input resumes it where it stopped.
class AmbientGlow extends StatefulWidget {
  const AmbientGlow({super.key});

  /// One sweep (there and back is two). Slow on purpose.
  static const Duration sweep = Duration(seconds: 20);

  @override
  State<AmbientGlow> createState() => _AmbientGlowState();
}

class _AmbientGlowState extends State<AmbientGlow>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: AmbientGlow.sweep)
        ..addStatusListener(_onStatus);

  /// Direction of the current (or interrupted) sweep.
  bool _outbound = true;
  bool _reduceMotion = false;

  @override
  void initState() {
    super.initState();
    TalonEffects.changes.addListener(_sync);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduceMotion = MediaQuery.of(context).disableAnimations;
    _sync();
  }

  @override
  void dispose() {
    TalonEffects.changes.removeListener(_sync);
    _c.dispose();
    super.dispose();
  }

  bool get _allowed => !_reduceMotion && TalonEffects.ambientMotion;

  void _sync() {
    if (!mounted) return;
    if (_allowed) {
      if (!_c.isAnimating) _run();
    } else if (_c.isAnimating) {
      _c.stop();
    }
  }

  void _run() => _outbound ? _c.forward() : _c.reverse();

  void _onStatus(AnimationStatus status) {
    if (status != AnimationStatus.completed &&
        status != AnimationStatus.dismissed) {
      return;
    }
    _outbound = status == AnimationStatus.dismissed;
    // End of a sweep: the natural moment to notice the user walked away.
    TalonEffects.checkIdle();
    if (_allowed) _run();
  }

  @override
  Widget build(BuildContext context) {
    // The light canvas takes a slightly stronger wash than the near-black one
    // (colour reads quieter on white).
    final boost = TalonTheme.isDark ? 1.0 : 1.25;
    return IgnorePointer(
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          final t = _c.value;
          return Stack(
            children: [
              Positioned(
                top: -180,
                left: -140,
                child: _drift(
                  _blob(TalonColors.accent.withValues(alpha: 0.14 * boost),
                      460),
                  const Offset(24, 18),
                  const Interval(0, 0.8, curve: Curves.easeInOut),
                  t,
                ),
              ),
              Positioned(
                top: -120,
                right: -180,
                child: _drift(
                  _blob(TalonColors.accent2.withValues(alpha: 0.08 * boost),
                      400),
                  const Offset(-26, 20),
                  const Interval(0.1, 0.9, curve: Curves.easeInOut),
                  t,
                ),
              ),
              Positioned(
                bottom: -200,
                right: -140,
                child: _drift(
                  _blob(TalonColors.accent2.withValues(alpha: 0.10 * boost),
                      500),
                  const Offset(-20, -22),
                  const Interval(0.2, 1, curve: Curves.easeInOut),
                  t,
                ),
              ),
              Positioned(
                bottom: -160,
                left: -200,
                child: _drift(
                  _blob(
                      TalonColors.accentDeep.withValues(alpha: 0.09 * boost),
                      420),
                  const Offset(28, -16),
                  const Interval(0.05, 0.95, curve: Curves.easeInOut),
                  t,
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _drift(Widget child, Offset to, Curve curve, double t) =>
      Transform.translate(offset: to * curve.transform(t), child: child);

  /// Each blob is its own repaint boundary, so a drift step only moves an
  /// already-rasterised layer instead of repainting the gradient.
  Widget _blob(Color color, double size) => RepaintBoundary(
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient:
                RadialGradient(colors: [color, color.withValues(alpha: 0)]),
          ),
        ),
      );
}
