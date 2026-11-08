import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb, visibleForTesting;
import 'package:flutter/services.dart';

import 'log.dart';

/// Keeps the device awake while mesh commands run — and only then.
///
/// The Android foreground service no longer holds a wake lock and a Wi-Fi
/// lock for its entire life (#1060); an idle open socket doesn't need them.
/// A command in flight does: a shell, a locate fix or a large transfer must
/// not be suspended halfway through with the screen off. [hold] acquires the
/// native `talon/wake` locks (WakeBridge.kt, registered on the foreground
/// service's engine) when the first concurrent command starts and releases
/// them when the last one ends. The native locks carry a [maxHold] timeout
/// too, so nothing can pin them if this isolate dies mid-command.
///
/// Everywhere else — desktop, the UI isolate, tests — it's a no-op.
class CommandWakeLock {
  CommandWakeLock._();

  static const MethodChannel _channel = MethodChannel('talon/wake');

  /// Upper bound on a single hold; each new command extends it.
  static const Duration maxHold = Duration(minutes: 10);

  static int _active = 0;
  static bool _unavailable = false;

  /// Test hook replacing the platform channel.
  @visibleForTesting
  static Future<void> Function(String method, Object? args)? debugInvoke;

  /// Commands currently holding the lock.
  @visibleForTesting
  static int get active => _active;

  /// Run [body] with the device held awake.
  static Future<T> hold<T>(Future<T> Function() body) async {
    _active++;
    try {
      // Every start (re)acquires: the native lock isn't reference-counted,
      // so this just extends its timeout while commands keep coming.
      await _call('acquire', {'timeoutMs': maxHold.inMilliseconds});
      return await body();
    } finally {
      _active--;
      if (_active == 0) await _call('release', null);
    }
  }

  static Future<void> _call(String method, Object? args) async {
    final hook = debugInvoke;
    if (hook != null) return hook(method, args);
    if (_unavailable || kIsWeb || !Platform.isAndroid) return;
    try {
      await _channel.invokeMethod<void>(method, args);
    } on MissingPluginException {
      // Not registered on this engine (the UI isolate's fallback mesh).
      _unavailable = true;
    } catch (e) {
      AppLog.debug('mesh', 'wake lock $method failed', e);
    }
  }

  @visibleForTesting
  static void resetForTest() {
    _active = 0;
    _unavailable = false;
    debugInvoke = null;
  }
}
