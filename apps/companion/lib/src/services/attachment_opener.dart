import 'dart:async';
import 'dart:convert' show utf8;
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:url_launcher/url_launcher.dart' show launchUrl;

import 'log.dart';

/// Saves a chat attachment to the user's Downloads (the default action) or
/// opens it with the OS handler for its type.
///
/// Handing the bridge URL to a browser would need the bearer token in the
/// query string, where it lands in browser history and any proxy's access
/// log. Instead the bytes are fetched here with an `Authorization` header —
/// through the process-wide [HttpOverrides], so the bridge's pinned
/// certificate and any client certificate apply — into the app's cache, and
/// the local copy is what gets opened.
///
/// Android shares the file through the app's FileProvider (a raw `file://`
/// URI throws FileUriExposedException on 7+); the desktops open the path
/// with their default handler.
///
/// Saving copies the cached download out to a place the user owns: the
/// public Downloads collection through MediaStore on Android (10+), the XDG /
/// platform Downloads folder on the desktops.
class AttachmentOpener {
  AttachmentOpener({
    http.Client Function()? client,
    Future<Directory> Function()? cacheRoot,
    Future<bool> Function(File file, String mimeType)? launch,
    Future<Directory?> Function()? downloadsRoot,
    Future<String?> Function(File file, String name, String mimeType)? store,
  })  : _client = client ?? http.Client.new,
        _cacheRoot = cacheRoot ?? getTemporaryDirectory,
        _launch = launch ?? _platformLaunch,
        _downloadsRoot = downloadsRoot ?? getDownloadsDirectory,
        _storeOverride = store;

  final http.Client Function() _client;
  final Future<Directory> Function() _cacheRoot;
  final Future<bool> Function(File file, String mimeType) _launch;
  final Future<Directory?> Function() _downloadsRoot;
  final Future<String?> Function(File file, String name, String mimeType)?
      _storeOverride;

  /// The opener the chat's file chips use. Swappable for widget tests.
  static AttachmentOpener instance = AttachmentOpener();

  @visibleForTesting
  static void reset() => instance = AttachmentOpener();

  static const _channel = MethodChannel('talon/files');

  /// Fetch [url] with [headers] (unless an earlier tap already did) and open
  /// it. Throws [AttachmentException] when the download or the hand-off
  /// fails, with a message fit for a snackbar.
  Future<File> open({
    required String url,
    required String name,
    required String mimeType,
    Map<String, String> headers = const {},
  }) async {
    final file = await fetch(url: url, name: name, headers: headers);
    if (!await _launch(file, mimeType)) {
      throw AttachmentException('No app could open $name.');
    }
    return file;
  }

  /// Fetch [url] with [headers] and save a copy to the user's Downloads.
  /// Returns where it landed (a path on the desktops, `Download/<name>` on
  /// Android) plus the cached copy, so the UI can offer to open it. Throws
  /// [AttachmentException] when the download or the save fails.
  Future<SavedAttachment> save({
    required String url,
    required String name,
    required String mimeType,
    Map<String, String> headers = const {},
  }) async {
    final file = await fetch(url: url, name: name, headers: headers);
    return _saveFetched(file, safeName(name), mimeType);
  }

  /// [save] for a bare `/media?id=…` link: name and MIME come from the
  /// response, as in [openLink], or from [name] if declared.
  Future<SavedAttachment> saveLink({
    required String url,
    Map<String, String> headers = const {},
    String? name,
  }) async {
    final (file, mimeType) =
        await _fetch(url: url, headers: headers, name: name);
    return _saveFetched(file, _basename(file.path), mimeType);
  }

  /// Open a file this opener already downloaded (the "Open" action offered
  /// after a save).
  Future<void> openLocal(File file, String mimeType) async {
    if (!await _launch(file, mimeType)) {
      throw AttachmentException('No app could open ${_basename(file.path)}.');
    }
  }

  Future<SavedAttachment> _saveFetched(
    File file,
    String name,
    String mimeType,
  ) async {
    String? where;
    try {
      where = await (_storeOverride ?? _platformStore)(file, name, mimeType);
    } catch (e) {
      AppLog.warn('attachment', 'save to Downloads failed', e);
    }
    if (where == null) {
      throw AttachmentException("Couldn't save $name to Downloads.");
    }
    return SavedAttachment(file: file, mimeType: mimeType, location: where);
  }

  /// Copy [file] into the platform's Downloads. Android goes through
  /// MediaStore (scoped storage forbids raw paths); the desktops copy into
  /// [getDownloadsDirectory], never overwriting an existing file.
  Future<String?> _platformStore(File file, String name, String mimeType) async {
    if (Platform.isAndroid) {
      return _channel.invokeMethod<String>('saveToDownloads', {
        'path': file.path,
        'name': name,
        'mimeType': mimeType,
      });
    }
    final dir = await _downloadsRoot();
    if (dir == null) return null;
    await dir.create(recursive: true);
    final target = uniqueTarget(dir, name);
    await file.copy(target.path);
    return target.path;
  }

  /// A file in [dir] named [name] that doesn't exist yet: `name`, then
  /// `name (1)`, `name (2)`… with the counter before the extension.
  @visibleForTesting
  static File uniqueTarget(Directory dir, String name) {
    final sep = Platform.pathSeparator;
    var candidate = File('${dir.path}$sep$name');
    if (!candidate.existsSync()) return candidate;
    final dot = name.lastIndexOf('.');
    final stem = dot > 0 ? name.substring(0, dot) : name;
    final ext = dot > 0 ? name.substring(dot) : '';
    for (var i = 1; i < 1000; i++) {
      candidate = File('${dir.path}$sep$stem ($i)$ext');
      if (!candidate.existsSync()) return candidate;
    }
    return File(
        '${dir.path}$sep$stem (${DateTime.now().millisecondsSinceEpoch})$ext');
  }

  /// Open a bare bridge link that carries no attachment metadata — a
  /// `/media?id=…` URL written inside message text. Unlike [open] there is no
  /// declared name or MIME here, so both are recovered from the download: the
  /// name from a `Content-Disposition` filename (falling back to the URL's
  /// media id) and the MIME from `Content-Type`, with the file extension
  /// derived from the MIME so the OS still picks the right handler.
  Future<File> openLink({
    required String url,
    Map<String, String> headers = const {},
    String? name,
  }) async {
    final (file, mimeType) =
        await _fetch(url: url, headers: headers, name: name);
    if (!await _launch(file, mimeType)) {
      throw AttachmentException('No app could open ${_basename(file.path)}.');
    }
    return file;
  }

  /// Download [url] into the attachment cache and return the local file.
  /// A media id always names the same bytes, so a finished download is
  /// reused as is; a partial one is never mistaken for it.
  Future<File> fetch({
    required String url,
    required String name,
    Map<String, String> headers = const {},
  }) async {
    final (file, _) = await _fetch(url: url, headers: headers, name: name);
    return file;
  }

  /// The shared download core. Streams [url] into the cache and returns the
  /// finished file plus the server's `Content-Type`. When [name] is null the
  /// file name is recovered from `Content-Disposition` / the URL, and its
  /// extension from the MIME type.
  Future<(File, String)> _fetch({
    required String url,
    Map<String, String> headers = const {},
    String? name,
  }) async {
    final root = await _cacheRoot();
    final dir = Directory(
      '${root.path}${Platform.pathSeparator}attachments'
      '${Platform.pathSeparator}${_slot(url)}',
    );
    // With a declared name the bytes are addressable before the request, so a
    // finished download short-circuits. A bare link's name isn't known until
    // the response headers arrive, so it can't be probed here — the cache
    // slot still dedupes it once written.
    if (name != null) {
      final known =
          File('${dir.path}${Platform.pathSeparator}${safeName(name)}');
      if (await known.exists() && await known.length() > 0) {
        return (known, _mimeForPath(known.path));
      }
    }
    await dir.create(recursive: true);
    final client = _client();
    File? part;
    try {
      final res = await client
          .send(http.Request('GET', Uri.parse(url))..headers.addAll(headers))
          .timeout(const Duration(seconds: 30));
      if (res.statusCode != 200) {
        await res.stream.drain<void>();
        throw AttachmentException(
          res.statusCode == 401
              ? 'The bridge refused the download (not authorised).'
              : 'Download failed (${res.statusCode}).',
        );
      }
      final contentType =
          (res.headers['content-type'] ?? 'application/octet-stream')
              .split(';')
              .first
              .trim();
      final fileName =
          name ?? _nameFromResponse(url, res.headers, contentType);
      final file =
          File('${dir.path}${Platform.pathSeparator}${safeName(fileName)}');
      if (name == null && await file.exists() && await file.length() > 0) {
        await res.stream.drain<void>();
        return (file, contentType);
      }
      part = File('${file.path}.part');
      final sink = part.openWrite();
      try {
        await res.stream.pipe(sink);
      } finally {
        await sink.close();
      }
      final done = await part.rename(file.path);
      part = null;
      return (done, contentType);
    } on AttachmentException {
      rethrow;
    } catch (e) {
      AppLog.warn('attachment', 'download failed', e);
      throw const AttachmentException('Download failed.');
    } finally {
      client.close();
      if (part != null && await part.exists()) await part.delete();
    }
  }

  /// One cache folder per media URL, so two attachments that share a file
  /// name never overwrite each other.
  static String _slot(String url) =>
      sha256.convert(utf8.encode(url)).toString().substring(0, 16);

  /// Best-effort file name for a bare link: a `Content-Disposition` filename
  /// if the server gave one, else the URL's `id` query (or last path segment),
  /// always with an extension matching the MIME type.
  @visibleForTesting
  static String nameFromResponse(
    String url,
    Map<String, String> headers,
    String contentType,
  ) =>
      _nameFromResponse(url, headers, contentType);

  static String _nameFromResponse(
    String url,
    Map<String, String> headers,
    String contentType,
  ) {
    final disposition = headers['content-disposition'] ?? '';
    final match =
        RegExp(r'''filename\*?=(?:UTF-8'')?"?([^";]+)"?''', caseSensitive: false)
            .firstMatch(disposition);
    var base = match?.group(1)?.trim() ?? '';
    if (base.isEmpty) {
      final uri = Uri.tryParse(url);
      base = uri?.queryParameters['filename'] ??
          uri?.queryParameters['name'] ??
          '';
    }
    if (base.isEmpty) {
      final uri = Uri.tryParse(url);
      base = uri?.queryParameters['id'] ??
          (uri != null && uri.pathSegments.isNotEmpty
              ? uri.pathSegments.last
              : '');
    }
    if (base.isEmpty) base = 'attachment';
    final ext = _extForMime(contentType);
    if (ext.isNotEmpty && !_hasCompatibleExtension(base, contentType, ext)) {
      base = '$base$ext';
    }
    return base;
  }

  static bool _hasCompatibleExtension(
    String filename,
    String contentType,
    String defaultExt,
  ) {
    final lower = filename.toLowerCase();
    if (lower.endsWith(defaultExt)) return true;
    final dot = lower.lastIndexOf('.');
    if (dot <= 0 || dot >= lower.length - 1) return false;
    final existingExt = lower.substring(dot);
    final ct = contentType.toLowerCase();
    if (_mimeExt[ct] == existingExt) return true;
    if ((ct == 'text/x-diff' || ct == 'text/x-patch') &&
        (existingExt == '.patch' || existingExt == '.diff')) {
      return true;
    }
    if (ct == 'image/jpeg' &&
        (existingExt == '.jpg' || existingExt == '.jpeg')) {
      return true;
    }
    if (ct == 'application/gzip' &&
        (existingExt == '.gz' || existingExt == '.tgz')) {
      return true;
    }
    return false;
  }

  static String _basename(String path) =>
      path.split(Platform.pathSeparator).last;

  static String _mimeForPath(String path) {
    final dot = path.lastIndexOf('.');
    if (dot < 0) return 'application/octet-stream';
    final ext = path.substring(dot).toLowerCase();
    if (ext == '.patch' || ext == '.diff') return 'text/x-patch';
    for (final e in _mimeExt.entries) {
      if (e.value == ext) return e.key;
    }
    return 'application/octet-stream';
  }

  static String _extForMime(String mime) => _mimeExt[mime.toLowerCase()] ?? '';

  /// A conservative MIME→extension map, enough for the file types that ride
  /// through chat. An unknown type gets no extension rather than a wrong one.
  static const Map<String, String> _mimeExt = {
    'application/pdf': '.pdf',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'text/csv': '.csv',
    'text/html': '.html',
    'text/x-diff': '.diff',
    'text/x-patch': '.patch',
    'application/json': '.json',
    'application/zip': '.zip',
    'application/gzip': '.gz',
    'application/x-tar': '.tar',
    'application/x-sh': '.sh',
    'text/x-shellscript': '.sh',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
  };

  /// [name] reduced to a single safe path segment: no separators, no leading
  /// dots, nothing outside a conservative character set.
  @visibleForTesting
  static String safeName(String name) {
    var s = name.replaceAll(RegExp(r'[^\w .()+-]'), '_').trim();
    s = s.replaceFirst(RegExp(r'^\.+'), '');
    if (s.length > 120) s = s.substring(s.length - 120);
    return s.isEmpty ? 'attachment' : s;
  }

  static Future<bool> _platformLaunch(File file, String mimeType) async {
    if (Platform.isAndroid) {
      final ok = await _channel.invokeMethod<bool>('openFile', {
        'path': file.path,
        'mimeType': mimeType,
      });
      return ok ?? false;
    }
    return launchUrl(Uri.file(file.path));
  }
}

/// Where [AttachmentOpener.save] put a file: [location] is what to tell the
/// user; [file] is the cached copy, for an "Open" action.
class SavedAttachment {
  final File file;
  final String mimeType;
  final String location;
  const SavedAttachment({
    required this.file,
    required this.mimeType,
    required this.location,
  });
}

class AttachmentException implements Exception {
  final String message;
  const AttachmentException(this.message);
  @override
  String toString() => message;
}
