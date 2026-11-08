import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../models/bridge_models.dart';

/// Extension → MIME for the files a companion user is likely to attach. The
/// daemon re-derives the type authoritatively on upload; this is what the
/// composer needs locally to decide between a thumbnail and a file chip.
const Map<String, String> _mimeByExtension = {
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'bmp': 'image/bmp',
  'heic': 'image/heic',
  'heif': 'image/heif',
  'avif': 'image/avif',
  'tif': 'image/tiff',
  'tiff': 'image/tiff',
  'svg': 'image/svg+xml',
  'zip': 'application/zip',
  'gz': 'application/gzip',
  'tgz': 'application/gzip',
  'bz2': 'application/x-bzip2',
  'xz': 'application/x-xz',
  'zst': 'application/zstd',
  'tar': 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  'rar': 'application/vnd.rar',
  'pdf': 'application/pdf',
  'doc': 'application/msword',
  'docx':
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt': 'application/vnd.ms-powerpoint',
  'pptx':
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'epub': 'application/epub+zip',
  'rtf': 'application/rtf',
  'txt': 'text/plain',
  'log': 'text/plain',
  'md': 'text/markdown',
  'csv': 'text/csv',
  'tsv': 'text/tab-separated-values',
  'json': 'application/json',
  'jsonl': 'application/x-ndjson',
  'xml': 'application/xml',
  'yaml': 'application/yaml',
  'yml': 'application/yaml',
  'toml': 'application/toml',
  'html': 'text/html',
  'css': 'text/css',
  'js': 'text/javascript',
  'ts': 'text/x-typescript',
  'dart': 'text/x-dart',
  'py': 'text/x-python',
  'rs': 'text/x-rust',
  'go': 'text/x-go',
  'java': 'text/x-java',
  'c': 'text/x-c',
  'h': 'text/x-c',
  'cpp': 'text/x-c++',
  'sh': 'application/x-sh',
  'sql': 'application/sql',
  'patch': 'text/x-diff',
  'diff': 'text/x-diff',
  'mp3': 'audio/mpeg',
  'm4a': 'audio/mp4',
  'wav': 'audio/wav',
  'ogg': 'audio/ogg',
  'opus': 'audio/opus',
  'flac': 'audio/flac',
  'mp4': 'video/mp4',
  'mov': 'video/quicktime',
  'webm': 'video/webm',
  'mkv': 'video/x-matroska',
  'avi': 'video/x-msvideo',
  'ttf': 'font/ttf',
  'otf': 'font/otf',
  'woff': 'font/woff',
  'woff2': 'font/woff2',
  'apk': 'application/vnd.android.package-archive',
  'deb': 'application/vnd.debian.binary-package',
  'exe': 'application/vnd.microsoft.portable-executable',
  'iso': 'application/x-iso9660-image',
};

/// Best-effort MIME type for a file name. `application/octet-stream` when the
/// extension says nothing — which is a correct answer for an upload, and the
/// daemon refines it on arrival.
String mimeTypeFor(String filename) {
  final dot = filename.lastIndexOf('.');
  if (dot < 0 || dot == filename.length - 1) return 'application/octet-stream';
  final ext = filename.substring(dot + 1).toLowerCase();
  return _mimeByExtension[ext] ?? 'application/octet-stream';
}

/// Size as a short human label ("4.2 MB").
String formatBytes(int size) {
  if (size <= 0) return '';
  if (size < 1024) return '$size B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  var value = size / 1024;
  var unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  final rounded = value < 10 ? value.toStringAsFixed(1) : value.round();
  return '$rounded ${units[unit]}';
}

/// A file the user has staged on the composer but not yet sent. Lives as a
/// path on *this* device until the send uploads it to the daemon.
class StagedFile {
  /// Local path on the device running the app.
  final String path;
  final String name;
  final int size;
  final String mimeType;

  /// Bytes uploaded so far, while the upload is in flight.
  int sent = 0;

  /// True while this file's bytes are going up.
  bool uploading = false;

  /// The daemon's record of this file, once its upload finished. Files upload
  /// as soon as they are staged, so by the time the user hits send this is
  /// already populated — the send itself only has to name what is on the
  /// daemon, never push bytes.
  Attachment? uploaded;

  /// Why the upload failed, when it did. A failed file blocks the send until
  /// it is retried or removed, rather than going out as a silently missing
  /// attachment.
  String? error;

  StagedFile({
    required this.path,
    required this.name,
    required this.size,
    required this.mimeType,
  });

  /// Stage a file already on disk. Returns null when it is missing or empty —
  /// a dropped directory, or a file that vanished between pick and send.
  static StagedFile? fromPath(String rawPath, {String? name, int? size}) {
    var path = rawPath.trim();
    if (path.startsWith('file://')) {
      try {
        path = Uri.parse(path).toFilePath();
      } catch (_) {
        path = Uri.decodeFull(path.substring(7));
      }
    }
    final file = File(path);
    final length = size ?? (file.existsSync() ? file.lengthSync() : 0);
    if (length <= 0) return null;
    final label = name ?? path.split(Platform.pathSeparator).last;
    return StagedFile(
      path: path,
      name: label,
      size: length,
      mimeType: mimeTypeFor(label),
    );
  }

  bool get isImage => mimeType.startsWith('image/');

  /// Ready to be named in a send.
  bool get isUploaded => uploaded != null;

  /// The upload failed and has not been retried.
  bool get failed => error != null;

  /// 0–1 upload progress, or null once there is nothing in flight to show.
  double? get progress =>
      uploading ? (size <= 0 ? 0 : (sent / size).clamp(0.0, 1.0)) : null;

  String get sizeLabel => formatBytes(size);
}

/// The composer's staged attachments. Held outside the composer widget so the
/// desktop drop target — which wraps the whole chat pane — can stage files
/// into the same list the composer renders and sends.
///
/// Staging a file starts its upload immediately. Uploading on send instead
/// meant the bytes only started moving once the user committed, so a 9 MB
/// deck sat there doing nothing until send and then appeared to hang; worse,
/// every retry of a failed send re-uploaded every file (four copies of one
/// deck landed in the uploads dir on 2026-09-16). Uploading at stage time
/// makes the wait visible where the file is, costs one upload per file, and
/// lets the composer simply refuse to send until the bytes are up.
class ComposerAttachments extends ChangeNotifier {
  final List<StagedFile> _files = [];

  /// Uploader for staged files. Set once by the pane that owns this list;
  /// until it is set, files stage but do not upload (the send button stays
  /// disabled, which is the honest state — nothing can be attached without a
  /// daemon to attach it to).
  UploadFile? uploader;

  /// Files staged for the next send, in the order they were added.
  List<StagedFile> get files => List.unmodifiable(_files);
  bool get isEmpty => _files.isEmpty;
  bool get isNotEmpty => _files.isNotEmpty;
  int get length => _files.length;

  /// True while any staged file's bytes are still going up.
  bool get uploading => _files.any((f) => f.uploading);

  /// True when every staged file is on the daemon — the send may go out.
  /// Vacuously true with nothing staged, so a text-only message is unaffected.
  bool get ready => _files.every((f) => f.isUploaded);

  /// Staged files whose upload failed; the send stays blocked until each is
  /// retried or removed.
  bool get hasFailures => _files.any((f) => f.failed);

  /// The daemon records for every uploaded file, in staging order — what a
  /// send names.
  List<Attachment> get uploadedAttachments => [
        for (final file in _files)
          if (file.uploaded != null) file.uploaded!,
      ];

  /// Stage files by path, skipping directories, empty files and any path
  /// already staged. Returns how many were added.
  int addPaths(Iterable<String> paths) {
    var added = 0;
    for (final path in paths) {
      if (_files.any((f) => f.path == path)) continue;
      final staged = StagedFile.fromPath(path);
      if (staged == null) continue;
      _files.add(staged);
      added += 1;
    }
    if (added > 0) {
      notifyListeners();
      _uploadPending();
    }
    return added;
  }

  /// Stage already-described files (the picker hands back name + size).
  int addAll(Iterable<StagedFile> staged) {
    var added = 0;
    for (final file in staged) {
      if (_files.any((f) => f.path == file.path)) continue;
      _files.add(file);
      added += 1;
    }
    if (added > 0) {
      notifyListeners();
      _uploadPending();
    }
    return added;
  }

  /// Re-attempt one file whose upload failed.
  void retry(StagedFile file) {
    if (!_files.contains(file) || file.uploading) return;
    file.error = null;
    notifyListeners();
    _uploadPending();
  }

  void remove(StagedFile file) {
    if (_files.remove(file)) notifyListeners();
  }

  void clear() {
    if (_files.isEmpty) return;
    _files.clear();
    notifyListeners();
  }

  /// Put files back after a failed send so nothing is silently thrown away.
  /// Their uploads are kept: the bytes are already on the daemon and its
  /// records stay valid, so a retried send costs no second upload.
  void restore(List<StagedFile> files) {
    _files
      ..clear()
      ..addAll(files);
    notifyListeners();
    // Anything that had not finished uploading when the send failed still
    // needs to.
    _uploadPending();
  }

  /// Start every staged file that is not uploaded, uploading, or failed.
  void _uploadPending() {
    if (uploader == null) return;
    for (final file in _files) {
      if (file.isUploaded || file.uploading || file.failed) continue;
      unawaited(_upload(file));
    }
  }

  /// Stream one staged file to the daemon, keeping its progress and outcome
  /// on the file itself so the composer can render it.
  Future<void> _upload(StagedFile file) async {
    final upload = uploader;
    if (upload == null) return;
    final handle = File(file.path);
    if (!handle.existsSync()) {
      file.error = 'no longer on disk';
      notifyListeners();
      return;
    }
    file.uploading = true;
    file.sent = 0;
    notifyListeners();
    Attachment? result;
    try {
      result = await upload(
        handle.openRead(),
        file.size,
        file.name,
        file.mimeType,
        onProgress: (sent) {
          // Removed mid-flight: stop repainting a tile that is gone.
          if (!_files.contains(file)) return;
          file.sent = sent;
          notifyListeners();
        },
      );
    } catch (e) {
      result = null;
    }
    // The user removed it (or cleared the composer) while it was going up —
    // the daemon keeps the bytes, but this list no longer speaks for them.
    if (!_files.contains(file)) return;
    file.uploading = false;
    if (result == null) {
      file.error = 'upload failed';
    } else {
      file.uploaded = result;
      file.sent = file.size;
    }
    notifyListeners();
  }
}

/// The uploader the composer calls per staged file. Returns null on failure.
typedef UploadFile = Future<Attachment?> Function(
  Stream<List<int>> bytes,
  int length,
  String filename,
  String contentType, {
  void Function(int sent)? onProgress,
});
