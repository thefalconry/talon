/// Per-device bridge credentials (#1042 phase 2).
///
/// The daemon used to authenticate every client with one shared token. It
/// now mints each device its own credential — `tdc1.<id>.<secret>` — bound
/// to that device's mesh id and scoped (`device`, `client`, `operator`).
/// Pairing links already carry one; a profile still holding the shared
/// token trades it in band (`POST /auth/upgrade`) the first time it
/// connects, and stores the result in its connection profile in place of
/// the shared token. The wire shapes live in protocol/fixtures/auth_v1.json.
library;

final RegExp _deviceCredential = RegExp(
  r'^tdc1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$',
);

/// True for a per-device credential, false for the shared token (or none).
bool isDeviceCredential(String? token) =>
    token != null && _deviceCredential.hasMatch(token);

/// `GET /auth/whoami`: which credential this connection uses and whether the
/// daemon wants it upgraded (shared token) or rotated.
class CredentialStatus {
  final String kind;
  final List<String> scopes;
  final String? credentialId;
  final String? deviceId;

  /// `upgrade`, `rotate`, or null. Unknown actions come through verbatim and
  /// must be ignored by callers — see [CredentialStatus.wantsNewCredential].
  final String? action;

  const CredentialStatus({
    required this.kind,
    required this.scopes,
    this.credentialId,
    this.deviceId,
    this.action,
  });

  factory CredentialStatus.fromJson(Map<String, dynamic> j) => CredentialStatus(
        kind: j['kind'] is String ? j['kind'] as String : 'unknown',
        scopes: j['scopes'] is List
            ? (j['scopes'] as List).whereType<String>().toList()
            : const [],
        credentialId: j['credentialId'] as String?,
        deviceId: j['deviceId'] as String?,
        action: j['action'] as String?,
      );

  /// Whether a client holding [token] should ask for a new credential now:
  /// an upgrade off the shared token, or a rotation of its own credential.
  bool wantsNewCredential(String? token) {
    if (action == 'upgrade') return !isDeviceCredential(token);
    if (action == 'rotate') return isDeviceCredential(token);
    return false;
  }
}

/// A `POST /auth/upgrade` reply: the new credential. The reply is the only
/// copy of [token] anywhere — the daemon keeps a hash.
class CredentialGrant {
  final String token;
  final String credentialId;
  final String deviceId;
  final List<String> scopes;

  const CredentialGrant({
    required this.token,
    required this.credentialId,
    required this.deviceId,
    required this.scopes,
  });

  /// Throws [FormatException] for a refusal or a reply without a well-formed
  /// credential, so a bad reply can never replace a working token.
  factory CredentialGrant.fromJson(Map<String, dynamic> j) {
    final token = j['token'];
    if (j['ok'] != true || token is! String || !isDeviceCredential(token)) {
      throw FormatException(
        'No credential in upgrade reply: ${j['error'] ?? 'malformed'}',
      );
    }
    return CredentialGrant(
      token: token,
      credentialId: (j['credentialId'] ?? '') as String,
      deviceId: (j['deviceId'] ?? '') as String,
      scopes: j['scopes'] is List
          ? (j['scopes'] as List).whereType<String>().toList()
          : const [],
    );
  }
}
