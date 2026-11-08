import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:archive/archive_io.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'log.dart';

/// How a model artifact is packaged.
enum ModelPackaging {
  /// A single file, stored as-is.
  file,

  /// A `.tar.bz2` archive, unpacked into the model directory.
  tarBz2,
}

/// One downloadable on-device model, pinned to an exact artifact.
///
/// Generic on purpose: the Kokoro voice is the first user, an optional
/// speech-recognition model is expected to reuse the same manager. Every field
/// that identifies the bytes (URL, size, SHA-256) is fixed at build time; a
/// changed upstream artifact fails verification instead of being trusted.
@immutable
class ModelSpec {
  /// Stable directory name under the models root, e.g.
  /// `kokoro-int8-multi-lang-v1_0`. Bump it (not the URL alone) when the
  /// artifact changes, so an old install is never mistaken for the new one.
  final String id;

  /// Human label for settings ("Kokoro voice").
  final String label;
  final Uri url;

  /// Lower-case hex SHA-256 of the downloaded artifact.
  final String sha256;

  /// Exact artifact size in bytes (progress + a cheap early sanity check).
  final int sizeBytes;
  final ModelPackaging packaging;

  /// For archives: the single top-level directory inside it whose contents
  /// become the model directory. Null to use the archive root as-is.
  final String? archiveRoot;

  /// For [ModelPackaging.file]: the file name to store it under.
  final String? fileName;

  /// Paths (relative to the model directory) that must exist for the install
  /// to count as complete.
  final List<String> requiredFiles;

  const ModelSpec({
    required this.id,
    required this.label,
    required this.url,
    required this.sha256,
    required this.sizeBytes,
    required this.packaging,
    this.archiveRoot,
    this.fileName,
    this.requiredFiles = const [],
  });
}

enum ModelPhase {
  /// Not on the device (a resumable partial download may exist).
  absent,
  downloading,
  verifying,
  extracting,
  installed,

  /// The last attempt failed; [ModelStatus.error] says why.
  failed,
}

@immutable
class ModelStatus {
  final ModelPhase phase;
  final int receivedBytes;
  final int totalBytes;
  final String? error;

  const ModelStatus(
    this.phase, {
    this.receivedBytes = 0,
    this.totalBytes = 0,
    this.error,
  });

  static const absent = ModelStatus(ModelPhase.absent);

  bool get installed => phase == ModelPhase.installed;
  bool get busy =>
      phase == ModelPhase.downloading ||
      phase == ModelPhase.verifying ||
      phase == ModelPhase.extracting;

  /// 0..1 while downloading, null when unknown/not applicable.
  double? get progress =>
      totalBytes > 0 ? (receivedBytes / totalBytes).clamp(0.0, 1.0) : null;

  @override
  String toString() => 'ModelStatus($phase, $receivedBytes/$totalBytes'
      '${error == null ? '' : ', $error'})';
}

/// Unpacks a verified artifact into a directory. Injectable so tests can run
/// without real archives.
typedef ModelUnpacker = Future<void> Function(
  ModelSpec spec,
  File artifact,
  Directory destination,
);

/// Thrown (and reported in [ModelStatus.error]) for a failed install step.
class ModelInstallException implements Exception {
  final String message;
  const ModelInstallException(this.message);
  @override
  String toString() => message;
}

/// Downloads, verifies, unpacks, tracks and deletes on-device models.
///
/// Layout under [root] (the app's private files on Android):
///   `<id>/`                  the installed model + `.talon-model.json`
///   `<id>.download`          an in-progress / resumable download
///   `<id>.staging/`          unpack target, renamed into place when complete
///
/// An install is only ever visible once it is complete: the artifact must
/// match the pinned SHA-256, unpack fully, contain every required file, and
/// the final directory appears with a single rename.
class ModelManager extends ChangeNotifier {
  ModelManager({
    required Future<Directory> Function() root,
    http.Client Function()? httpClient,
    ModelUnpacker? unpacker,
    Duration progressInterval = const Duration(milliseconds: 200),
  })  : _root = root,
        _httpClient = httpClient ?? http.Client.new,
        _unpack = unpacker ?? unpackInIsolate,
        _progressInterval = progressInterval;

  /// The app-wide instance, storing models under the app-support directory
  /// (`Context.getFilesDir()` on Android — private, and excluded from
  /// backups by the manifest).
  static final ModelManager instance = ModelManager(
    root: () async => Directory(
      p.join((await getApplicationSupportDirectory()).path, 'models'),
    ),
  );

  static const _marker = '.talon-model.json';

  final Future<Directory> Function() _root;
  final http.Client Function() _httpClient;
  final ModelUnpacker _unpack;
  final Duration _progressInterval;

  final Map<String, ModelStatus> _status = {};
  final Map<String, Future<bool>> _inFlight = {};
  final Map<String, _Cancel> _cancels = {};

  ModelStatus status(ModelSpec spec) => _status[spec.id] ?? ModelStatus.absent;

  Future<Directory> _dir(ModelSpec spec) async =>
      Directory(p.join((await _root()).path, spec.id));
  Future<File> _download(ModelSpec spec) async =>
      File(p.join((await _root()).path, '${spec.id}.download'));
  Future<Directory> _staging(ModelSpec spec) async =>
      Directory(p.join((await _root()).path, '${spec.id}.staging'));

  void _set(ModelSpec spec, ModelStatus status) {
    _status[spec.id] = status;
    notifyListeners();
  }

  /// Re-read the on-disk state (call once before showing settings). Does not
  /// disturb an install that is in progress.
  Future<ModelStatus> refresh(ModelSpec spec) async {
    if (_inFlight.containsKey(spec.id)) return status(spec);
    if (await installedPath(spec) != null) {
      _set(spec, ModelStatus(
        ModelPhase.installed,
        receivedBytes: spec.sizeBytes,
        totalBytes: spec.sizeBytes,
      ));
    } else {
      final partial = await _download(spec);
      final have = await partial.exists() ? await partial.length() : 0;
      final previous = status(spec);
      _set(spec, ModelStatus(
        previous.phase == ModelPhase.failed
            ? ModelPhase.failed
            : ModelPhase.absent,
        receivedBytes: have,
        totalBytes: spec.sizeBytes,
        error: previous.error,
      ));
    }
    return status(spec);
  }

  /// The model directory when a complete, verified install is present.
  Future<String?> installedPath(ModelSpec spec) async {
    final dir = await _dir(spec);
    final marker = File(p.join(dir.path, _marker));
    if (!await marker.exists()) return null;
    try {
      final meta = jsonDecode(await marker.readAsString());
      if (meta is! Map || meta['sha256'] != spec.sha256) return null;
    } catch (_) {
      return null;
    }
    for (final rel in spec.requiredFiles) {
      if (!await File(p.join(dir.path, rel)).exists()) return null;
    }
    return dir.path;
  }

  /// Download, verify and unpack [spec]. Resolves true once installed.
  ///
  /// Idempotent: an existing install resolves immediately without touching
  /// the network, and a second call while one is running joins it. A partial
  /// download left by an interrupted attempt is resumed with an HTTP range
  /// request when the server supports it.
  Future<bool> install(ModelSpec spec) {
    return _inFlight[spec.id] ??= _install(spec).whenComplete(() {
      _inFlight.remove(spec.id);
      _cancels.remove(spec.id);
    });
  }

  /// Stop an in-progress install. The partial download is kept so a later
  /// [install] resumes it; [delete] discards it.
  void cancel(ModelSpec spec) => _cancels[spec.id]?.cancel();

  /// Remove the model and any partial download or staging leftovers.
  Future<void> delete(ModelSpec spec) async {
    cancel(spec);
    final running = _inFlight[spec.id];
    if (running != null) await running;
    for (final entity in [
      await _dir(spec),
      await _staging(spec),
      await _download(spec),
    ]) {
      if (await entity.exists()) await entity.delete(recursive: true);
    }
    _set(spec, ModelStatus.absent);
  }

  Future<bool> _install(ModelSpec spec) async {
    if (await installedPath(spec) != null) {
      _set(spec, ModelStatus(
        ModelPhase.installed,
        receivedBytes: spec.sizeBytes,
        totalBytes: spec.sizeBytes,
      ));
      return true;
    }
    final cancel = _cancels[spec.id] = _Cancel();
    final artifact = await _download(spec);
    try {
      await artifact.parent.create(recursive: true);
      await _fetch(spec, artifact, cancel);

      _set(spec, ModelStatus(
        ModelPhase.verifying,
        receivedBytes: spec.sizeBytes,
        totalBytes: spec.sizeBytes,
      ));
      final digest = await _sha256(artifact);
      if (digest != spec.sha256) {
        // A wrong artifact is never resumed from: start clean next time.
        await artifact.delete();
        throw ModelInstallException(
          'Checksum mismatch (expected ${spec.sha256}, got $digest)',
        );
      }
      cancel.check();

      _set(spec, ModelStatus(
        ModelPhase.extracting,
        receivedBytes: spec.sizeBytes,
        totalBytes: spec.sizeBytes,
      ));
      final staging = await _staging(spec);
      if (await staging.exists()) await staging.delete(recursive: true);
      await staging.create(recursive: true);
      await _unpack(spec, artifact, staging);
      cancel.check();

      final unpacked = spec.archiveRoot == null
          ? staging
          : Directory(p.join(staging.path, spec.archiveRoot));
      for (final rel in spec.requiredFiles) {
        if (!await File(p.join(unpacked.path, rel)).exists()) {
          throw ModelInstallException('Model is missing $rel');
        }
      }
      await File(p.join(unpacked.path, _marker)).writeAsString(
        jsonEncode({
          'id': spec.id,
          'sha256': spec.sha256,
          'url': spec.url.toString(),
          'installedAt': DateTime.now().toUtc().toIso8601String(),
        }),
      );
      final target = await _dir(spec);
      if (await target.exists()) await target.delete(recursive: true);
      await unpacked.rename(target.path);
      if (await staging.exists()) await staging.delete(recursive: true);
      if (await artifact.exists()) await artifact.delete();

      AppLog.info('models', '${spec.id} installed');
      _set(spec, ModelStatus(
        ModelPhase.installed,
        receivedBytes: spec.sizeBytes,
        totalBytes: spec.sizeBytes,
      ));
      return true;
    } on _Cancelled {
      AppLog.info('models', '${spec.id} install cancelled');
      final have = await artifact.exists() ? await artifact.length() : 0;
      await _cleanStaging(spec);
      _set(spec, ModelStatus(
        ModelPhase.absent,
        receivedBytes: have,
        totalBytes: spec.sizeBytes,
      ));
      return false;
    } catch (error) {
      AppLog.warn('models', '${spec.id} install failed', error);
      final have = await artifact.exists() ? await artifact.length() : 0;
      await _cleanStaging(spec);
      _set(spec, ModelStatus(
        ModelPhase.failed,
        receivedBytes: have,
        totalBytes: spec.sizeBytes,
        error: _describe(error),
      ));
      return false;
    }
  }

  Future<void> _cleanStaging(ModelSpec spec) async {
    try {
      final staging = await _staging(spec);
      if (await staging.exists()) await staging.delete(recursive: true);
    } catch (_) {
      // Best effort; the next install clears it first anyway.
    }
  }

  static String _describe(Object error) {
    if (error is ModelInstallException) return error.message;
    if (error is SocketException || error is http.ClientException) {
      return 'Download interrupted — check your connection and retry';
    }
    if (error is FileSystemException) {
      return 'Storage error: ${error.osError?.message ?? error.message}';
    }
    return error.toString();
  }

  /// Stream the artifact to [file], appending to an existing partial file
  /// when the server honours a range request.
  Future<void> _fetch(ModelSpec spec, File file, _Cancel cancel) async {
    var have = await file.exists() ? await file.length() : 0;
    if (have > spec.sizeBytes) {
      await file.delete();
      have = 0;
    }
    if (have == spec.sizeBytes) return; // Complete; verification decides.

    final client = _httpClient();
    cancel.onCancel = client.close;
    try {
      final request = http.Request('GET', spec.url);
      if (have > 0) request.headers['Range'] = 'bytes=$have-';
      final response = await client.send(request);
      cancel.check();

      var append = false;
      if (response.statusCode == 206 && have > 0) {
        append = true;
      } else if (response.statusCode == 200) {
        have = 0; // Server ignored the range: start over.
      } else if (response.statusCode == 416 && have > 0) {
        // Nothing left to fetch; let verification judge what we have.
        await response.stream.drain<void>();
        return;
      } else {
        try {
          await response.stream.drain<void>();
        } catch (_) {
          // The status code is the error worth reporting.
        }
        throw ModelInstallException('Download failed (HTTP ${response.statusCode})');
      }

      final sink = file.openWrite(mode: append ? FileMode.append : FileMode.write);
      var received = have;
      var lastNotify = DateTime.fromMillisecondsSinceEpoch(0);
      _set(spec, ModelStatus(
        ModelPhase.downloading,
        receivedBytes: received,
        totalBytes: spec.sizeBytes,
      ));
      try {
        await for (final chunk in response.stream) {
          cancel.check();
          sink.add(chunk);
          received += chunk.length;
          if (received > spec.sizeBytes) {
            throw const ModelInstallException(
              'Download is larger than expected',
            );
          }
          final now = DateTime.now();
          if (now.difference(lastNotify) >= _progressInterval) {
            lastNotify = now;
            _set(spec, ModelStatus(
              ModelPhase.downloading,
              receivedBytes: received,
              totalBytes: spec.sizeBytes,
            ));
          }
        }
      } finally {
        await sink.flush();
        await sink.close();
      }
      cancel.check();
      if (received < spec.sizeBytes) {
        throw ModelInstallException(
          'Download interrupted at $received of ${spec.sizeBytes} bytes',
        );
      }
    } on http.ClientException {
      if (cancel.cancelled) throw const _Cancelled();
      rethrow;
    } finally {
      cancel.onCancel = null;
      client.close();
    }
  }

  static Future<String> _sha256(File file) async =>
      (await sha256.bind(file.openRead()).first).toString();
}

class _Cancelled implements Exception {
  const _Cancelled();
}

class _Cancel {
  bool cancelled = false;
  void Function()? onCancel;

  void cancel() {
    cancelled = true;
    onCancel?.call();
  }

  void check() {
    if (cancelled) throw const _Cancelled();
  }
}

/// Default [ModelUnpacker]: stores single files, unpacks `.tar.bz2` archives
/// on a background isolate (bzip2 in pure Dart is CPU-bound for a minute or
/// so on a phone; it must not touch the UI isolate).
Future<void> unpackInIsolate(
  ModelSpec spec,
  File artifact,
  Directory destination,
) async {
  switch (spec.packaging) {
    case ModelPackaging.file:
      final name = spec.fileName ?? p.basename(spec.url.path);
      await artifact.copy(p.join(destination.path, name));
    case ModelPackaging.tarBz2:
      final source = artifact.path;
      final target = destination.path;
      await Isolate.run(() => extractTarBz2(source, target));
  }
}

/// Unpack a `.tar.bz2` at [archivePath] into [outputDir], streaming through a
/// temporary `.tar` next to the output so memory stays flat.
///
/// Refuses anything that could escape [outputDir]: absolute paths, `..`
/// segments, and links. Model archives contain only plain files and
/// directories, so a link is treated as a corrupt archive.
void extractTarBz2(String archivePath, String outputDir) {
  final tarPath = '$outputDir.tar';
  final tarOut = OutputFileStream(tarPath);
  final bzIn = InputFileStream(archivePath);
  try {
    BZip2Decoder().decodeStream(bzIn, tarOut);
  } finally {
    bzIn.closeSync();
    tarOut.closeSync();
  }
  final tarIn = InputFileStream(tarPath);
  try {
    final archive = TarDecoder().decodeStream(tarIn);
    final root = p.canonicalize(outputDir);
    for (final entry in archive) {
      final name = entry.name;
      if (name.isEmpty) continue;
      if (entry.isSymbolicLink) {
        throw ModelInstallException('Archive contains a link: $name');
      }
      final normalized = p.normalize(name);
      final target = p.canonicalize(p.join(root, normalized));
      if (target == root) continue; // "./"
      if (p.isAbsolute(normalized) || !p.isWithin(root, target)) {
        throw ModelInstallException('Archive entry escapes the model: $name');
      }
      if (!entry.isFile) {
        Directory(target).createSync(recursive: true);
        continue;
      }
      Directory(p.dirname(target)).createSync(recursive: true);
      final out = OutputFileStream(target);
      try {
        entry.writeContent(out);
      } finally {
        out.closeSync();
      }
    }
  } finally {
    tarIn.closeSync();
    final tar = File(tarPath);
    if (tar.existsSync()) tar.deleteSync();
  }
}
