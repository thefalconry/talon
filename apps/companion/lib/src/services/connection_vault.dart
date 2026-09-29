import 'dart:async';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Where the connection profile's secrets live: the bridge token (the shared
/// token, or this device's per-device credential once upgraded), and an
/// imported client certificate with its password. One JSON blob under one
/// key, so a profile's secrets always change together.
///
/// An interface so tests run in memory. [Prefs] owns the blob's shape and
/// the fallback to the settings file when a vault throws.
abstract class ConnectionVault {
  Future<String?> read();
  Future<void> write(String blob);
  Future<void> delete();
}

/// The platform keystore — Android Keystore, Apple Keychain, Windows
/// Credential Manager + DPAPI, Linux Secret Service — via
/// `flutter_secure_storage`.
///
/// Namespaced away from the app lock's entries (`talon_applock`). On Android
/// the store is backed by process-wide SharedPreferences, so the mesh
/// foreground-service isolate (its own engine, same process) reads what the
/// UI isolate wrote.
class PlatformConnectionVault implements ConnectionVault {
  PlatformConnectionVault({FlutterSecureStorage? storage})
      : _storage = storage ??
            const FlutterSecureStorage(aOptions: android, mOptions: macos);

  static const String key = 'talon.bridge.secrets.v1';

  static const AndroidOptions android = AndroidOptions(
    storageNamespace: 'talon_bridge',
    // A keystore hiccup must not silently wipe the token: the read fails,
    // Prefs logs it and falls back, and the next write replaces the entry.
    resetOnError: false,
  );

  /// The file-based login keychain, as for the app lock: the
  /// data-protection keychain needs an entitlement an ad-hoc signed build
  /// can't carry.
  static const MacOsOptions macos = MacOsOptions(
    accountName: 'org.talon.companion.bridge',
    usesDataProtectionKeychain: false,
  );

  /// A locked Linux keyring asks the user to unlock it, and the read waits
  /// for the answer; past this the settings file is used for this load.
  static const Duration _readTimeout = Duration(seconds: 20);

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read() => _storage.read(key: key).timeout(_readTimeout);

  @override
  Future<void> write(String blob) => _storage.write(key: key, value: blob);

  @override
  Future<void> delete() => _storage.delete(key: key);
}

/// In-memory vault for tests. [failing] makes every call throw, like a Linux
/// desktop without a Secret Service.
class MemoryConnectionVault implements ConnectionVault {
  MemoryConnectionVault({this.failing = false});

  bool failing;
  String? blob;

  void _check() {
    if (failing) throw StateError('secure storage unavailable');
  }

  @override
  Future<String?> read() async {
    _check();
    return blob;
  }

  @override
  Future<void> write(String blob) async {
    _check();
    this.blob = blob;
  }

  @override
  Future<void> delete() async {
    _check();
    blob = null;
  }
}
