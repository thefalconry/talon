import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:path_provider/path_provider.dart';

import '../models/credentials.dart';
import 'log.dart';
import 'private_store.dart';

/// One mesh command this device ran, as the on-device audit records it.
///
/// It names what was touched — a path, or for `exec` the SHA-256 of the
/// command line — and never content: no file bytes, no command text, no
/// credential secret.
class MeshAuditEntry {
  const MeshAuditEntry({
    required this.ts,
    required this.commandId,
    required this.name,
    required this.ok,
    required this.durationMs,
    required this.credential,
    required this.tier,
    this.target,
    this.error,
  });

  /// Completion time, epoch milliseconds.
  final int ts;
  final String commandId;
  final String name;
  final String? target;
  final bool ok;
  final String? error;
  final int durationMs;

  /// `device:<credential id>`, `shared`, or `none` (see
  /// [MeshAudit.credentialKind]).
  final String credential;

  /// Where it ran: `root`, `shizuku`, or `app`.
  final String tier;

  Map<String, dynamic> toJson() => {
        'ts': ts,
        'commandId': commandId,
        'name': name,
        if (target != null) 'target': target,
        'ok': ok,
        if (error != null) 'error': error,
        'durationMs': durationMs,
        'credential': credential,
        'tier': tier,
      };

  static MeshAuditEntry? fromJson(Object? j) {
    if (j is! Map) return null;
    final name = j['name'];
    final ts = j['ts'];
    if (name is! String || name.isEmpty || ts is! int) return null;
    String? str(String k) => j[k] is String ? j[k] as String : null;
    return MeshAuditEntry(
      ts: ts,
      commandId: str('commandId') ?? '',
      name: name,
      target: str('target'),
      ok: j['ok'] == true,
      error: str('error'),
      durationMs: j['durationMs'] is int ? j['durationMs'] as int : 0,
      credential: str('credential') ?? 'none',
      tier: str('tier') ?? 'app',
    );
  }
}

/// On-device audit of the mesh commands this companion ran (#1057 §5).
///
/// A bounded ring of JSON lines in the app-support directory, so the
/// background mesh isolate (which runs the commands on Android) and the UI
/// isolate (Settings → Mesh) read and write the same file. It keeps the
/// newest [keep] entries, compacting once the file reaches twice that, and
/// is narrowed to 0600 on Linux like the other private files.
///
/// Recording is best effort by contract: [record] never throws, and callers
/// fire it after the command's result is posted, so the audit can neither
/// delay nor fail a command.
class MeshAudit {
  MeshAudit({Future<File?> Function()? file, this.keep = defaultKeep})
      : _resolveFile = file ?? _defaultFile;

  static const fileName = PrivateStore.meshAuditFileName;
  static const defaultKeep = 500;

  /// Caps on free-text fields, so one odd command can't bloat the ring.
  static const maxTarget = 512;
  static const maxError = 200;

  final int keep;
  final Future<File?> Function() _resolveFile;
  Future<File?>? _file;

  /// Lines in the file; null until first counted.
  int? _lines;

  /// Serializes appends and compactions within this isolate.
  Future<void> _tail = Future.value();

  static Future<File?> _defaultFile() async {
    try {
      final dir = await getApplicationSupportDirectory();
      return File('${dir.path}${Platform.pathSeparator}$fileName');
    } catch (_) {
      return null; // tests, exotic embedders: no audit file
    }
  }

  Future<File?> _fileOnce() => _file ??= _resolveFile().catchError((_) => null);

  /// Append [entry]. Never throws.
  Future<void> record(MeshAuditEntry entry) {
    final next = _tail.then((_) => _append(entry)).catchError((Object e) {
      AppLog.debug('mesh', 'audit record failed', e);
    });
    _tail = next;
    return next;
  }

  Future<void> _append(MeshAuditEntry entry) async {
    final file = await _fileOnce();
    if (file == null) return;
    if (!await file.exists()) {
      PrivateStore.ensurePrivateDirSync(file.parent.path);
      await file.writeAsString('', flush: true);
      PrivateStore.restrictFileSync(file.path);
      _lines = 0;
    }
    _lines ??= (await _readLines(file)).length;
    await file.writeAsString(
      '${jsonEncode(entry.toJson())}\n',
      mode: FileMode.append,
      flush: true,
    );
    _lines = _lines! + 1;
    if (_lines! >= 2 * keep) await _compact(file);
  }

  Future<void> _compact(File file) async {
    var lines = await _readLines(file);
    if (lines.length > keep) lines = lines.sublist(lines.length - keep);
    PrivateStore.writeFileSync(file.path, lines.map((l) => '$l\n').join());
    _lines = lines.length;
  }

  static Future<List<String>> _readLines(File file) async {
    if (!await file.exists()) return const [];
    return (await file.readAsLines())
        .where((l) => l.trim().isNotEmpty)
        .toList();
  }

  /// The newest [limit] entries (all when null), newest first. Never throws;
  /// an unreadable file reads as empty.
  Future<List<MeshAuditEntry>> read({int? limit}) async {
    try {
      final file = await _fileOnce();
      if (file == null) return const [];
      final out = <MeshAuditEntry>[];
      for (final line in (await _readLines(file)).reversed) {
        MeshAuditEntry? e;
        try {
          e = MeshAuditEntry.fromJson(jsonDecode(line));
        } catch (_) {
          e = null; // a torn or foreign line: skip it
        }
        if (e != null) out.add(e);
        if (limit != null && out.length >= limit) break;
      }
      return out;
    } catch (e) {
      AppLog.debug('mesh', 'audit read failed', e);
      return const [];
    }
  }

  /// Delete every entry. Never throws.
  Future<void> clear() {
    final next = _tail.then((_) async {
      final file = await _fileOnce();
      if (file != null && await file.exists()) await file.delete();
      _lines = 0;
    }).catchError((Object e) {
      AppLog.warn('mesh', 'audit clear failed', e);
    });
    _tail = next;
    return next;
  }

  /// Build the entry for one finished command.
  static MeshAuditEntry entryFor({
    required String commandId,
    required String name,
    required Map<String, dynamic> params,
    required bool ok,
    required String? message,
    required Map<String, dynamic>? data,
    required Duration elapsed,
    required String? token,
    int? now,
  }) {
    final target = targetFor(name, params);
    final via = data?['via'];
    return MeshAuditEntry(
      ts: now ?? DateTime.now().millisecondsSinceEpoch,
      commandId: commandId,
      name: name,
      target: target == null ? null : _clip(target, maxTarget),
      ok: ok,
      error: ok ? null : _clip(message ?? 'failed', maxError),
      durationMs: elapsed.inMilliseconds,
      credential: credentialKind(token),
      tier: via is String && via.isNotEmpty ? via : 'app',
    );
  }

  /// What a command touched, without its content: the path(s) of a
  /// filesystem command, or only the SHA-256 of an `exec` command line
  /// (which can carry secrets) so it can still be matched against the
  /// daemon's own log.
  static String? targetFor(String name, Map<String, dynamic> params) {
    String? str(String k) {
      final v = params[k];
      return v is String && v.isNotEmpty ? v : null;
    }

    switch (name) {
      case 'exec':
        final cmd = str('cmd');
        return cmd == null
            ? null
            : 'sha256:${sha256.convert(utf8.encode(cmd))}';
      case 'move':
        final from = str('from');
        final to = str('to');
        return from == null && to == null
            ? null
            : '${from ?? ''} -> ${to ?? ''}';
      default:
        return str('path');
    }
  }

  /// The bearer this device was using, never the secret.
  static String credentialKind(String? token) {
    if (token == null || token.isEmpty) return 'none';
    if (isDeviceCredential(token)) return 'device:${token.split('.')[1]}';
    return 'shared';
  }

  static String _clip(String s, int max) {
    final flat = s.trim().replaceAll('\n', ' ');
    final runes = flat.runes;
    if (runes.length <= max) return flat;
    return '${String.fromCharCodes(runes.take(max))}…';
  }
}
