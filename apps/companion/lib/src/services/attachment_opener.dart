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

/// Opens a chat attachment with the OS handler for its type.
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
class AttachmentOpener {
  AttachmentOpener({
    http.Client Function()? client,
    Future<Directory> Function()? cacheRoot,
    Future<bool> Function(File file, String mimeType)? launch,
  })  : _client = client ?? http.Client.new,
        _cacheRoot = cacheRoot ?? getTemporaryDirectory,
        _launch = launch ?? _platformLaunch;

  final http.Client Function() _client;
  final Future<Directory> Function() _cacheRoot;
  final Future<bool> Function(File file, String mimeType) _launch;

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

  /// Download [url] into the attachment cache and return the local file.
  /// A media id always names the same bytes, so a finished download is
  /// reused as is; a partial one is never mistaken for it.
  Future<File> fetch({
    required String url,
    required String name,
    Map<String, String> headers = const {},
  }) async {
    final root = await _cacheRoot();
    final dir = Directory(
      '${root.path}${Platform.pathSeparator}attachments'
      '${Platform.pathSeparator}${_slot(url)}',
    );
    final file = File('${dir.path}${Platform.pathSeparator}${safeName(name)}');
    if (await file.exists() && await file.length() > 0) return file;
    await dir.create(recursive: true);
    final part = File('${file.path}.part');
    final client = _client();
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
      final sink = part.openWrite();
      try {
        await res.stream.pipe(sink);
      } finally {
        await sink.close();
      }
      return await part.rename(file.path);
    } on AttachmentException {
      rethrow;
    } catch (e) {
      AppLog.warn('attachment', 'download failed', e);
      throw const AttachmentException('Download failed.');
    } finally {
      client.close();
      if (await part.exists()) await part.delete();
    }
  }

  /// One cache folder per media URL, so two attachments that share a file
  /// name never overwrite each other.
  static String _slot(String url) =>
      sha256.convert(utf8.encode(url)).toString().substring(0, 16);

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

class AttachmentException implements Exception {
  final String message;
  const AttachmentException(this.message);
  @override
  String toString() => message;
}
