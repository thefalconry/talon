import 'dart:convert';
import 'dart:io' show Platform;

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:local_auth/local_auth.dart';

import '../../services/log.dart';
import 'secret_store.dart';

/// Releases the chat-snapshot data key through the platform's own user
/// authentication, as an alternative to typing the passcode.
///
/// The passcode is always the fallback: this is only ever an extra way in.
abstract class BiometricUnlocker {
  const BiometricUnlocker();

  /// Whether this device can offer it at all right now (hardware present and
  /// something enrolled). Cheap; called when Settings or the lock screen opens.
  Future<bool> isAvailable();

  /// Short name for the UI: "Fingerprint / face", "Touch ID", "Windows Hello".
  String get label;

  /// Keep a copy of [dataKey] behind the platform's authentication gate. May
  /// prompt. Returns false if the user cancelled or the platform refused.
  Future<bool> enroll(Uint8List dataKey, {required String reason});

  /// Prompt, and hand back the data key on success; null when cancelled,
  /// failed, or the enrolled key is gone (e.g. biometrics changed).
  Future<Uint8List?> unlock({required String reason});

  /// Forget the enrolled copy.
  Future<void> clear();
}

/// For platforms without biometrics (Linux) and for tests.
class NoBiometrics extends BiometricUnlocker {
  const NoBiometrics();

  @override
  Future<bool> isAvailable() async => false;

  @override
  String get label => 'Biometrics';

  @override
  Future<bool> enroll(Uint8List dataKey, {required String reason}) async =>
      false;

  @override
  Future<Uint8List?> unlock({required String reason}) async => null;

  @override
  Future<void> clear() async {}
}

/// The real thing, per platform:
///
///   * **Android 9+** — the data key sits in `flutter_secure_storage`'s
///     biometric namespace: an Android Keystore key created with
///     `setUserAuthenticationRequired(true)`, unwrapped only inside a
///     BiometricPrompt (fingerprint, face, or the device PIN). The plugin
///     keeps that store open for the rest of the process once unwrapped, so
///     every later unlock in the same process is confirmed with a fresh
///     `local_auth` prompt first — there is never an unlock without one. A
///     new fingerprint invalidates the key; unlock then falls back to the
///     passcode and biometrics can be re-enabled.
///   * **macOS / Windows** — `local_auth` (Touch ID, Windows Hello) confirms
///     the user, then the key is read from the ordinary secure store (login
///     keychain / DPAPI). The keychain item can't carry a user-presence
///     access control on an ad-hoc signed build, so this is a UI gate over an
///     OS-protected store rather than a hardware-bound key.
///   * **Linux** — not offered (no platform biometric API); passcode only.
class PlatformBiometrics extends BiometricUnlocker {
  PlatformBiometrics({
    LocalAuthentication? localAuth,
    SecretStore? store,
    FlutterSecureStorage? androidStore,
  })  : _auth = localAuth ?? LocalAuthentication(),
        _store = store ?? PlatformSecretStore(),
        _androidStore = androidStore ?? const FlutterSecureStorage(aOptions: _androidBio);

  final LocalAuthentication _auth;
  final SecretStore _store;
  final FlutterSecureStorage _androidStore;

  static const String _key = 'biometricDataKey.v1';

  /// Android: the auth-bound store has been unwrapped in this process, so
  /// the plugin won't prompt again on its own — ask local_auth instead.
  bool _androidStoreOpen = false;

  static const AndroidOptions _androidBio = AndroidOptions.biometric(
    storageNamespace: 'talon_applock_bio',
    enforceBiometrics: true,
    resetOnError: false,
    biometricPromptTitle: 'Unlock Talon',
    biometricPromptNegativeButton: 'Use passcode',
  );

  static bool get _android => !kIsWeb && Platform.isAndroid;
  static bool get _supportedPlatform =>
      !kIsWeb &&
      (Platform.isAndroid ||
          Platform.isIOS ||
          Platform.isMacOS ||
          Platform.isWindows);

  @override
  String get label {
    if (kIsWeb) return 'Biometrics';
    if (Platform.isMacOS) return 'Touch ID';
    if (Platform.isWindows) return 'Windows Hello';
    if (Platform.isIOS) return 'Face ID / Touch ID';
    return 'Fingerprint or face';
  }

  @override
  Future<bool> isAvailable() async {
    if (!_supportedPlatform) return false;
    try {
      if (_android) {
        // The Keystore-bound path needs BiometricPrompt's crypto object
        // support, i.e. Android 9.
        final info = await DeviceInfoPlugin().androidInfo;
        if (info.version.sdkInt < 28) return false;
      }
      if (!await _auth.isDeviceSupported()) return false;
      if (Platform.isWindows) return true; // Hello: PIN counts
      return await _auth.canCheckBiometrics;
    } catch (e) {
      AppLog.debug('app_lock', 'biometric availability check failed', e);
      return false;
    }
  }

  @override
  Future<bool> enroll(Uint8List dataKey, {required String reason}) async {
    final encoded = base64Encode(dataKey);
    try {
      if (_android) {
        // The first touch of the auth-bound store prompts by itself; after
        // that the plugin holds it open, so confirm the user explicitly.
        if (_androidStoreOpen && !await _authenticate(reason)) return false;
        await _androidStore.write(key: _key, value: encoded);
        _androidStoreOpen = true;
        return true;
      }
      if (!await _authenticate(reason)) return false;
      await _store.write(_key, encoded);
      return true;
    } catch (e) {
      AppLog.warn('app_lock', 'biometric enrolment failed', e);
      return false;
    }
  }

  @override
  Future<Uint8List?> unlock({required String reason}) async {
    try {
      final String? encoded;
      if (_android) {
        if (_androidStoreOpen && !await _authenticate(reason)) return null;
        encoded = await _androidStore.read(key: _key);
        _androidStoreOpen = true;
      } else {
        if (!await _authenticate(reason)) return null;
        encoded = await _store.read(_key);
      }
      return encoded == null ? null : base64Decode(encoded);
    } catch (e) {
      // Cancelled, locked out, or the key was invalidated by a biometric
      // change — all of which mean "use the passcode".
      AppLog.info('app_lock', 'biometric unlock unavailable: $e');
      return null;
    }
  }

  @override
  Future<void> clear() async {
    try {
      if (_android) {
        await _androidStore.delete(key: _key);
      } else {
        await _store.delete(_key);
      }
    } catch (e) {
      AppLog.debug('app_lock', 'biometric key clear failed', e);
    }
  }

  Future<bool> _authenticate(String reason) => _auth.authenticate(
        localizedReason: reason,
        // The OS may fall back to the device password: still the owner.
        biometricOnly: false,
        persistAcrossBackgrounding: true,
      );
}
