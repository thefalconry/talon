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
/// unless the pin is enforced ([pin]'s `enforce`, from
/// `ConnectionConfig.enforcesPin`): then clients are built without the
/// platform roots and every certificate must match.
///
/// It also carries the profile's client certificate (reverse proxies that
/// demand one): an avatar loaded by Image.network has to get through the
/// proxy too, and [createHttpClient] is the only hook into that client.
class BridgeTrust extends HttpOverrides {
  static String? _pinnedFingerprint;
  static bool _enforce = false;
  static SecurityContext? _clientContext;

  /// Adopt [fingerprint] (lowercase hex, no separators) as the pin; null
  /// clears it, restoring default certificate validation everywhere. With
  /// [enforce], even a CA-valid certificate must match it.
  static void pin(String? fingerprint, {bool enforce = false}) {
    _pinnedFingerprint = fingerprint;
    _enforce = enforce && fingerprint != null;
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
  HttpClient createHttpClient(SecurityContext? context) =>
      super.createHttpClient(context ??
          _clientContext ??
          (_enforce ? SecurityContext(withTrustedRoots: false) : null))
        ..badCertificateCallback = (cert, host, port) => accepts(cert);
}
