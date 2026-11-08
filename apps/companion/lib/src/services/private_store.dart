import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import 'log.dart';

/// Keeps the settings store readable by this OS user only (Linux).
///
/// `shared_preferences` on Linux writes `shared_preferences.json` under the
/// app's support directory (`~/.local/share/<app id>/`) with a plain file
/// write, i.e. mode `0666 & ~umask` — typically 0644 — in a directory that
/// is typically 0755. That file holds the bridge token, and the chat
/// snapshot file beside it recent chats, so on a machine with other local
/// users (and a home directory they can traverse) they were readable by
/// them. This narrows the directory to 0700 and the files to 0600, matching
/// how talon-node stores its own config.
///
/// macOS (`~/Library/Preferences`) and Windows (`%APPDATA%`) already sit
/// under per-user permissions, so this is a no-op there. Android keeps app
/// data in its private sandbox.
class PrivateStore {
  PrivateStore({
    Future<String> Function()? supportDir,
    bool Function()? applies,
  })  : _supportDir = supportDir ?? _defaultSupportDir,
        _applies = applies ?? _isLinux;

  final Future<String> Function() _supportDir;
  final bool Function() _applies;

  /// File name `shared_preferences_linux` uses inside the support directory.
  static const prefsFileName = 'shared_preferences.json';

  /// The offline chat snapshot, kept beside the settings file (see
  /// `Prefs.saveSnapshot`). Holds recent chats, so it gets the same mode.
  static const snapshotFileName = 'chat_snapshot.v1.json';

  /// The app lock's sealed (AES-256-GCM) snapshot, which replaces the
  /// plaintext one while the lock is on (see `FileSealedSnapshotStore`).
  static const sealedSnapshotFileName = 'chat_snapshot.sealed.v1';

  /// The app lock record's file fallback on Linux without a Secret Service
  /// (see `FileSecretStore`).
  static const appLockFileName = 'app_lock.v1.json';

  /// The on-device mesh command audit (see `MeshAudit`). Names the paths
  /// the daemon touched here, so it is kept as private as the rest.
  static const meshAuditFileName = 'mesh_audit.v1.jsonl';

  /// Every file in the support directory that must be this user's alone.
  static const privateFileNames = [
    prefsFileName,
    snapshotFileName,
    sealedSnapshotFileName,
    appLockFileName,
    meshAuditFileName,
  ];

  static bool _isLinux() => !kIsWeb && Platform.isLinux;

  static Future<String> _defaultSupportDir() async =>
      (await getApplicationSupportDirectory()).path;

  /// Create the support directory if needed and restrict it (0700) and the
  /// settings file inside it (0600). Never throws: failing to tighten
  /// permissions is logged, not fatal — the app must still start.
  Future<void> harden() async {
    if (!_applies()) return;
    try {
      final dir = Directory(await _supportDir());
      // Created here (before shared_preferences' first write) so that it
      // never exists with a wider mode than the one set below.
      await dir.create(recursive: true);
      await _chmod('700', dir.path);
      for (final name in privateFileNames) {
        final file = File('${dir.path}/$name');
        if (await file.exists()) await _chmod('600', file.path);
      }
    } catch (e) {
      AppLog.warn('prefs', 'could not restrict settings file permissions', e);
    }
  }

  // Synchronous variants for writers running off the UI isolate (the
  // snapshot writer), where there is no PrivateStore instance. They throw on
  // failure so a caller never goes on to write private data into a file it
  // could not restrict. No-ops off Linux.

  /// Create [path] (recursively) if missing; a directory created here is
  /// narrowed to 0700 straight away.
  static void ensurePrivateDirSync(String path) {
    final dir = Directory(path);
    if (dir.existsSync()) return;
    dir.createSync(recursive: true);
    if (_isLinux()) _chmodSync('700', path);
  }

  /// Narrow an existing file to 0600.
  static void restrictFileSync(String path) {
    if (_isLinux()) _chmodSync('600', path);
  }

  /// Replace the file at [path] with [contents] atomically (temp file +
  /// rename), so a crash mid-write never leaves a truncated file behind. On
  /// Linux the temp file is narrowed to 0600 before any content is written,
  /// and the rename carries that mode over to the file itself.
  static void writeFileSync(String path, String contents) {
    final tmp = File('$path.tmp');
    ensurePrivateDirSync(tmp.parent.path);
    tmp.writeAsStringSync('', flush: true);
    restrictFileSync(tmp.path);
    tmp.writeAsStringSync(contents, flush: true);
    tmp.renameSync(path);
  }

  static void _chmodSync(String mode, String path) {
    final result = Process.runSync('chmod', [mode, path]);
    if (result.exitCode != 0) {
      throw FileSystemException('chmod $mode failed: ${result.stderr}', path);
    }
  }

  static Future<void> _chmod(String mode, String path) async {
    final result = await Process.run('chmod', [mode, path]);
    if (result.exitCode != 0) {
      throw FileSystemException('chmod $mode failed: ${result.stderr}', path);
    }
  }
}
