import 'dart:io';

import 'package:crypto/crypto.dart';

/// Process-wide trust anchor for the bridge's self-signed certificate.
///
/// The daemon serves the bridge over TLS with a certificate it minted
/// itself, identified by the SHA-256 of its DER (the fingerprint the daemon
/// prints and `/health` advertises). The active pin lives here — set by
/// AppState whenever the connection profile changes — so every transport
/// that reaches the bridge honours it: BridgeClient's own IOClient, and the
/// HttpClient that Flutter's Image.network creates internally (reachable
/// only through [HttpOverrides]).
///
/// Semantics: an otherwise-untrusted certificate is accepted exactly when
/// its fingerprint matches the pin. Certificates that already chain to a
/// platform-trusted CA (reverse-proxy setups) never reach this code — the
/// bad-certificate callback fires only when normal validation failed —
/// unless the pin is enforced ([pin]'s `enforceOn`, from
/// `ConnectionConfig.enforcesPin`): then connections to the bridge's own
/// `host:port` are made without the platform roots, so every certificate
/// it presents must match. Enforcement is scoped to that one address and
/// decided per connection: the same implicit clients also fetch from
/// GitHub (update checks), model hosts and arbitrary image URLs, which
/// must keep normal CA validation; and Flutter's NetworkImage keeps one
/// HttpClient for the life of the process, created long before a pin may
/// become binding.
///
/// It also carries the profile's client certificate (reverse proxies that
/// demand one): an avatar loaded by Image.network has to get through the
/// proxy too, and [createHttpClient] is the only hook into that client.
class BridgeTrust extends HttpOverrides {
  static String? _pinnedFingerprint;
  static ({String host, int port})? _enforcedOn;
  static SecurityContext? _strictContext;
  static SecurityContext? _clientContext;

  /// Adopt [fingerprint] (lowercase hex, no separators) as the pin; null
  /// clears it, restoring default certificate validation everywhere. With
  /// [enforceOn] (the bridge's address), even a CA-valid certificate
  /// presented there must match it; [strictContext] is the root-less
  /// context those connections use (the profile's client certificate, if
  /// any — a bare root-less context otherwise). Other hosts are unaffected.
  static void pin(
    String? fingerprint, {
    ({String host, int port})? enforceOn,
    SecurityContext? strictContext,
  }) {
    _pinnedFingerprint = fingerprint;
    _enforcedOn = fingerprint == null ? null : enforceOn;
    _strictContext = _enforcedOn == null ? null : strictContext;
  }

  /// Whether a connection to [uri] must match the pin even when its
  /// certificate chains to a trusted CA.
  static bool enforcedFor(Uri uri) {
    final on = _enforcedOn;
    return on != null &&
        _pinnedFingerprint != null &&
        uri.isScheme('https') &&
        uri.host.toLowerCase() == on.host.toLowerCase() &&
        uri.port == on.port;
  }

  /// Present [context]'s client certificate on implicitly-created clients;
  /// null stops presenting one.
  static void useClientContext(SecurityContext? context) =>
      _clientContext = context;

  static String? get pinned => _pinnedFingerprint;

  /// The pin-comparison form of a certificate: SHA-256 over its DER.
  static String fingerprintOf(X509Certificate cert) =>
      sha256.convert(cert.der).toString();

  static bool accepts(X509Certificate cert) =>
      _pinnedFingerprint != null && fingerprintOf(cert) == _pinnedFingerprint;

  /// Route every implicitly-created HttpClient through the pin. Called once
  /// at startup, before any widget can issue a request.
  static void install() {
    HttpOverrides.global = BridgeTrust();
  }

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    final shared = context ?? _clientContext;
    final client = super.createHttpClient(shared)
      ..badCertificateCallback = (cert, host, port) => accepts(cert);
    // Decided per connection, not per client (see the class comment). Every
    // other connection is made exactly as HttpClient would make it itself.
    client.connectionFactory = (uri, proxyHost, proxyPort) {
      if (proxyHost != null && proxyPort != null) {
        // HttpClient tunnels through the proxy and does the TLS itself.
        return Socket.startConnect(proxyHost, proxyPort);
      }
      if (!uri.isScheme('https')) {
        return Socket.startConnect(uri.host, uri.port);
      }
      final strict = enforcedFor(uri);
      return SecureSocket.startConnect(
        uri.host,
        uri.port,
        context: strict
            ? (_strictContext ?? SecurityContext(withTrustedRoots: false))
            : shared,
        onBadCertificate: accepts,
      );
    };
    return client;
  }
}
