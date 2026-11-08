import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'prefs.dart';

/// The background mesh's "last alive" timestamp, in a tiny file of its own.
///
/// It used to be a SharedPreferences key written on every registration — at
/// least once a minute, around the clock. SharedPreferences backends rewrite
/// the whole store on every set (one XML file on Android, one JSON file on
/// Windows), so each heartbeat rewrote every setting too (#1060, #1063). A
/// 13-byte file costs nothing to rewrite. Both isolates resolve the same
/// app-support directory, so the UI still reads what the service writes.
///
/// When no directory is available (tests, an exotic embedder) it falls back
/// to the old prefs key, so behaviour degrades to exactly what it was.
class MeshLiveness {
  MeshLiveness._();

  static const _fileName = 'mesh_alive.v1';
  static Future<File?>? _file;

  static Future<File?> _resolve() => _file ??= () async {
        try {
          final dir = await getApplicationSupportDirectory();
          return File('${dir.path}${Platform.pathSeparator}$_fileName');
        } catch (_) {
          return null;
        }
      }();

  /// Record that the mesh is alive at [epochMs].
  static Future<void> stamp(Prefs prefs, int epochMs) async {
    final file = await _resolve();
    if (file == null) return prefs.setMeshBgAliveAt(epochMs);
    try {
      await file.writeAsString('$epochMs');
    } catch (_) {
      await prefs.setMeshBgAliveAt(epochMs);
    }
  }

  /// The last stamp, or the legacy prefs value when no file exists yet (the
  /// first minute after upgrading from a build that used prefs).
  static Future<int?> read(Prefs prefs) async {
    final file = await _resolve();
    if (file != null) {
      try {
        if (await file.exists()) {
          final ms = int.tryParse((await file.readAsString()).trim());
          if (ms != null) return ms;
        }
      } catch (_) {
        // fall through to the legacy value
      }
    }
    return prefs.meshBgAliveAt;
  }
}
