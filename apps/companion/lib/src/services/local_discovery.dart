import 'dart:convert';
import 'dart:io' show Directory, File, Platform;

import 'package:flutter/foundation.dart';

class LocalBridge {
  final String host;
  final int port;
  final String? token;
  final String scheme;

  /// Bridge certificate SHA-256 (lowercase hex) when [scheme] is https —
  /// pins the connection without a first-use leap of faith.
  final String? fingerprint;

  const LocalBridge({
    required this.host,
    required this.port,
    required this.scheme,
    this.token,
    this.fingerprint,
  });
}

Future<LocalBridge?> readLocalBridge() async {
  if (!_desktopPlatform) return null;
  final dir = _talonDataDir();
  if (dir == null) return null;
  return readLocalBridgeFromDirectory(dir);
}

@visibleForTesting
Future<LocalBridge?> readLocalBridgeFromDirectory(Directory dir) async {
  try {
    final file = File('${dir.path}${Platform.pathSeparator}native-bridge.json');
    final raw = await file.readAsString();
    final decoded = jsonDecode(raw);
    if (decoded is! Map) return null;
    final json = decoded.cast<String, dynamic>();
    final host = json['host'];
    final port = json['port'];
    final token = json['token'];
    final scheme = json['scheme'];
    final fingerprint = json['fingerprint'];
    if (host is! String || host.trim().isEmpty) return null;
    if (port is! int || port < 1 || port > 65535) return null;
    if (token != null && token is! String) return null;
    if (scheme != null && scheme is! String) return null;
    if (fingerprint != null && fingerprint is! String) return null;
    final normalizedScheme = scheme ?? 'http';
    if (normalizedScheme != 'http' && normalizedScheme != 'https') return null;
    return LocalBridge(
      host: host,
      port: port,
      token: token,
      scheme: normalizedScheme,
      fingerprint: fingerprint,
    );
  } catch (_) {
    return null;
  }
}

Directory? _talonDataDir() {
  final env = Platform.environment;
  final talonHome = env['TALON_HOME']?.trim();
  if (talonHome != null && talonHome.isNotEmpty) {
    return Directory(talonHome);
  }
  final home = Platform.isWindows
      ? (env['USERPROFILE']?.trim().isNotEmpty == true
          ? env['USERPROFILE']!
          : env['HOME'])
      : env['HOME'];
  if (home == null || home.trim().isEmpty) return null;
  return Directory('$home${Platform.pathSeparator}.talon');
}

bool get _desktopPlatform {
  if (kIsWeb) return false;
  try {
    return Platform.isWindows || Platform.isMacOS || Platform.isLinux;
  } catch (_) {
    return false;
  }
}
