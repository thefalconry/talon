import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'passcode_kdf.dart';

/// Everything the app lock persists, as one secure-store value.
///
/// Holds no passcode and nothing that opens anything without one: the salt,
/// the Argon2id-derived [verifier], and the chat-snapshot data key sealed
/// under a second passcode-derived key ([wrappedDataKey]). [keyCheck] lets a
/// data key released by biometrics be recognised without trusting it blindly.
class AppLockRecord {
  static const int currentVersion = 1;

  final KdfParams kdf;
  final Uint8List salt;
  final Uint8List verifier;
  final String wrappedDataKey;
  final Uint8List keyCheck;

  /// The passcode is digits only — the lock screen shows a number pad.
  final bool numeric;

  /// Biometric unlock enrolled (the data key has a copy behind the platform's
  /// user-authentication gate).
  final bool biometrics;

  /// Lock after this long in the background or idle. Zero = as soon as the
  /// app leaves the foreground.
  final int timeoutSeconds;

  /// Erase the connection after this many failed attempts in a row; null =
  /// never (the default).
  final int? wipeAfter;

  /// Mesh device-control commands need a local unlock before they run.
  final bool requireUnlockForElevated;

  /// Failed attempts since the last success. Persisted, so killing the app
  /// doesn't reset the backoff.
  final int failedAttempts;
  final int? lastFailureAtMs;

  const AppLockRecord({
    required this.kdf,
    required this.salt,
    required this.verifier,
    required this.wrappedDataKey,
    required this.keyCheck,
    this.numeric = false,
    this.biometrics = false,
    this.timeoutSeconds = defaultTimeoutSeconds,
    this.wipeAfter,
    this.requireUnlockForElevated = false,
    this.failedAttempts = 0,
    this.lastFailureAtMs,
  });

  static const int defaultTimeoutSeconds = 300;

  AppLockRecord copyWith({
    KdfParams? kdf,
    Uint8List? salt,
    Uint8List? verifier,
    String? wrappedDataKey,
    Uint8List? keyCheck,
    bool? numeric,
    bool? biometrics,
    int? timeoutSeconds,
    int? wipeAfter,
    bool clearWipeAfter = false,
    bool? requireUnlockForElevated,
    int? failedAttempts,
    int? lastFailureAtMs,
    bool clearLastFailure = false,
  }) =>
      AppLockRecord(
        kdf: kdf ?? this.kdf,
        salt: salt ?? this.salt,
        verifier: verifier ?? this.verifier,
        wrappedDataKey: wrappedDataKey ?? this.wrappedDataKey,
        keyCheck: keyCheck ?? this.keyCheck,
        numeric: numeric ?? this.numeric,
        biometrics: biometrics ?? this.biometrics,
        timeoutSeconds: timeoutSeconds ?? this.timeoutSeconds,
        wipeAfter: clearWipeAfter ? null : (wipeAfter ?? this.wipeAfter),
        requireUnlockForElevated:
            requireUnlockForElevated ?? this.requireUnlockForElevated,
        failedAttempts: failedAttempts ?? this.failedAttempts,
        lastFailureAtMs:
            clearLastFailure ? null : (lastFailureAtMs ?? this.lastFailureAtMs),
      );

  String encode() => jsonEncode({
        'v': currentVersion,
        'kdf': kdf.toJson(),
        'salt': base64Encode(salt),
        'verifier': base64Encode(verifier),
        'dataKey': wrappedDataKey,
        'keyCheck': base64Encode(keyCheck),
        'numeric': numeric,
        'biometrics': biometrics,
        'timeout': timeoutSeconds,
        if (wipeAfter != null) 'wipeAfter': wipeAfter,
        'elevated': requireUnlockForElevated,
        'failed': failedAttempts,
        if (lastFailureAtMs != null) 'failedAt': lastFailureAtMs,
      });

  /// The record without its [verifier]: what the lock keeps *outside* the
  /// secure store (see AppLockController's params mirror) so that a keychain
  /// that can't be read — every ad-hoc-signed macOS update used to cause
  /// that — is recovered by re-entering the passcode instead of erasing the
  /// device. The passcode is then checked by opening [wrappedDataKey].
  String encodeParams() {
    final json = jsonDecode(encode()) as Map<String, dynamic>;
    json.remove('verifier');
    return jsonEncode(json);
  }

  /// Decode [encodeParams] output. The result has an empty [verifier]; it can
  /// only be checked through [wrappedDataKey].
  static AppLockRecord decodeParams(String raw) =>
      decode(raw, requireVerifier: false);

  /// Throws [FormatException] for anything that isn't a record this build
  /// understands — the caller treats that as "no usable lock".
  static AppLockRecord decode(String raw, {bool requireVerifier = true}) {
    final json = jsonDecode(raw);
    if (json is! Map || json['v'] != currentVersion) {
      throw const FormatException('unsupported app-lock record');
    }
    Uint8List bytes(String key) {
      final v = json[key];
      if (v is! String) throw FormatException('missing $key');
      return base64Decode(v);
    }

    final kdf = json['kdf'];
    final dataKey = json['dataKey'];
    if (kdf is! Map || dataKey is! String) {
      throw const FormatException('incomplete app-lock record');
    }
    int? optInt(String key) {
      final v = json[key];
      return v is int ? v : null;
    }

    return AppLockRecord(
      kdf: KdfParams.fromJson(kdf.cast<String, dynamic>()),
      salt: bytes('salt'),
      verifier: requireVerifier || json['verifier'] is String
          ? bytes('verifier')
          : Uint8List(0),
      wrappedDataKey: dataKey,
      keyCheck: bytes('keyCheck'),
      numeric: json['numeric'] == true,
      biometrics: json['biometrics'] == true,
      timeoutSeconds: math.max(0, optInt('timeout') ?? defaultTimeoutSeconds),
      wipeAfter: optInt('wipeAfter'),
      requireUnlockForElevated: json['elevated'] == true,
      failedAttempts: math.max(0, optInt('failed') ?? 0),
      lastFailureAtMs: optInt('failedAt'),
    );
  }
}

/// Wait before another passcode attempt is accepted: none until the first
/// failure, then 1s, 2s, 4s … doubling, capped at 60s.
Duration unlockDelayAfter(int failures) {
  if (failures <= 0) return Duration.zero;
  final exponent = failures - 1;
  if (exponent >= 6) return const Duration(seconds: 60);
  return Duration(seconds: math.min(60, 1 << exponent));
}

/// Passcode rules: at least 6 characters — a PIN of 6+ digits, or any
/// password. Returns a message for the UI, or null when acceptable.
String? validatePasscode(String passcode) {
  if (passcode.trim().length != passcode.length) {
    return 'No leading or trailing spaces.';
  }
  if (passcode.length < 6) {
    return RegExp(r'^\d*$').hasMatch(passcode)
        ? 'Use at least 6 digits.'
        : 'Use at least 6 characters.';
  }
  return null;
}

bool isNumericPasscode(String passcode) => RegExp(r'^\d+$').hasMatch(passcode);
