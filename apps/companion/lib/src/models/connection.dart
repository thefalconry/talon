import 'dart:convert' show base64;
import 'dart:io'
    show InternetAddress, InternetAddressType, Platform, SecurityContext;

/// How the companion reaches a Talon daemon.
///
/// - On desktop the default is zero-config local discovery: Talon writes
///   `~/.talon/native-bridge.json`, and the app reads host/port/token from it.
/// - On mobile (or when pointing at another machine) it's a *remote* bridge:
///   a host/IP + port and, for anything off-loopback, a shared token.
class ConnectionConfig {
  final String host;
  final int port;
  final String? token;

  /// Use TLS (https) for the bridge — either the bridge's own certificate
  /// (`native.tls`, the default whenever the daemon binds off-loopback) or a
  /// reverse proxy (Caddy/nginx/Tailscale Serve) that terminates HTTPS.
  final bool tls;

  /// Pinned bridge certificate: SHA-256 of the certificate DER, lowercase
  /// hex without separators. Captured on first connect (or from local
  /// discovery) and required to match on every reconnect; null means no pin
  /// yet — the next TLS connect adopts whatever certificate it sees.
  /// Irrelevant for proxy setups whose certificates chain to a real CA (the
  /// platform trust store accepts those before the pin is consulted).
  final String? fingerprint;

  /// Client certificate for servers behind a reverse proxy that demands one
  /// (mutual TLS, the way Immich's app does it): the imported `.p12`/`.pfx`
  /// file as base64, and its password. Presented on every TLS handshake. It
  /// only gets the app through the proxy; the bridge still authenticates
  /// with the [token] as usual.
  final String? clientP12;
  final String? clientP12Password;

  /// The bridge's address on the home network, used instead of the main
  /// address whenever it answers (see `resolveEndpoint`). Typical with a
  /// reverse proxy: the main address is the public website, this is the LAN.
  final String? localUrl;

  /// Desktop only: try to spawn/attach a local daemon instead of assuming one.
  final bool manageLocalDaemon;

  /// Desktop local mode: discover the running bridge from Talon's data dir
  /// instead of launching a daemon or requiring host/port/token entry.
  final bool localAutoDiscover;

  /// Command used to launch the daemon when [manageLocalDaemon] is on.
  /// Defaults to the globally-installed `talon` CLI on PATH.
  final String launchCommand;
  final List<String> launchArgs;

  const ConnectionConfig({
    this.host = '127.0.0.1',
    this.port = 19880,
    this.token,
    this.tls = false,
    this.fingerprint,
    this.clientP12,
    this.clientP12Password,
    this.localUrl,
    this.manageLocalDaemon = true,
    this.localAutoDiscover = true,
    this.launchCommand = 'talon',
    this.launchArgs = const ['start'],
  });

  bool get hasClientCert => clientP12?.isNotEmpty ?? false;

  /// A TLS context presenting the imported client certificate, or null when
  /// there is none (or it no longer loads — the proxy's refusal is then the
  /// error the user sees, which says what to fix).
  SecurityContext? clientSecurityContext() {
    final p12 = clientP12;
    if (p12 == null || p12.isEmpty) return null;
    try {
      final bytes = base64.decode(p12);
      return SecurityContext(withTrustedRoots: true)
        ..useCertificateChainBytes(bytes, password: clientP12Password)
        ..usePrivateKeyBytes(bytes, password: clientP12Password);
    } catch (_) {
      return null;
    }
  }

  /// Check an imported `.p12`/`.pfx` opens with [password] and return it as
  /// stored ([clientP12]). Throws [FormatException] with a message for the
  /// user when it doesn't.
  static String importP12(List<int> bytes, String? password) {
    final encoded = base64.encode(bytes);
    final probe = ConnectionConfig(
      clientP12: encoded,
      clientP12Password: password,
    );
    if (probe.clientSecurityContext() == null) {
      throw const FormatException(
        "Couldn't open the certificate — check the password. If it was made "
        'with OpenSSL 3, export it again with `openssl pkcs12 -export -legacy`.',
      );
    }
    return encoded;
  }

  /// This profile pointed at its [localUrl], or null when it has none. The
  /// pinned certificate belongs to the bridge itself — what the LAN address
  /// reaches — so the pin comes along.
  ConnectionConfig? localEndpoint() {
    final raw = localUrl?.trim() ?? '';
    if (raw.isEmpty) return null;
    final parsed = parseHostInput(raw);
    if (parsed.host.isEmpty) return null;
    // Off-loopback the bridge serves TLS by default.
    final tls = parsed.tls ?? true;
    return copyWith(
      host: parsed.host,
      port: parsed.port ?? defaultPortFor(tls),
      tls: tls,
      clearLocalUrl: true,
    );
  }

  /// This profile's main address. With a LAN address alongside, the pin is
  /// the LAN bridge's, not the reverse proxy's, so it stays behind and the
  /// proxy's certificate is checked the normal way.
  ConnectionConfig remoteEndpoint() => localUrl == null
      ? this
      : copyWith(clearFingerprint: true, clearLocalUrl: true);

  /// Canonical fingerprint form: lowercase hex, no colons/spaces. Returns
  /// null for anything that isn't plausibly a SHA-256 hex digest.
  static String? normalizeFingerprint(String? raw) {
    if (raw == null) return null;
    final s = raw.replaceAll(RegExp(r'[\s:]'), '').toLowerCase();
    return RegExp(r'^[0-9a-f]{64}$').hasMatch(s) ? s : null;
  }

  bool get isLoopback =>
      host == '127.0.0.1' || host == 'localhost' || host == '::1';

  /// We only ever supervise a daemon for a local, loopback connection.
  bool get canManageDaemon =>
      manageLocalDaemon && !localAutoDiscover && isLoopback && _desktopPlatform;

  /// Zero-config discovery is only meaningful for same-machine desktop mode.
  bool get canAutoDiscoverLocal =>
      localAutoDiscover && isLoopback && _desktopPlatform;

  String get scheme => tls ? 'https' : 'http';

  /// The port a URL of this scheme implies when none is written down: 443 for
  /// https, 80 for http. A bridge behind a reverse proxy lives on one of these,
  /// so "no port" has to mean the scheme default rather than the daemon's own
  /// 19880 — otherwise pasting `https://mesh.example.org` silently dials the
  /// wrong port and connects only while the direct port is still open.
  static int defaultPortFor(bool tls) => tls ? 443 : 80;

  /// True when [port] is the one [scheme] already implies, so it can be left
  /// out of a URL.
  bool get usesDefaultPort => port == defaultPortFor(tls);

  String get baseUrl =>
      usesDefaultPort ? '$scheme://$host' : '$scheme://$host:$port';

  /// Resolve a relative bridge media path (e.g. `/media?id=…`) to a full URL.
  /// The token is never part of it: whoever fetches the URL sends
  /// [authHeaders] (`NetworkImage(headers:)`, the attachment opener), so it
  /// stays out of browser history, proxy logs and anything that prints URLs.
  String mediaUrl(String path) => '$baseUrl$path';

  /// The SSE URL. [deviceId] claims this device's mesh identity on the
  /// stream: the daemon delivers `device_command` frames — which carry
  /// one-time transfer tokens, exec command lines and file bodies — only to
  /// the client that claimed the target id, instead of to every connected
  /// device. Omitted for plain UI connections (nothing to address).
  ///
  /// No token here either: the stream is opened with [authHeaders], which
  /// every bridge since the first native release (#389) accepts on `/events`.
  String eventsUrl({String? deviceId}) => deviceId == null || deviceId.isEmpty
      ? '$baseUrl/events'
      : '$baseUrl/events?deviceId=${Uri.encodeQueryComponent(deviceId)}';

  Map<String, String> authHeaders([Map<String, String>? extra]) {
    final h = <String, String>{...?extra};
    final t = token;
    if (t != null && t.isNotEmpty) h['Authorization'] = 'Bearer $t';
    return h;
  }

  ConnectionConfig copyWith({
    String? host,
    int? port,
    String? token,
    bool clearToken = false,
    bool? tls,
    String? fingerprint,
    bool clearFingerprint = false,
    String? clientP12,
    String? clientP12Password,
    bool clearClientCert = false,
    String? localUrl,
    bool clearLocalUrl = false,
    bool? manageLocalDaemon,
    bool? localAutoDiscover,
    String? launchCommand,
    List<String>? launchArgs,
  }) =>
      ConnectionConfig(
        host: host ?? this.host,
        port: port ?? this.port,
        token: clearToken ? null : (token ?? this.token),
        tls: tls ?? this.tls,
        fingerprint:
            clearFingerprint ? null : (fingerprint ?? this.fingerprint),
        clientP12: clearClientCert ? null : (clientP12 ?? this.clientP12),
        clientP12Password: clearClientCert
            ? null
            : (clientP12Password ?? this.clientP12Password),
        localUrl: clearLocalUrl ? null : (localUrl ?? this.localUrl),
        manageLocalDaemon: manageLocalDaemon ?? this.manageLocalDaemon,
        localAutoDiscover: localAutoDiscover ?? this.localAutoDiscover,
        launchCommand: launchCommand ?? this.launchCommand,
        launchArgs: launchArgs ?? this.launchArgs,
      );

  Map<String, dynamic> toJson() => {
        'host': host,
        'port': port,
        'token': token,
        'tls': tls,
        'fingerprint': fingerprint,
        'clientP12': clientP12,
        'clientP12Password': clientP12Password,
        'localUrl': localUrl,
        'manageLocalDaemon': manageLocalDaemon,
        'localAutoDiscover': localAutoDiscover,
        'launchCommand': launchCommand,
        'launchArgs': launchArgs,
      };

  factory ConnectionConfig.fromJson(Map<String, dynamic> j) => ConnectionConfig(
        host: (j['host'] ?? '127.0.0.1') as String,
        port: (j['port'] ?? 19880) as int,
        token: j['token'] as String?,
        tls: (j['tls'] ?? false) as bool,
        fingerprint: normalizeFingerprint(j['fingerprint'] as String?),
        clientP12: j['clientP12'] as String?,
        clientP12Password: j['clientP12Password'] as String?,
        localUrl: j['localUrl'] as String?,
        manageLocalDaemon: (j['manageLocalDaemon'] ?? true) as bool,
        localAutoDiscover: (j['localAutoDiscover'] ?? true) as bool,
        launchCommand: (j['launchCommand'] ?? 'talon') as String,
        launchArgs: ((j['launchArgs'] as List?) ?? const ['start'])
            .map((e) => e.toString())
            .toList(),
      );

  /// Parsed result of a free-text "host" field.
  ///
  /// Users paste all sorts of things into a host box: a bare IP, `host:port`,
  /// a full `https://host:port/path` URL, or a value with stray whitespace or
  /// a trailing slash. Building `http://$host:$port` straight from that yields
  /// a malformed URL (e.g. `http://https://host:19880`) and the connection
  /// fails even though the endpoint is perfectly reachable — which reads as an
  /// app bug. [parseHostInput] normalizes any of those into a clean host, an
  /// optional embedded port, and a TLS hint from the scheme.
  static HostInput parseHostInput(String raw) {
    var s = raw.trim();
    if (s.isEmpty) return const HostInput(host: '');
    bool? tls;
    final schemeMatch = RegExp(r'^([a-zA-Z][a-zA-Z0-9+.-]*)://').firstMatch(s);
    if (schemeMatch != null) {
      final scheme = schemeMatch.group(1)!.toLowerCase();
      if (scheme == 'https' || scheme == 'wss') tls = true;
      if (scheme == 'http' || scheme == 'ws') tls = false;
      s = s.substring(schemeMatch.end);
    }
    // Drop any path/query/fragment — we only want authority.
    s = s.split('/').first.split('?').first.split('#').first.trim();
    int? port;
    // IPv6 in brackets: [::1]:1234
    final v6 = RegExp(r'^\[(.+)\](?::(\d+))?$').firstMatch(s);
    if (v6 != null) {
      s = v6.group(1)!;
      port = int.tryParse(v6.group(2) ?? '');
    } else {
      // host:port — but only when there's exactly one colon (not bare IPv6).
      final colon = s.indexOf(':');
      if (colon >= 0 && s.indexOf(':', colon + 1) == -1) {
        final maybePort = int.tryParse(s.substring(colon + 1));
        if (maybePort != null && maybePort >= 1 && maybePort <= 65535) {
          port = maybePort;
          s = s.substring(0, colon);
        }
      }
    }
    return HostInput(host: s.trim(), port: port, tls: tls);
  }

  /// Build a profile from a `talon://pair` link — the payload behind the
  /// daemon's `/mesh link`, opened from the pairing page or pasted in.
  ///
  /// The link carries the credentials themselves (`u` bridge URL, `t` token,
  /// `f` certificate fingerprint) rather than a grant to redeem: by the time
  /// it reaches the phone the daemon's single-use grant is already spent, and
  /// a link that needed one more round trip would fail on exactly the flaky
  /// first connection it exists to make painless.
  ///
  /// Anything can hand the app a link, so only a link that pins what it
  /// points at is usable:
  ///   - an `https` bridge must come with a well-formed certificate
  ///     fingerprint, which becomes the profile's pin;
  ///   - a plain `http` bridge (which has no certificate to pin) is accepted
  ///     only on a loopback or private-network address;
  ///   - the host must be a plain DNS name or IP literal, so what the
  ///     confirmation dialog shows is exactly what gets dialled.
  /// Any display name the link suggests (`n`) is ignored.
  ///
  /// Returns null for anything that isn't a usable pairing link, so a
  /// clipboard full of something else is a quiet no rather than a wrong
  /// profile silently replacing a working one.
  static ConnectionConfig? fromPairLink(String raw) {
    final uri = Uri.tryParse(raw.trim());
    if (uri == null) return null;
    if (uri.scheme.toLowerCase() != 'talon') return null;
    // Both `talon://pair?…` (host = pair) and `talon:pair?…` (path = pair)
    // reach here depending on which side built the link.
    final target = uri.host.isNotEmpty ? uri.host : uri.path;
    if (target.replaceAll('/', '') != 'pair') return null;
    final bridge = uri.queryParameters['u']?.trim() ?? '';
    if (bridge.isEmpty) return null;
    final parsed = parseHostInput(bridge);
    // An explicit scheme is required: guessing one would decide whether the
    // fingerprint rule or the private-address rule applies.
    final tls = parsed.tls;
    if (tls == null) return null;
    final host = parsed.host.toLowerCase();
    if (!isPlainHostName(host)) return null;
    final token = uri.queryParameters['t']?.trim() ?? '';
    String? fingerprint;
    if (tls) {
      fingerprint = normalizeFingerprint(uri.queryParameters['f']);
      if (fingerprint == null) return null;
    } else if (!isPrivateAddress(host)) {
      return null;
    }
    return ConnectionConfig(
      host: host,
      port: parsed.port ?? defaultPortFor(tls),
      token: token.isEmpty ? null : token,
      tls: tls,
      fingerprint: fingerprint,
      // A paired bridge is somewhere else by definition; never adopt it as a
      // daemon this device is supposed to launch and supervise.
      manageLocalDaemon: false,
      localAutoDiscover: false,
    );
  }

  /// True for a bare DNS name or IP literal: ASCII letters, digits, dots,
  /// hyphens (and colons for IPv6). Rejects anything a confirmation dialog
  /// could render misleadingly — userinfo, whitespace, percent-escapes,
  /// non-ASCII look-alikes, bidi controls.
  static bool isPlainHostName(String host) {
    if (host.isEmpty || host.length > 253) return false;
    if (host.contains(':')) {
      return RegExp(r'^[0-9a-f:.]+$').hasMatch(host) &&
          InternetAddress.tryParse(host) != null;
    }
    const label = r'[a-z0-9]([a-z0-9-]*[a-z0-9])?';
    return RegExp('^$label(\\.$label)*\$').hasMatch(host);
  }

  /// True when [host] is an IP literal on loopback, a private network
  /// (RFC 1918 / IPv6 unique-local) or link-local. Hostnames are never
  /// private here: what a name resolves to is decided by whoever answers
  /// the DNS query, not by the link.
  static bool isPrivateAddress(String host) {
    if (host == 'localhost') return true;
    final addr = InternetAddress.tryParse(host);
    if (addr == null) return false;
    if (addr.isLoopback || addr.isLinkLocal) return true;
    final b = addr.rawAddress;
    if (addr.type == InternetAddressType.IPv4) {
      return b[0] == 10 ||
          (b[0] == 172 && b[1] >= 16 && b[1] <= 31) ||
          (b[0] == 192 && b[1] == 168);
    }
    // IPv6 unique-local fc00::/7.
    return (b[0] & 0xfe) == 0xfc;
  }

  /// The whole fingerprint in AA:BB:… form, for a user to compare with the
  /// one the daemon prints (`talon status`).
  static String formatFingerprint(String fingerprint) {
    final hex = fingerprint.toUpperCase();
    return [
      for (var i = 0; i + 1 < hex.length; i += 2) hex.substring(i, i + 2),
    ].join(':');
  }

  /// Identity of the bridge this profile talks to, for per-bridge grants
  /// (see `Prefs.meshDeviceControl`): a grant given to one bridge never
  /// carries over to a profile pointed somewhere else.
  String get bridgeKey => '${host.toLowerCase()}:$port';

  /// First-run default tuned to the platform: desktop discovers local Talon;
  /// mobile starts in remote mode (the user supplies a host + token).
  factory ConnectionConfig.defaults() => ConnectionConfig(
        manageLocalDaemon: _desktopPlatform,
        localAutoDiscover: _desktopPlatform,
      );
}

/// Normalized pieces extracted from a free-text host field.
class HostInput {
  final String host;
  final int? port;
  final bool? tls;
  const HostInput({required this.host, this.port, this.tls});
}

bool get _desktopPlatform {
  try {
    return Platform.isWindows || Platform.isMacOS || Platform.isLinux;
  } catch (_) {
    return false; // web — treat as non-desktop
  }
}
