import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';

import '../state/app_state.dart';
import '../theme.dart';
import 'effects.dart';

/// Compact "Talon running / connecting / offline" indicator with a live dot.
class StatusPill extends StatelessWidget {
  final AppState state;

  /// Phone top bar: the wordmark next to it already says "Talon", so the
  /// label drops to the state alone and the pill tightens to fit a line that
  /// also carries identity and settings.
  final bool compact;

  const StatusPill({super.key, required this.state, this.compact = false});

  @override
  Widget build(BuildContext context) {
    final (color, label) = switch (state.conn) {
      ConnState.connected =>
        (TalonColors.ok, compact ? 'Online' : 'Talon online'),
      ConnState.connecting => (TalonColors.warn, _connectingLabel()),
      ConnState.error => (TalonColors.bad, 'Offline'),
      ConnState.idle => (TalonColors.textFaint, 'Idle'),
    };

    // "Online" on its own is ambiguous read aloud — it could be the device,
    // the network, a contact. Name what is online, and mark it a live region
    // so a state change is announced rather than only recoloured.
    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Talon connection: $label',
      excludeSemantics: true,
      child: _pill(color, label),
    );
  }

  Widget _pill(Color color, String label) {
    return Container(
      padding: EdgeInsets.symmetric(
          horizontal: compact ? 9 : 11, vertical: compact ? 5 : 7),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: TalonRadius.rPill,
        border: Border.all(color: color.withValues(alpha: 0.32)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _Dot(color: color, pulse: state.conn == ConnState.connecting),
          const SizedBox(width: 7),
          Text(
            label,
            style: TextStyle(
              color: color,
              fontSize: compact ? 11.5 : 12,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.2,
            ),
          ),
        ],
      ),
    );
  }

  String _connectingLabel() {
    final d = state.daemon;
    return d.detail ?? 'Connecting…';
  }
}

/// A live status dot. While connecting it emits a soft expanding ring; once
/// connected it rests solid. The ripple is a flutter_animate loop, gated on the
/// platform reduce-motion setting.
class _Dot extends StatelessWidget {
  final Color color;
  final bool pulse;
  const _Dot({required this.color, required this.pulse});

  @override
  Widget build(BuildContext context) {
    final dot = Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(shape: BoxShape.circle, color: color),
    );

    if (!pulse || MediaQuery.of(context).disableAnimations) return dot;
    return SizedBox(
      width: 8,
      height: 8,
      child: Stack(
        clipBehavior: Clip.none,
        alignment: Alignment.center,
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: color.withValues(alpha: 0.6),
            ),
          )
              .animate(onPlay: (c) => c.repeat())
              .fadeOut(duration: 1200.ms, curve: Curves.easeOut)
              .scaleXY(end: 2.6, curve: Curves.easeOut)
              .wrapAmbient(),
          dot,
        ],
      ),
    );
  }
}
