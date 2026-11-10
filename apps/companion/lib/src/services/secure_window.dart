import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'log.dart';

/// Controls the Android window's FLAG_SECURE, which keeps the app out of
/// screenshots, screen recordings, screen sharing and the recents thumbnail.
///
/// Two inputs decide it:
///
///   * the user's "Block screenshots and screen recording" setting
///     ([setBlockScreenshots]) — app-wide while on;
///   * holders ([acquire] / [release]) — the lock screen holds the flag
///     while the app is locked, whatever the setting says.
///
/// The flag is set while either asks for it. Android only: iOS and the
/// desktop platforms have no equivalent, so every call is a no-op there
/// ([supported] is false and Settings says so).
class SecureWindow {
  SecureWindow._();

  static MethodChannel _channel = const MethodChannel('talon/secure');
  static bool Function() _supported = () => !kIsWeb && Platform.isAndroid;
  static int _holders = 0;
  static bool _blockScreenshots = false;
  static bool _applied = false;

  /// Whether this platform can block screenshots at all.
  static bool get supported => _supported();

  /// Number of screens currently holding the flag (for tests).
  @visibleForTesting
  static int get holders => _holders;

  @visibleForTesting
  static void debugOverride({MethodChannel? channel, bool? supported}) {
    if (channel != null) _channel = channel;
    if (supported != null) _supported = () => supported;
    _holders = 0;
    _blockScreenshots = false;
    _applied = false;
  }

  /// The user's app-wide setting. Applied live.
  static void setBlockScreenshots(bool block) {
    _blockScreenshots = block;
    _apply();
  }

  /// Force the flag on regardless of the setting (the lock screen).
  /// Reference-counted; pair every call with [release].
  static void acquire() {
    _holders++;
    _apply();
  }

  static void release() {
    if (_holders == 0) return;
    _holders--;
    _apply();
  }

  static void _apply() {
    final want = _blockScreenshots || _holders > 0;
    if (want == _applied) return;
    _applied = want;
    _set(want);
  }

  /// Keep the app out of the recents screenshot entirely (Android 13+,
  /// `Activity.setRecentsScreenshotEnabled(false)`) — on while the app lock
  /// is on, so the switcher never shows content even for the frame before
  /// the privacy cover paints. Unlike FLAG_SECURE it doesn't block the
  /// user's own screenshots. Older Android and other platforms rely on the
  /// cover alone.
  static void setRecentsHidden(bool hidden) {
    if (!_supported()) return;
    _channel
        .invokeMethod<void>('setRecentsScreenshotEnabled', !hidden)
        .catchError((Object e) {
      AppLog.debug('secure', 'setRecentsScreenshotEnabled unavailable', e);
    });
  }

  static void _set(bool secure) {
    if (!_supported()) return;
    _channel.invokeMethod<void>('setSecure', secure).catchError((Object e) {
      // Older builds have no channel; the screen still works, just without
      // the flag.
      AppLog.debug('secure', 'setSecure unavailable', e);
    });
  }
}
