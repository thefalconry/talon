import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';

import '../../services/log.dart';
import '../../services/private_store.dart';

/// Small string key/value store for app-lock secrets (the lock record, the
/// biometric copy of the data key). An interface so tests run in memory.
abstract class SecretStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

/// The platform secure store — Android Keystore, Apple Keychain, Windows
/// DPAPI / Credential Manager, Linux Secret Service — via
/// `flutter_secure_storage`.
///
/// Namespaced (`talon.applock.*` keys, and on Android its own storage
/// namespace) so it can share the package with the bridge credential store
/// (#1068 follow-up) without either touching the other's entries.
class PlatformSecretStore implements SecretStore {
  PlatformSecretStore({FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage(aOptions: android, mOptions: macos);

  static const String keyPrefix = 'talon.applock.';

  static const AndroidOptions android = AndroidOptions(
    storageNamespace: 'talon_applock',
    // Never silently wipe on a keystore hiccup: the lock record would vanish
    // and with it the lock. A read error surfaces instead, and the lock
    // screen's reset path (which also drops the connection) is the way out.
    resetOnError: false,
  );

  /// The file-based login keychain: the data-protection keychain needs a
  /// keychain-access-groups entitlement, which an ad-hoc signed build can't
  /// carry.
  static const MacOsOptions macos = MacOsOptions(
    accountName: 'org.talon.companion.applock',
    usesDataProtectionKeychain: false,
  );

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: '$keyPrefix$key');

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: '$keyPrefix$key', value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: '$keyPrefix$key');
}

/// A JSON file readable by this user only — the Linux fallback when no
/// Secret Service is running (a bare window manager, some kiosks). The lock
/// record holds nothing that unlocks anything without the passcode (a salted
/// Argon2id verifier and a key wrapped under a passcode-derived key), so a
/// 0600 file in the 0700 support directory keeps the same guarantee, minus
/// the keyring's at-rest encryption.
class FileSecretStore implements SecretStore {
  FileSecretStore({Future<String> Function()? dir}) : _dir = dir ?? _supportDir;

  static const String fileName = PrivateStore.appLockFileName;

  final Future<String> Function() _dir;

  static Future<String> _supportDir() async =>
      (await getApplicationSupportDirectory()).path;

  Future<File> _file() async => File('${await _dir()}/$fileName');

  Future<Map<String, String>> _readAll() async {
    final file = await _file();
    if (!await file.exists()) return {};
    try {
      final decoded = jsonDecode(await file.readAsString());
      if (decoded is! Map) return {};
      return decoded.map((k, v) => MapEntry('$k', '$v'));
    } catch (_) {
      return {};
    }
  }

  Future<void> _writeAll(Map<String, String> values) async {
    final path = (await _file()).path;
    final contents = jsonEncode(values);
    // 0600 before any content lands, 0700 directory (PrivateStore), written
    // off the UI isolate like the snapshot files.
    await _writePrivateInBackground(path, contents);
  }

  @override
  Future<String?> read(String key) async => (await _readAll())[key];

  @override
  Future<void> write(String key, String value) async {
    final all = await _readAll();
    all[key] = value;
    await _writeAll(all);
  }

  @override
  Future<void> delete(String key) async {
    final all = await _readAll();
    if (all.remove(key) == null) return;
    if (all.isEmpty) {
      final file = await _file();
      if (await file.exists()) await file.delete();
      return;
    }
    await _writeAll(all);
  }
}

/// Uses [primary] and falls back to [fallback] when it throws (Linux without
/// a Secret Service). Reads consult both, so a value written to either is
/// found; writes land in the first store that accepts them and clear the
/// other, so a stale copy can't shadow the fresh one.
class FallbackSecretStore implements SecretStore {
  FallbackSecretStore(this.primary, this.fallback);

  final SecretStore primary;
  final SecretStore fallback;

  @override
  Future<String?> read(String key) async {
    try {
      final v = await primary.read(key);
      if (v != null) return v;
    } catch (e) {
      AppLog.debug('app_lock', 'secure store read failed; using file', e);
    }
    return fallback.read(key);
  }

  @override
  Future<void> write(String key, String value) async {
    try {
      await primary.write(key, value);
      await _quietly(() => fallback.delete(key));
      return;
    } catch (e) {
      AppLog.warn('app_lock', 'secure store unavailable; using private file', e);
    }
    await fallback.write(key, value);
  }

  @override
  Future<void> delete(String key) async {
    await _quietly(() => primary.delete(key));
    await fallback.delete(key);
  }

  static Future<void> _quietly(Future<void> Function() op) async {
    try {
      await op();
    } catch (_) {
      // Best effort: the other store is authoritative for this operation.
    }
  }
}

class MemorySecretStore implements SecretStore {
  final Map<String, String> values = {};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

/// Where the encrypted chat snapshot lives while app lock is on.
abstract class SealedSnapshotStore {
  Future<String?> read();
  Future<void> write(String sealed);
  Future<void> delete();
}

/// `chat_snapshot.sealed.v1` in the app support directory, replaced
/// atomically (temp file + rename) so a crash never leaves half a snapshot.
/// Android's backup rules already exclude the whole data directory (#1066).
class FileSealedSnapshotStore implements SealedSnapshotStore {
  FileSealedSnapshotStore({Future<String> Function()? dir})
      : _dir = dir ?? FileSecretStore._supportDir;

  static const String fileName = PrivateStore.sealedSnapshotFileName;

  final Future<String> Function() _dir;

  Future<File> _file() async => File('${await _dir()}/$fileName');

  @override
  Future<String?> read() async {
    final file = await _file();
    if (!await file.exists()) return null;
    return file.readAsString();
  }

  @override
  Future<void> write(String sealed) async {
    final path = (await _file()).path;
    // Same writer as the plaintext snapshot file (Prefs.saveSnapshot): off
    // the UI isolate, atomic, and 0600 on Linux before any byte is written.
    await _writePrivateInBackground(path, sealed);
  }

  @override
  Future<void> delete() async {
    final file = await _file();
    if (await file.exists()) await file.delete();
  }
}

class MemorySealedSnapshotStore implements SealedSnapshotStore {
  String? value;

  @override
  Future<String?> read() async => value;

  @override
  Future<void> write(String sealed) async {
    value = sealed;
  }

  @override
  Future<void> delete() async {
    value = null;
  }
}

/// Top-level so the isolate closure captures only [path] and [contents].
Future<void> _writePrivateInBackground(String path, String contents) =>
    Isolate.run(
      () => PrivateStore.writeFileSync(path, contents),
      debugName: 'private-write',
    );
