import 'dart:collection';
import 'dart:developer' as developer;
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';

enum LogLevel {
  debug,
  info,
  warn,
  error;

  String get label => name.toUpperCase();
}

/// Strip credentials from text bound for the UI or the log ring: `token=`,
/// pairing-link `t=` and provisioning grants in URLs, and `Bearer` header
/// values. Exception text from the HTTP stack quotes the full request URL,
/// which carries the bridge token as a query parameter.
String redactSecrets(String text) => text
    .replaceAllMapped(
      _secretParam,
      (m) => '${m[1]}${m[2]}=…',
    )
    .replaceAllMapped(_bearer, (m) => '${m[1]} …')
    // A per-device credential quoted anywhere else (a JSON reply, an
    // exception's toString): keep the public credential id, drop the secret.
    .replaceAllMapped(_deviceCredential, (m) => 'tdc1.${m[1]}.…');

final _secretParam = RegExp(
  r"""([?&;]|\b)(token|access_token|t|provision|grant)=([^&\s#"'<>]+)""",
  caseSensitive: false,
);
final _deviceCredential = RegExp(r'\btdc1\.([0-9a-f]{16})\.[A-Za-z0-9_-]+');
final _bearer = RegExp(
  r'\b(Bearer)\s+[A-Za-z0-9._~+/=-]+',
  caseSensitive: false,
);

/// Tiny structured logger for connection diagnostics.
///
/// It writes through Flutter/devtools-friendly sinks and keeps a bounded
/// in-memory tail for future diagnostics UI. Debug logs are skipped in release.
class AppLog {
  static const int _maxLines = 200;
  static final ListQueue<String> _lines = ListQueue<String>(_maxLines);

  static List<String> get recent => List.unmodifiable(_lines);

  static void debug(String tag, String message, [Object? error]) =>
      write(LogLevel.debug, tag, message, error);

  static void info(String tag, String message, [Object? error]) =>
      write(LogLevel.info, tag, message, error);

  static void warn(String tag, String message, [Object? error]) =>
      write(LogLevel.warn, tag, message, error);

  static void error(String tag, String message, [Object? error]) =>
      write(LogLevel.error, tag, message, error);

  static void write(
    LogLevel level,
    String tag,
    String message, [
    Object? error,
  ]) {
    if (kReleaseMode && level == LogLevel.debug) return;
    message = redactSecrets(message);
    final line =
        '${DateTime.now().toIso8601String()} ${level.label} [$tag] $message';
    if (_lines.length == _maxLines) _lines.removeFirst();
    _lines.addLast(line);

    developer.log(
      message,
      name: 'talon.$tag',
      level: _levelValue(level),
      error: error == null ? null : redactSecrets('$error'),
    );
    if (!kReleaseMode) debugPrint(line);
  }

  static int _levelValue(LogLevel level) {
    switch (level) {
      case LogLevel.debug:
        return 500;
      case LogLevel.info:
        return 800;
      case LogLevel.warn:
        return 900;
      case LogLevel.error:
        return 1000;
    }
  }

  /// Pattern-matches well-known transport failures and returns an
  /// actionable hint, or null if nothing recognized. Surfaced under raw
  /// error text in the UI so a connection failure doesn't require pulling
  /// a screenshot + reading source to diagnose.
  ///
  /// Platform-aware where it matters: Android produces the exact same
  /// `errno = 1, "Operation not permitted"` text for at least three
  /// distinct causes (missing INTERNET permission, cleartext-traffic
  /// block, and -- in principle -- an actual sandboxed socket denial), and
  /// that text is also macOS's sandbox-entitlement signature. Blindly
  /// pointing everyone at the macOS fix was actively wrong on Android.
  static String? diagnose(String rawError) {
    final e = rawError.toLowerCase();
    final isPermissionDenial =
        e.contains('operation not permitted') && e.contains('errno = 1');

    if (isPermissionDenial && _isAndroid) {
      return 'Android refused the socket outright (not a timeout or '
          'refused connection) — almost always either (a) the release '
          'build is missing the INTERNET permission in '
          'AndroidManifest.xml, or (b) the cleartext-traffic block, since '
          'this bridge has no TLS. Check '
          'android/app/src/main/AndroidManifest.xml has both '
          '<uses-permission android:name="android.permission.INTERNET"/> '
          'and android:usesCleartextTraffic="true" on <application>, or '
          're-run scripts/fix-android-cleartext.sh and rebuild. Not a bad '
          'host/port/token.';
    }
    if (isPermissionDenial && _isMacOS) {
      return 'This usually means the desktop build is sandboxed without '
          'outbound network access (macOS: missing '
          'com.apple.security.network.client entitlement — run '
          'scripts/fix-macos-entitlements.sh and rebuild). Not a bad '
          'host/port/token.';
    }
    if (isPermissionDenial) {
      return 'OS-level permission denial on the socket — not a timeout or '
          'refused connection. Check the app has network permission on '
          'this platform. Not a bad host/port/token.';
    }
    if (e.contains('cleartextnotpermitted') ||
        (e.contains('cleartext') && e.contains('not permitted'))) {
      return 'Android blocks plain HTTP by default and this bridge has no '
          'TLS support, so the HTTPS toggle won\'t help here — run '
          'scripts/fix-android-cleartext.sh and rebuild instead.';
    }
    if (e.contains('connection refused')) {
      return 'Nothing is listening on that host/port — check the daemon is '
          'running and the native frontend is configured with that port.';
    }
    if (e.contains('timed out') || e.contains('timeout')) {
      return 'No response within the timeout — likely a firewall or '
          'network path issue rather than the daemon itself.';
    }
    if (e.contains('401') || e.contains('unauthorized')) {
      return 'Auth rejected — the bearer token doesn\'t match the '
          'daemon\'s configured token.';
    }
    return null;
  }

  /// Dump of recent log lines for a "copy diagnostics" action.
  static String dump() => recent.join('\n');

  // Platform.operatingSystem throws on web; this app doesn't ship a web
  // build (see pubspec.yaml / README), but guard anyway rather than crash
  // the diagnosis path itself.
  static bool get _isAndroid => _safePlatformCheck(() => Platform.isAndroid);
  static bool get _isMacOS => _safePlatformCheck(() => Platform.isMacOS);

  static bool _safePlatformCheck(bool Function() check) {
    try {
      return check();
    } catch (_) {
      return false;
    }
  }
}
