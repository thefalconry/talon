import 'dart:async';

import 'package:flutter/scheduler.dart';

/// Collapses a burst of change signals into at most one delivery per frame.
///
/// A reply streams at 20-60 deltas a second, often several per network read;
/// the widgets showing it can only change once per frame anyway. [request]
/// arms a transient frame callback (which also schedules the frame) and
/// ignores further requests until it runs. Without a scheduler — plain unit
/// tests with no binding — it falls back to a microtask, which still merges
/// everything delivered in one event-loop turn.
///
/// While the app is hidden Flutter stops producing frames, so a streaming
/// reply in a backgrounded window does no UI work at all until it's shown.
class FrameCoalescer {
  FrameCoalescer(this._deliver);

  final void Function() _deliver;
  bool _pending = false;

  /// Whether a delivery is scheduled but hasn't run yet.
  bool get pending => _pending;

  void request() {
    if (_pending) return;
    _pending = true;
    final scheduler = _scheduler();
    if (scheduler == null) {
      scheduleMicrotask(_run);
    } else {
      scheduler.scheduleFrameCallback((_) => _run());
    }
  }

  /// Drop a scheduled delivery (the caller is about to notify anyway).
  void cancel() => _pending = false;

  void _run() {
    if (!_pending) return;
    _pending = false;
    _deliver();
  }

  static SchedulerBinding? _scheduler() {
    try {
      return SchedulerBinding.instance;
    } catch (_) {
      return null; // no binding (unit tests without flutter_test widgets)
    }
  }
}
