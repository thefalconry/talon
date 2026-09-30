import 'dart:async';
import 'dart:convert';
import 'dart:io' show HttpClient, X509Certificate;

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';

import '../models/bridge_models.dart';
import '../models/connection.dart';
import '../models/credentials.dart';
import 'bridge_trust.dart';
import 'log.dart';

/// Client for the Talon Client Bridge Protocol (v1).
///
/// REST for commands, a long-lived Server-Sent Events stream for everything the
/// daemon pushes. Transport-only: it parses frames and exposes typed futures +
/// a broadcast [events] stream. Reconnection/backoff lives in the caller
/// (AppState) so UI can reflect connection state.
///
/// TLS connections pin the bridge's certificate: the first connect adopts
/// whatever certificate it sees (the caller persists [seenFingerprint]);
/// every later connect requires the same one and fails with
/// [BridgeException.certificateChanged] otherwise.
class BridgeClient {
  /// Inter-chunk deadline for a streamed file transfer body.
  ///
  /// A half-open TCP connection — mobile NAT dropping a flow without a FIN
  /// is the everyday cause — delivers neither bytes nor an end-of-stream,
  /// so an untimed read of a transfer body waits forever. That matters
  /// beyond the transfer itself: [MeshService] answers the daemon's
  /// `download_file`/`upload_file` command only after the body finishes, so
  /// a read that never returns is a command the daemon never hears back
  /// about, and the tool call behind it hangs until its own timeout. Giving
  /// up here turns silence into a reported failure.
  static const Duration streamIdleTimeout = Duration(seconds: 45);

  /// Wall-clock budget for pushing [bytes] up (the `upload_file` half).
  /// Unlike a download there is no per-chunk event to watch — the response
  /// arrives only once the whole body is sent — so the deadline is sized
  /// to the payload at a deliberately pessimistic floor throughput, with
  /// grace on top for the handshake.
  static Duration uploadBudget(int bytes) => Duration(
        milliseconds: 30 * 1000 + (bytes / (32 * 1024) * 1000).round(),
      );

  ConnectionConfig _config;
  http.Client? _httpClient;

  /// The profile this client talks to. Swapping it (the background isolate
  /// hops between the LAN and the external address) rebuilds the REST
  /// client when the TLS setup it was built for no longer matches.
  ConnectionConfig get config => _config;
  set config(ConnectionConfig next) {
    final prev = _config;
    _config = next;
    if (next.tls != prev.tls ||
        next.clientP12 != prev.clientP12 ||
        next.clientP12Password != prev.clientP12Password) {
      _httpClient?.close();
      _httpClient = null;
    }
  }

  http.Client get _http => _httpClient ??= _newClient();

  final _events = StreamController<Map<String, dynamic>>.broadcast();
  StreamSubscription<String>? _sseSub;
  http.Client? _sseClient;
  bool _closed = false;

  String? _seenFingerprint;
  bool _pinRejected = false;

  /// This device's mesh id, when it has one. Claimed on the SSE GET so the
  /// daemon addresses `device_command` frames to this client alone, and sent
  /// with streamed transfers so the daemon can check a transfer token against
  /// the device it was minted for. Set before [connect]; a null id simply
  /// makes this a plain UI connection.
  String? meshDeviceId;

  BridgeClient(ConnectionConfig config, {this.skipKinds = const {}})
      : _config = config;

  /// Event kinds this client drops *before* JSON-decoding them. The
  /// background mesh isolate sets this to the chat-UI firehose (`delta`,
  /// `reasoning`, …) it never uses — otherwise both isolates parse every
  /// streamed token while the app is open (#1060).
  final Set<String> skipKinds;

  /// The `kind` of an SSE frame without decoding it, when it can be read
  /// cheaply: the daemon serialises every event with `kind` as its first
  /// key (`{"kind":"delta",…}`). Anything else returns null and is decoded
  /// normally, so an unexpected shape never loses an event.
  @visibleForTesting
  static String? peekKind(String raw) {
    const prefix = '{"kind":"';
    if (!raw.startsWith(prefix)) return null;
    final end = raw.indexOf('"', prefix.length);
    if (end < 0) return null;
    final kind = raw.substring(prefix.length, end);
    return kind.contains(r'\') ? null : kind;
  }

  /// Fingerprint of the certificate seen on the most recent TLS handshake —
  /// the pin candidate the caller persists after a successful first connect.
  String? get seenFingerprint => _seenFingerprint;

  /// How long an idle pooled connection is kept for reuse. dart:io's default
  /// is 15 s, shorter than the mesh's 60 s registration heartbeat, so every
  /// heartbeat paid a fresh DNS lookup, TCP connect and TLS handshake
  /// (~1000 of them in two days on one Mac). Outliving the heartbeat lets
  /// it ride one kept-alive connection wherever the server end (a reverse
  /// proxy, or the bridge's own keep-alive window) holds it open too; a
  /// connection the server has closed is dropped from the pool as soon as
  /// its FIN arrives, so nothing is sent on a dead socket.
  static const Duration restIdleTimeout = Duration(seconds: 90);

  http.Client _newClient() {
    // A reverse proxy in front of the bridge may demand a client
    // certificate; present the imported one whenever it's asked for. Server
    // trust is still the pin below.
    final inner = config.tls
        ? (HttpClient(context: config.clientSecurityContext())
          ..badCertificateCallback = (cert, host, port) => _evaluate(cert))
        : HttpClient();
    inner.idleTimeout = restIdleTimeout;
    return IOClient(inner);
  }

  /// Fires only for certificates the platform doesn't already trust (so
  /// CA-backed reverse proxies bypass it). No pin yet ⇒ trust on first use;
  /// pinned ⇒ exact fingerprint match or the handshake is refused.
  bool _evaluate(X509Certificate cert) {
    final seen = BridgeTrust.fingerprintOf(cert);
    _seenFingerprint = seen;
    final pinned = config.fingerprint;
    if (pinned == null || seen == pinned) return true;
    _pinRejected = true;
    return false;
  }

  /// Convert a refused-pin transport error into its real diagnosis.
  Never _rethrow(Object error, String fallback) {
    if (_pinRejected) {
      _pinRejected = false;
      throw BridgeException.certificateChanged();
    }
    if (isClientCertificateAlert(error)) {
      throw BridgeException.clientCertificateRequired(
        rejected: config.hasClientCert,
      );
    }
    throw BridgeException('$fallback: $error');
  }

  /// TLS alerts a reverse proxy sends when the handshake lacked an
  /// acceptable client certificate (Caddy, Traefik, HAProxy…).
  static bool isClientCertificateAlert(Object error) {
    final text = error.toString().toUpperCase();
    return text.contains('CERTIFICATE_REQUIRED') ||
        text.contains('ALERT_BAD_CERTIFICATE') ||
        text.contains('ALERT_UNKNOWN_CA') ||
        text.contains('ALERT_CERTIFICATE_UNKNOWN');
  }

  /// HTTP-level refusals by a proxy that wanted a client certificate:
  /// nginx answers 400 "No required SSL certificate was sent", Cloudflare's
  /// mTLS rule a 403 page (marked by cf-ray).
  static bool _proxyRefusedCertificate(http.Response res) {
    if (res.statusCode == 403 && res.headers.containsKey('cf-ray')) {
      return true;
    }
    return res.statusCode == 400 &&
        RegExp(r'SSL certificate', caseSensitive: false).hasMatch(res.body);
  }

  /// Decoded SSE payloads (`{kind: ...}` objects).
  Stream<Map<String, dynamic>> get events => _events.stream;

  Uri _u(String path, [Map<String, String>? q]) =>
      Uri.parse('${config.baseUrl}$path').replace(queryParameters: q);

  // ── Health / discovery ─────────────────────────────────────────────────────

  /// Probe `/health`. Returns the parsed body if it's a Talon bridge, else null.
  Future<Map<String, dynamic>?> health({Duration? timeout}) async {
    try {
      AppLog.debug('bridge', 'health probe ${config.baseUrl}');
      final res = await _http
          .get(_u('/health'))
          .timeout(timeout ?? const Duration(seconds: 4));
      AppLog.debug('bridge', 'health result ${res.statusCode}');
      if (_proxyRefusedCertificate(res)) {
        throw BridgeException.clientCertificateRequired(
          rejected: config.hasClientCert,
        );
      }
      if (res.statusCode != 200) return null;
      final body = _decodeObject(res.body);
      return body['app'] == 'talon-bridge' ? body : null;
    } on BridgeException {
      rethrow; // already a diagnosis (client certificate required)
    } catch (e) {
      AppLog.warn('bridge', 'health probe failed', e);
      if (_pinRejected) {
        _pinRejected = false;
        throw BridgeException.certificateChanged();
      }
      if (isClientCertificateAlert(e)) {
        throw BridgeException.clientCertificateRequired(
          rejected: config.hasClientCert,
        );
      }
      return null;
    }
  }

  /// Handshake with [config]'s bridge and report the certificate it
  /// presents, without sending any credential: the token is dropped from
  /// the probe's profile, and `/health` is the only request made. Any pin on
  /// [config] is ignored too, so the certificate is always observed.
  ///
  /// The manual-entry path uses this to show the fingerprint for the user
  /// to confirm before the token goes anywhere.
  static Future<CertificateProbe> probeCertificate(
    ConnectionConfig config, {
    Duration timeout = const Duration(seconds: 6),
  }) async {
    final probe = BridgeClient(
      config.copyWith(clearToken: true, clearFingerprint: true),
    );
    try {
      final h = await probe.health(timeout: timeout);
      return CertificateProbe(
        fingerprint: probe.seenFingerprint,
        reached: h != null,
      );
    } on BridgeException {
      // A proxy demanding a client certificate still answered; the connect
      // that follows reports that properly.
      return CertificateProbe(
        fingerprint: probe.seenFingerprint,
        reached: true,
      );
    } finally {
      probe.dispose();
    }
  }

  // ── Per-device credentials ─────────────────────────────────────────────────

  /// `GET /auth/whoami` — which credential this connection uses and whether
  /// the daemon wants it upgraded or rotated. Null when the daemon predates
  /// per-device credentials (the route answers 404).
  Future<CredentialStatus?> whoami() async {
    final res = await _http
        .get(_u('/auth/whoami'), headers: config.authHeaders())
        .timeout(const Duration(seconds: 12));
    if (res.statusCode == 404) return null;
    return CredentialStatus.fromJson(_decode(res));
  }

  /// The `POST /auth/upgrade` body a companion sends: its mesh device id and
  /// the scopes it needs (the mesh + the chat UI). The daemon caps the grant
  /// by its `native.companionScopes` policy.
  static Map<String, dynamic> upgradeRequestBody(String deviceId) => {
        'deviceId': deviceId,
        'client': 'companion',
        'scopes': const ['device', 'client'],
      };

  /// Trade the current bearer (shared token, or this device's credential
  /// when rotating) for a per-device credential bound to [deviceId].
  Future<CredentialGrant> upgradeCredential(String deviceId) async =>
      CredentialGrant.fromJson(
        await _postJson('/auth/upgrade', upgradeRequestBody(deviceId)),
      );

  // ── SSE stream ──────────────────────────────────────────────────────────────

  /// Open the event stream. Completes once the response headers arrive (i.e.
  /// the connection is live); individual events flow through [events].
  Future<void> connect({Duration timeout = const Duration(seconds: 10)}) async {
    await _sseSub?.cancel();
    _sseClient?.close();
    final client = _newClient();
    _sseClient = client;

    final req = http.Request(
      'GET',
      Uri.parse(config.eventsUrl(deviceId: meshDeviceId)),
    )
      ..headers['Accept'] = 'text/event-stream'
      ..headers.addAll(config.authHeaders());

    AppLog.info('bridge', 'opening event stream ${config.host}:${config.port}');
    late http.StreamedResponse res;
    try {
      res = await client.send(req).timeout(timeout);
    } on TimeoutException catch (e) {
      client.close();
      if (identical(_sseClient, client)) _sseClient = null;
      AppLog.warn('bridge', 'event stream connect timed out', e);
      throw BridgeException(
        'Timed out connecting to event stream after ${timeout.inSeconds}s',
      );
    } catch (e) {
      client.close();
      if (identical(_sseClient, client)) _sseClient = null;
      AppLog.warn('bridge', 'event stream connect failed', e);
      _rethrow(e, 'Could not connect to event stream');
    }
    if (res.statusCode != 200) {
      client.close();
      if (identical(_sseClient, client)) _sseClient = null;
      AppLog.warn('bridge', 'event stream rejected ${res.statusCode}');
      if (res.statusCode == 401) {
        throw BridgeException.unauthorized();
      }
      throw BridgeException('Event stream rejected (${res.statusCode})');
    }

    AppLog.info('bridge', 'event stream open');
    final buffer = StringBuffer();
    _sseSub = res.stream
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(
      (line) {
        if (line.startsWith(':')) return; // keep-alive comment
        if (line.isEmpty) {
          _flush(buffer);
          return;
        }
        if (line.startsWith('data:')) {
          buffer.writeln(line.substring(5).trimLeft());
        }
      },
      onError: (Object e) {
        AppLog.warn('bridge', 'event stream error', e);
        // dispose() closes the controller before the socket subscription is
        // fully torn down — a late transport error must not throw into it.
        if (!_closed) _events.addError(e);
      },
      onDone: () {
        if (!_closed) {
          AppLog.warn('bridge', 'event stream closed');
          _events.addError(BridgeException('Stream closed'));
        }
      },
      cancelOnError: true,
    );
  }

  void _flush(StringBuffer buffer) {
    final raw = buffer.toString().trim();
    buffer.clear();
    if (raw.isEmpty || _closed) return;
    if (skipKinds.isNotEmpty) {
      final kind = peekKind(raw);
      if (kind != null && skipKinds.contains(kind)) return;
    }
    try {
      final obj = _decodeObject(raw);
      _events.add(obj);
    } catch (e) {
      AppLog.debug('bridge', 'ignored malformed event frame', e);
      /* ignore malformed frame */
    }
  }

  // ── REST commands ──────────────────────────────────────────────────────────

  Future<List<ClientChat>> listChats() async {
    final j = await _getJson('/chats');
    return _list(j['chats']).map((c) => ClientChat.fromJson(_map(c))).toList();
  }

  Future<ClientChat> createChat([String? title]) async {
    final j = await _postJson('/chats', {if (title != null) 'title': title});
    return ClientChat.fromJson(_map(j['chat']));
  }

  Future<void> renameChat(String chatId, String title) =>
      _postJson('/chats/rename', {'chatId': chatId, 'title': title});

  Future<void> deleteChat(String chatId) =>
      _postJson('/chats/delete', {'chatId': chatId});

  Future<void> resetChat(String chatId) =>
      _postJson('/chats/reset', {'chatId': chatId});

  /// Best-effort interrupt of the chat's in-flight turn. Returns whether the
  /// daemon found a running turn to signal.
  Future<bool> interruptTurn(String chatId) async {
    final j = await _postJson('/chats/interrupt', {'chatId': chatId});
    return j['ok'] == true;
  }

  Future<void> registerDevice(Map<String, dynamic> device) =>
      _postJson('/devices/register', device);

  Future<void> postLocation(Map<String, dynamic> location) =>
      _postJson('/location', location);

  /// Answer a `device_command` SSE event (ring, open_url, clipboard, …).
  Future<void> postCommandResult(Map<String, dynamic> result) =>
      _postJson('/devices/command-result', result);

  /// Stream a file's bytes up as ONE raw HTTP request — the `upload_file`
  /// half of a streamed pull transfer. No base64, no per-chunk round trips;
  /// runs at TCP throughput. Returns bytes sent.
  Future<int> uploadFile(
    String token,
    Stream<List<int>> bytes,
    int length, {
    Duration? budget,
  }) async {
    final deadline = budget ?? uploadBudget(length);
    final req = http.StreamedRequest(
      'POST',
      _u('/devices/file', {
        'transfer': token,
        if (meshDeviceId != null) 'deviceId': meshDeviceId!,
      }),
    )
      ..headers.addAll(config.authHeaders())
      ..headers['Content-Type'] = 'application/octet-stream'
      ..contentLength = length;
    var sent = 0;
    unawaited(() async {
      try {
        await for (final chunk in bytes) {
          req.sink.add(chunk);
          sent += chunk.length;
        }
        await req.sink.close();
      } catch (e) {
        req.sink.addError(e);
      }
    }());
    final res = await _http.send(req).timeout(
          deadline,
          onTimeout: () => throw BridgeException(
            'Upload stalled: no response within ${deadline.inSeconds}s '
            'after $sent of $length bytes.',
          ),
        );
    final body = await res.stream.bytesToString().timeout(
          streamIdleTimeout,
          onTimeout: () => throw BridgeException(
            'Upload stalled: no response body within '
            '${streamIdleTimeout.inSeconds}s.',
          ),
        );
    if (res.statusCode != 200) {
      throw BridgeException(
        'Upload rejected (${res.statusCode}): '
        '${body.isEmpty ? 'no detail' : body}',
      );
    }
    return sent;
  }

  /// Stream a push transfer's file body down as ONE raw HTTP response —
  /// the `download_file` half. Feeds chunks to [onChunk]; returns bytes
  /// received (validated against Content-Length when present).
  Future<int> downloadFile(
    String token,
    Future<void> Function(List<int> chunk) onChunk, {
    Duration? idleTimeout,
  }) async {
    final idle = idleTimeout ?? streamIdleTimeout;
    final req = http.Request(
      'GET',
      _u('/devices/file', {
        'transfer': token,
        if (meshDeviceId != null) 'deviceId': meshDeviceId!,
      }),
    )..headers.addAll(config.authHeaders());
    final res = await _http.send(req).timeout(
          idle,
          onTimeout: () => throw BridgeException(
            'Download stalled: no response headers within ${idle.inSeconds}s.',
          ),
        );
    if (res.statusCode != 200) {
      final body = await res.stream.bytesToString();
      throw BridgeException(
        'Download rejected (${res.statusCode}): '
        '${body.isEmpty ? 'no detail' : body}',
      );
    }
    var received = 0;
    // `timeout` on a stream is an INTER-EVENT deadline, so a slow but live
    // transfer is never cut off — only one that stops delivering. Without
    // it a half-open connection (mobile NAT dropping the flow without a
    // FIN) leaves this loop waiting forever, and the caller never answers
    // the daemon's `download_file` command at all.
    await for (final chunk in res.stream.timeout(
      idle,
      onTimeout: (sink) => sink.addError(
        BridgeException(
          'Download stalled: no data for ${idle.inSeconds}s '
          'after $received bytes.',
        ),
      ),
    )) {
      received += chunk.length;
      await onChunk(chunk);
    }
    final expected = res.contentLength;
    if (expected != null && expected != received) {
      throw BridgeException(
        'Download truncated: got $received of $expected bytes.',
      );
    }
    return received;
  }

  Future<(List<DeviceInfo> devices, List<DeviceLocation> locations)>
      devices() async {
    final j = await _getJson('/devices');
    return (
      _list(j['devices'])
          .map((d) => DeviceInfo.fromJson(_map(d)))
          .where((d) => d.id.isNotEmpty)
          .toList(),
      _list(j['locations'])
          .map((l) => DeviceLocation.fromJson(_map(l)))
          .where((l) => l.deviceId.isNotEmpty)
          .toList(),
    );
  }

  /// Set/replace/clear the chat's queued follow-up (empty text clears). The
  /// daemon broadcasts the change to every client via chat_updated.
  Future<void> queue(String chatId, String text) =>
      _postJson('/queue', {'chatId': chatId, 'text': text});

  Future<ConfigSnapshot> getConfig() async =>
      ConfigSnapshot.fromJson(await _getJson('/config'));

  Future<ConfigSnapshot> setConfig(Map<String, dynamic> update) async =>
      ConfigSnapshot.fromJson(await _postJson('/config', update));

  /// Newest daemon log entries (oldest first). [level] is a minimum severity
  /// (e.g. "warn" returns warn+error+fatal); [component] an exact subsystem tag.
  Future<List<DaemonLogEntry>> logs({
    int lines = 300,
    String? level,
    String? component,
  }) async {
    final j = await _getJson('/logs', {
      'lines': '$lines',
      if (level != null) 'level': level,
      if (component != null) 'component': component,
    });
    return _list(j['entries'])
        .map((e) => DaemonLogEntry.fromJson(_map(e)))
        .toList();
  }

  /// Fire a daemon-level control action ("restart", "dream"). Returns the
  /// daemon's ok/message result (never throws on an application-level failure —
  /// the server answers 200 with `ok:false`).
  Future<({bool ok, String message})> control(String action) async {
    final j = await _postJson('/control', {'action': action});
    return (
      ok: j['ok'] == true,
      message: j['message'] is String ? j['message'] as String : '',
    );
  }

  /// Installed plugins with their enabled state (`plugins-skills` capability).
  Future<List<PluginInfo>> listPlugins() async {
    final j = await _getJson('/plugins');
    return _list(j['plugins'])
        .map((p) => PluginInfo.fromJson(_map(p)))
        .toList();
  }

  /// Enable/disable a plugin. The daemon persists and hot-reloads; `ok`
  /// is the application outcome (always HTTP 200, mirroring `/backend`).
  Future<({bool ok, String? error})> togglePlugin(
    String name,
    bool enabled,
  ) async {
    final j = await _postJson('/plugins/toggle', {
      'name': name,
      'enabled': enabled,
    });
    return (
      ok: j['ok'] == true,
      error: j['error'] is String ? j['error'] as String : null,
    );
  }

  /// Installed skills with their enabled state (`plugins-skills` capability).
  Future<List<SkillInfo>> listSkills() async {
    final j = await _getJson('/skills');
    return _list(j['skills']).map((s) => SkillInfo.fromJson(_map(s))).toList();
  }

  /// Enable/disable a skill (drops it from / restores it to the prompt index).
  Future<({bool ok, String? error})> toggleSkill(
    String name,
    bool enabled,
  ) async {
    final j = await _postJson('/skills/toggle', {
      'name': name,
      'enabled': enabled,
    });
    return (
      ok: j['ok'] == true,
      error: j['error'] is String ? j['error'] as String : null,
    );
  }

  /// A page of history: the newest window by default, or — when [before] is
  /// given — the window of messages strictly older than that message id.
  Future<List<ClientMessage>> history(
    String chatId, {
    int? before,
    int? limit,
  }) async {
    final j = await _getJson('/history', {
      'chatId': chatId,
      if (before != null) 'before': '$before',
      if (limit != null) 'limit': '$limit',
    });
    return _list(
      j['messages'],
    ).map((m) => ClientMessage.fromJson(_map(m))).toList();
  }

  /// Full-text search across chats (or one chat when [chatId] is given).
  Future<List<SearchHit>> search(String query, {String? chatId}) async {
    final j = await _getJson('/search', {
      'q': query,
      if (chatId != null) 'chatId': chatId,
    });
    return _list(j['results']).map((r) => SearchHit.fromJson(_map(r))).toList();
  }

  /// Send a message, optionally carrying files already uploaded with
  /// [uploadAttachment]. Only the identifying fields go up: the daemon
  /// resolves each reference against what it actually wrote to disk.
  Future<void> send(
    String chatId,
    String text, {
    List<Attachment> attachments = const [],
  }) =>
      _postJson('/send', {
        'chatId': chatId,
        'text': text,
        if (attachments.isNotEmpty)
          'attachments': attachments.map((a) => a.toRef()).toList(),
      });

  /// Stream a file up to the bridge as one raw request — no base64, no
  /// buffering the whole thing in memory, so a large archive costs a socket
  /// rather than the heap. [onProgress] reports bytes sent against [length].
  ///
  /// Returns the daemon's record of the upload: its on-disk path, the
  /// relative bridge path the bytes are served from, and the name/size/type
  /// the daemon assigned.
  Future<Attachment> uploadAttachment(
    Stream<List<int>> bytes,
    int length,
    String filename,
    String contentType, {
    void Function(int sent)? onProgress,
  }) async {
    final req = http.StreamedRequest('POST', _u('/upload', {
      'filename': filename,
    }))
      ..headers.addAll(config.authHeaders())
      ..headers['Content-Type'] = contentType
      ..contentLength = length;
    var sent = 0;
    unawaited(() async {
      try {
        await for (final chunk in bytes) {
          req.sink.add(chunk);
          sent += chunk.length;
          onProgress?.call(sent);
        }
        await req.sink.close();
      } catch (e) {
        req.sink.addError(e);
      }
    }());
    final streamed = await _http.send(req);
    final body = await streamed.stream.bytesToString();
    if (streamed.statusCode != 200) {
      throw BridgeException(_uploadError(streamed.statusCode, body));
    }
    final decoded = jsonDecode(body);
    return Attachment.fromJson(
      decoded is Map<String, dynamic> ? decoded : <String, dynamic>{},
    );
  }

  /// The daemon explains a rejected upload (too large, disk error) in the
  /// body; surface that rather than a bare status code.
  static String _uploadError(int status, String body) {
    try {
      final j = jsonDecode(body);
      if (j is Map && j['error'] is String) return j['error'] as String;
    } catch (_) {
      /* not JSON — fall through to the generic form */
    }
    return 'Upload rejected ($status)${body.isEmpty ? '' : ': $body'}';
  }

  Future<(String active, List<ModelOption> models)> models([
    String? chatId,
  ]) async {
    final j = await _getJson('/models', {
      if (chatId != null) 'chatId': chatId,
    });
    final list = _list(
      j['models'],
    ).map((m) => ModelOption.fromJson(_map(m))).toList();
    return (j['active']?.toString() ?? '', list);
  }

  Future<void> setModel(String chatId, String model) =>
      _postJson('/model', {'chatId': chatId, 'model': model});

  Future<(String active, List<BackendOption> backends)> backends(
    String chatId,
  ) async {
    final j = await _getJson('/backends', {'chatId': chatId});
    final list = _list(
      j['backends'],
    ).map((b) => BackendOption.fromJson(_map(b))).toList();
    return (j['active']?.toString() ?? '', list);
  }

  /// Switch a chat's backend. Returns the daemon's application result so the
  /// caller can surface an error (e.g. "Backend not available") without the
  /// request throwing.
  Future<({bool ok, String? error})> setBackend(
    String chatId,
    String backend,
  ) async {
    final j = await _postJson('/backend', {
      'chatId': chatId,
      'backend': backend,
    });
    return (ok: j['ok'] == true, error: j['error']?.toString());
  }

  Future<void> setEffort(String chatId, String effort) =>
      _postJson('/effort', {'chatId': chatId, 'effort': effort});

  Future<(String active, List<String> levels)> effortLevels(
    String chatId,
  ) async {
    final j = await _getJson('/effort', {'chatId': chatId});
    return (
      j['active']?.toString() ?? 'adaptive',
      _list(j['levels']).map((e) => e.toString()).toList(),
    );
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  Future<Map<String, dynamic>> _getJson(
    String path, [
    Map<String, String>? q,
  ]) async {
    try {
      final res = await _http
          .get(_u(path, q), headers: config.authHeaders())
          .timeout(const Duration(seconds: 12));
      return _decode(res);
    } catch (e) {
      AppLog.warn('bridge', 'GET $path failed', e);
      rethrow;
    }
  }

  Future<Map<String, dynamic>> _postJson(
    String path,
    Map<String, dynamic> body,
  ) async {
    try {
      final res = await _http
          .post(
            _u(path),
            headers: config.authHeaders({'Content-Type': 'application/json'}),
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 12));
      return _decode(res);
    } catch (e) {
      AppLog.warn('bridge', 'POST $path failed', e);
      rethrow;
    }
  }

  Map<String, dynamic> _decode(http.Response res) {
    if (res.statusCode == 401) throw BridgeException.unauthorized();
    if (res.statusCode >= 400) {
      throw BridgeException('Request failed (${res.statusCode})');
    }
    if (res.body.isEmpty) return const {};
    return _decodeObject(res.body);
  }

  static Map<String, dynamic> _decodeObject(String raw) {
    final decoded = jsonDecode(raw);
    if (decoded is! Map) throw const FormatException('Expected JSON object');
    return decoded.cast<String, dynamic>();
  }

  static Map<String, dynamic> _map(Object? value) =>
      value is Map ? value.cast<String, dynamic>() : const {};

  static List<dynamic> _list(Object? value) =>
      value is List ? value : const <dynamic>[];

  void dispose() {
    _closed = true;
    AppLog.info('bridge', 'disconnect');
    _sseSub?.cancel();
    _sseClient?.close();
    _httpClient?.close();
    _events.close();
  }
}

/// What [BridgeClient.probeCertificate] saw.
class CertificateProbe {
  /// SHA-256 of the certificate the server presented, when the platform did
  /// not already trust it (a bridge's own self-signed certificate). Null
  /// for a certificate that chains to a trusted CA, or when no TLS
  /// handshake happened at all.
  final String? fingerprint;

  /// Whether a Talon bridge (or a proxy in front of one) answered.
  final bool reached;

  const CertificateProbe({this.fingerprint, required this.reached});
}

class BridgeException implements Exception {
  final String message;
  final bool unauthorized;
  final bool certificateChanged;

  /// A reverse proxy refused the connection for want of a (valid) client
  /// certificate. Never heals by retrying — the user has to import one.
  final bool clientCertificateRequired;

  /// [message] often embeds a lower-level error whose text quotes the full
  /// request URL (token included); it is redacted before it is stored.
  BridgeException(String message)
      : message = redactSecrets(message),
        unauthorized = false,
        certificateChanged = false,
        clientCertificateRequired = false;
  BridgeException.unauthorized()
      : message = 'Unauthorized — check your token',
        unauthorized = true,
        certificateChanged = false,
        clientCertificateRequired = false;
  BridgeException.certificateChanged()
      : message = "The bridge's certificate no longer matches the pinned "
            'fingerprint. If Talon was reinstalled, clear the pinned '
            'fingerprint in connection settings and reconnect.',
        unauthorized = false,
        certificateChanged = true,
        clientCertificateRequired = false;
  BridgeException.clientCertificateRequired({bool rejected = false})
      : message = rejected
            ? "The server didn't accept this device's client certificate. "
                'Import a valid one in connection settings.'
            : 'This server requires a client certificate. Import one in '
                'connection settings (Import certificate).',
        unauthorized = false,
        certificateChanged = false,
        clientCertificateRequired = true;
  @override
  String toString() => message;
}
