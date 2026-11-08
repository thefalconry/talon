import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/widgets.dart';

/// Rendering-cost policy for the decorative layer: the drifting ambient
/// backdrop, live `BackdropFilter` blur on glass panels, and the looping
/// "alive" pulses.
///
/// A perpetual animation makes Flutter produce a frame on every vsync for as
/// long as it runs, and each of those frames re-applies every blur on screen.
/// That is the difference between an idle window costing ~0% and a few % of a
/// core plus a busy GPU (#1058). So decorative motion only runs while someone
/// is actually looking at the app:
///
/// * [focused] — the app is resumed. On desktop the embedder reports
///   `inactive` when the window loses focus and `hidden` when it is minimised
///   or closed to the tray, so a window left open behind others goes quiet.
/// * [idle] — no pointer or keyboard input for [idleAfter]. A chat left open
///   on screen stops animating its background after half a minute.
/// * [reduce] — the user's "Reduce effects" setting (default on for Windows
///   and Linux): no ambient motion at all, and glass panels paint a static
///   translucent fill instead of a live blur.
class TalonEffects {
  TalonEffects._();

  /// "Reduce effects" is on by default where the blur/animation cost is
  /// highest relative to what it adds: desktop Windows and Linux (large
  /// windows, often software or ANGLE-backed GL).
  static bool defaultReduceFor(TargetPlatform platform) =>
      platform == TargetPlatform.windows || platform == TargetPlatform.linux;

  /// The user's "Reduce effects" setting. Seeded from prefs in main.dart.
  static final ValueNotifier<bool> reduce = ValueNotifier(false);

  /// True when the process was told to render through a software GL
  /// rasteriser (Mesa llvmpipe/softpipe — VMs, remote desktops, broken GPU
  /// drivers). Every blur and every animated frame is CPU-rasterised there,
  /// and repeated large offscreen blur layers are a known crash source on
  /// some Mesa builds (#1062), so blur and ambient motion are forced off
  /// regardless of the setting. Resolved once at startup.
  static bool softwareRendering =
      !kIsWeb && isSoftwareGl(Platform.environment);

  /// Whether [env] selects a software GL rasteriser. Linux only: Mesa reads
  /// `LIBGL_ALWAYS_SOFTWARE` and `GALLIUM_DRIVER`.
  @visibleForTesting
  static bool isSoftwareGl(Map<String, String> env) {
    if (kIsWeb || !Platform.isLinux) return false;
    final always = env['LIBGL_ALWAYS_SOFTWARE']?.trim().toLowerCase();
    if (always != null &&
        always.isNotEmpty &&
        always != '0' &&
        always != 'false') {
      return true;
    }
    final driver = env['GALLIUM_DRIVER']?.trim().toLowerCase();
    return driver == 'llvmpipe' || driver == 'softpipe' || driver == 'swr';
  }

  /// True while the app is resumed (focused and visible). False when the
  /// window is unfocused, hidden, minimised, or the app is backgrounded.
  static final ValueNotifier<bool> focused = ValueNotifier(true);

  /// True once there has been no user input for [idleAfter].
  static final ValueNotifier<bool> idle = ValueNotifier(false);

  /// How long without input before the ambient backdrop settles.
  static const Duration idleAfter = Duration(seconds: 30);

  /// Injectable clock so tests can step past [idleAfter] without waiting.
  @visibleForTesting
  static DateTime Function() clock = DateTime.now;

  static DateTime _lastActivity = DateTime.now();

  /// Fires whenever any input to [ambientMotion] changes.
  static final Listenable changes = Listenable.merge([reduce, focused, idle]);

  /// Whether the ambient backdrop may animate right now.
  static bool get ambientMotion =>
      !reduce.value && !softwareRendering && focused.value && !idle.value;

  /// Whether glass panels may use a live `BackdropFilter`.
  static bool get liveBlur => !reduce.value && !softwareRendering;

  /// Mirror the app lifecycle. Anything but `resumed` counts as unfocused;
  /// null (no lifecycle reported yet, e.g. in tests) counts as focused.
  static void setLifecycle(AppLifecycleState? state) {
    focused.value = state == null || state == AppLifecycleState.resumed;
    if (focused.value) markActivity();
  }

  /// Record user input. Cheap enough to call on every pointer event: it only
  /// stamps the time, and notifies only on the idle → active edge.
  static void markActivity() {
    _lastActivity = clock();
    if (idle.value) idle.value = false;
  }

  /// Re-evaluate [idle]. Called by the ambient animation at the end of each
  /// sweep rather than from a timer, so an idle app holds no timers at all.
  static bool checkIdle() {
    if (!idle.value && clock().difference(_lastActivity) >= idleAfter) {
      idle.value = true;
    }
    return idle.value;
  }

  /// Reset every notifier to its default. Tests only.
  @visibleForTesting
  static void resetForTest() {
    clock = DateTime.now;
    softwareRendering = false;
    reduce.value = false;
    focused.value = true;
    idle.value = false;
    _lastActivity = clock();
  }
}

/// Gates a looping decorative animation (pulses, shimmers, carets) on
/// [TalonEffects.focused]: while the window is unfocused or hidden its
/// tickers are muted, so a spinner left running behind other windows stops
/// scheduling frames. Nests correctly inside an outer disabled [TickerMode].
class AmbientMotion extends StatelessWidget {
  final Widget child;
  const AmbientMotion({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: TalonEffects.focused,
      builder: (context, focused, child) =>
          TickerMode(enabled: focused, child: child!),
      child: child,
    );
  }
}

/// Records user input for [TalonEffects.idle]. Wraps the whole app (the
/// MaterialApp builder) so every route counts. Translucent: it never takes
/// part in hit-testing decisions, only observes.
class ActivityListener extends StatelessWidget {
  final Widget child;
  const ActivityListener({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    void mark(PointerEvent _) => TalonEffects.markActivity();
    return Listener(
      behavior: HitTestBehavior.translucent,
      onPointerDown: mark,
      onPointerHover: mark,
      onPointerMove: mark,
      onPointerSignal: mark,
      child: child,
    );
  }
}

/// `.wrapAmbient()` for the tail of a flutter_animate chain:
/// `x.animate(onPlay: (c) => c.repeat()).shimmer().wrapAmbient()`.
extension AmbientMotionX on Widget {
  Widget wrapAmbient() => AmbientMotion(child: this);
}
