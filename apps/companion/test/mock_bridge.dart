import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

class MockBridge {
  MockBridge({
    this.token,
    this.healthDelay = Duration.zero,
    this.healthStatus = 200,
    this.healthApp = 'talon-bridge',
  });

  final String? token;
  final Duration healthDelay;
  final int healthStatus;
  final String healthApp;

  late final HttpServer _server;
  late final int _port;
  final List<_SseClient> _streams = [];
  /// Chat ids the client asked to delete, in order — lets a test assert the
  /// app cleaned up after itself.
  final List<String> deletedChats = [];

  final List<Map<String, dynamic>> chats = [
    {
      'id': 'c1',
      'title': 'General',
      'createdAt': 1,
      'lastActive': 2,
      'preview': 'Hello',
      'model': 'm1',
      'effort': 'adaptive',
      'pulse': false,
    },
  ];
  final Map<String, List<Map<String, dynamic>>> messages = {
    'c1': [
      {'id': 'm1', 'chatId': 'c1', 'role': 'user', 'text': 'Hello', 'ts': 10},
    ],
  };
  Map<String, dynamic> config = {
    'backend': 'test',
    'frontend': 'desktop',
    'model': 'm1',
    'modelDisplay': 'Model One',
    'botDisplayName': 'Talon',
    'timezone': 'UTC',
    'pulse': false,
    'pulseIntervalMs': 300000,
    'heartbeat': false,
    'heartbeatIntervalMinutes': 60,
    'dream': false,
    'editable': ['model', 'pulse'],
    'health': {
      'healthy': true,
      'uptimeMs': 100,
      'sessions': 1,
      'messages': 2,
      'memoryMb': 64,
    },
  };
  String activeModel = 'm1';
  String activeEffort = 'adaptive';

  /// Status code POST /config answers with — set non-200 to inject a
  /// config-update failure.
  int configPostStatus = 200;
  final List<Map<String, dynamic>> devices = [];
  final List<Map<String, dynamic>> locations = [];
  final List<Map<String, dynamic>> commandResults = [];

  /// Streamed-transfer state: tokens accepted for upload, captured upload
  /// bodies (keyed by token), and bodies to serve for download tokens.
  final Set<String> uploadTokens = {};
  final Map<String, List<int>> uploadedFiles = {};
  final Map<String, List<int>> downloadFiles = {};

  /// Tokens whose GET answers with headers and a first slice of body, then
  /// never sends the rest and never closes — a half-open connection, which
  /// is what a mobile NAT timeout looks like to the client.
  final Map<String, List<int>> stalledDownloads = {};

  /// When set, [downloadFiles] bodies are served in slices of this many
  /// bytes with [downloadSliceGap] between them — a transfer that is slow
  /// but alive, as opposed to one that has stopped.
  int downloadSliceBytes = 0;
  Duration downloadSliceGap = Duration.zero;

  /// Per-device credentials (#1042): when on, `/auth/whoami` and
  /// `/auth/upgrade` behave like a daemon offering the in-band upgrade; when
  /// off they 404, like a daemon that predates it.
  bool issueCredentials = false;

  /// When on, `/auth/whoami` asks a per-device credential to rotate.
  bool requestRotation = false;

  /// Credentials this mock minted — accepted as bearers alongside [token].
  final List<String> issuedCredentials = [];

  /// Every `/auth/upgrade` body, in order.
  final List<Map<String, dynamic>> upgradeRequests = [];

  /// The URL and Authorization header of every `/events` request, in order.
  final List<(Uri, String?)> eventRequests = [];

  /// The bearer of every authenticated request, in order.
  final List<String?> bearers = [];

  int get port => _port;
  String get host => '127.0.0.1';
  Uri get uri => Uri.parse('http://$host:$port');
  int get streamCount => _streams.length;

  static Future<MockBridge> start({
    String? token,
    Duration healthDelay = Duration.zero,
    int healthStatus = 200,
    String healthApp = 'talon-bridge',
  }) async {
    final bridge = MockBridge(
      token: token,
      healthDelay: healthDelay,
      healthStatus: healthStatus,
      healthApp: healthApp,
    );
    bridge._server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    bridge._port = bridge._server.port;
    unawaited(bridge._server.listen(bridge._handle).asFuture<void>());
    return bridge;
  }

  Future<void> close() async {
    for (final stream in List<_SseClient>.from(_streams)) {
      await stream.close();
    }
    await _server.close(force: true);
  }

  Future<void> emit(Map<String, dynamic> event) async {
    final frame = 'data: ${jsonEncode(event)}\n\n';
    for (final stream in List<_SseClient>.from(_streams)) {
      stream.write(frame);
    }
  }

  Future<void> writeRaw(String raw) async {
    for (final stream in List<_SseClient>.from(_streams)) {
      stream.write(raw);
    }
  }

  Future<void> closeStreams() async {
    for (final stream in List<_SseClient>.from(_streams)) {
      await stream.close();
    }
    _streams.clear();
  }

  Future<void> _handle(HttpRequest req) async {
    final path = req.uri.path;
    if (req.method == 'GET' && path == '/health') {
      if (healthDelay > Duration.zero) await Future<void>.delayed(healthDelay);
      return _json(req.response, healthStatus, {
        ..._status(),
        'app': healthApp,
        'ok': true,
        'protocol': 1,
        'host': host,
        'port': port,
        'authRequired': token != null,
      });
    }

    if (!_authOk(req)) {
      return _json(req.response, 401, {'ok': false, 'error': 'Unauthorized'});
    }
    final bearer = _bearer(req);
    bearers.add(bearer);

    if (issueCredentials && req.method == 'GET' && path == '/auth/whoami') {
      if (bearer == token) {
        return _json(req.response, 200, {
          'ok': true,
          'kind': 'shared',
          'scopes': ['device', 'client', 'operator'],
          'action': 'upgrade',
        });
      }
      return _json(req.response, 200, {
        'ok': true,
        'kind': 'device',
        'scopes': ['device', 'client'],
        'credentialId': bearer?.split('.')[1],
        'deviceId': 'mock-device',
        if (requestRotation) 'action': 'rotate',
      });
    }
    if (issueCredentials && req.method == 'POST' && path == '/auth/upgrade') {
      final body = await _readJson(req);
      upgradeRequests.add(body);
      final n = issuedCredentials.length + 1;
      final id = n.toRadixString(16).padLeft(16, '0');
      final credential = 'tdc1.$id.${'x' * 42}${n % 10}';
      issuedCredentials.add(credential);
      requestRotation = false;
      return _json(req.response, 200, {
        'ok': true,
        'token': credential,
        'credentialId': id,
        'deviceId': body['deviceId'],
        'scopes': ['device', 'client'],
      });
    }

    if (req.method == 'GET' && path == '/events') {
      eventRequests.add(
        (req.uri, req.headers.value(HttpHeaders.authorizationHeader)),
      );
      return _openStream(req);
    }
    if (req.method == 'GET' && path == '/chats') {
      return _json(req.response, 200, {'chats': chats});
    }
    if (req.method == 'POST' && path == '/chats') {
      final body = await _readJson(req);
      final id = 'c${chats.length + 1}';
      final chat = {
        'id': id,
        'title': body['title']?.toString() ?? 'New chat',
        'createdAt': 3,
        'lastActive': 3,
        'preview': '',
      };
      chats.add(chat);
      messages[id] = [];
      unawaited(emit({'kind': 'chat_created', 'chat': chat}));
      return _json(req.response, 200, {'chat': chat});
    }
    if (req.method == 'POST' && path == '/chats/delete') {
      final body = await _readJson(req);
      final id = body['chatId']?.toString() ?? '';
      final existed = chats.any((c) => c['id'] == id);
      chats.removeWhere((c) => c['id'] == id);
      messages.remove(id);
      if (existed) {
        deletedChats.add(id);
        unawaited(emit({'kind': 'chat_deleted', 'chatId': id}));
      }
      return _json(req.response, 200, {'ok': existed});
    }
    if (req.method == 'GET' && path == '/history') {
      final chatId = req.uri.queryParameters['chatId'] ?? '';
      final before = int.tryParse(req.uri.queryParameters['before'] ?? '');
      final limit = int.tryParse(req.uri.queryParameters['limit'] ?? '') ?? 200;
      var list = messages[chatId] ?? const <Map<String, dynamic>>[];
      if (before != null) {
        list = list
            .where((m) => (int.tryParse('${m['id']}') ?? 0) < before)
            .toList();
      }
      if (list.length > limit) list = list.sublist(list.length - limit);
      return _json(req.response, 200, {
        'chatId': chatId,
        'messages': list,
      });
    }
    if (req.method == 'GET' && path == '/search') {
      final q = (req.uri.queryParameters['q'] ?? '').toLowerCase();
      final results = <Map<String, dynamic>>[];
      messages.forEach((chatId, list) {
        for (final m in list) {
          if ('${m['text']}'.toLowerCase().contains(q)) {
            results.add({
              'chatId': chatId,
              'chatTitle': chats.firstWhere(
                (c) => c['id'] == chatId,
                orElse: () => {'title': ''},
              )['title'],
              'message': m,
            });
          }
        }
      });
      return _json(req.response, 200, {'results': results});
    }
    if (req.method == 'POST' && path == '/send') {
      final body = await _readJson(req);
      final chatId = body['chatId']?.toString() ?? '';
      final text = body['text']?.toString() ?? '';
      if (chatId.isEmpty || text.isEmpty) {
        return _json(req.response, 400, {'ok': false, 'error': 'bad send'});
      }
      messages.putIfAbsent(chatId, () => []).add({
        'id': 'm${DateTime.now().microsecondsSinceEpoch}',
        'chatId': chatId,
        'role': 'user',
        'text': text,
        'ts': 20,
      });
      return _json(req.response, 202, {'ok': true});
    }
    if (req.method == 'POST' && path == '/devices/register') {
      final body = await _readJson(req);
      devices.removeWhere((d) => d['id'] == body['id']);
      devices.add({
        ...body,
        'online': true,
        'lastSeen': DateTime.now().millisecondsSinceEpoch,
      });
      return _json(req.response, 200, {
        'ok': true,
        'deviceId': body['id'],
      });
    }
    if (req.method == 'POST' && path == '/location') {
      final body = await _readJson(req);
      locations.removeWhere((l) => l['deviceId'] == body['deviceId']);
      locations.add(body);
      return _json(req.response, 200, {'ok': true});
    }
    if (req.method == 'GET' && path == '/devices') {
      return _json(req.response, 200, {
        'devices': devices,
        'locations': locations,
      });
    }
    if (req.method == 'POST' && path == '/devices/command-result') {
      commandResults.add(await _readJson(req));
      return _json(req.response, 200, {'ok': true});
    }
    // Streamed transfer routes — mirror the daemon's /devices/file contract.
    if (path == '/devices/file') {
      final t = req.uri.queryParameters['transfer'] ?? '';
      if (req.method == 'POST') {
        if (!uploadTokens.contains(t)) {
          return _json(req.response, 409, {'ok': false, 'error': 'bad token'});
        }
        uploadTokens.remove(t);
        final chunks = <int>[];
        await for (final chunk in req) {
          chunks.addAll(chunk);
        }
        uploadedFiles[t] = chunks;
        return _json(req.response, 200, {'ok': true, 'bytes': chunks.length});
      }
      if (req.method == 'GET') {
        final stalled = stalledDownloads[t];
        if (stalled != null) {
          stalledDownloads.remove(t);
          final res = req.response;
          res.statusCode = 200;
          res.headers.contentType = ContentType.binary;
          // Promise more than we send, then go quiet without closing.
          res.headers.contentLength = stalled.length * 2;
          res.add(stalled);
          await res.flush();
          return;
        }
        final body = downloadFiles[t];
        if (body == null) {
          return _json(req.response, 404, {'ok': false, 'error': 'bad token'});
        }
        downloadFiles.remove(t);
        final res = req.response;
        res.statusCode = 200;
        res.headers.contentType = ContentType.binary;
        res.headers.contentLength = body.length;
        if (downloadSliceBytes > 0) {
          for (var i = 0; i < body.length; i += downloadSliceBytes) {
            res.add(body.sublist(
              i,
              math.min(i + downloadSliceBytes, body.length),
            ));
            await res.flush();
            if (downloadSliceGap > Duration.zero) {
              await Future<void>.delayed(downloadSliceGap);
            }
          }
          await res.close();
          return;
        }
        res.add(body);
        unawaited(res.close());
        return;
      }
    }
    if (req.method == 'GET' && path == '/config') {
      return _json(req.response, 200, config);
    }
    if (req.method == 'POST' && path == '/config') {
      if (configPostStatus != 200) {
        return _json(req.response, configPostStatus, {'error': 'injected'});
      }
      config = {...config, ...await _readJson(req)};
      return _json(req.response, 200, config);
    }
    if (req.method == 'GET' && path == '/models') {
      return _json(req.response, 200, {
        'active': activeModel,
        'models': [
          {
            'id': 'm1',
            'displayName': 'Model One',
            'provider': 'test',
            'reasoning': true,
          },
        ],
      });
    }
    if (req.method == 'POST' && path == '/model') {
      activeModel = (await _readJson(req))['model']?.toString() ?? activeModel;
      return _json(req.response, 200, {'ok': true});
    }
    if (req.method == 'GET' && path == '/effort') {
      return _json(req.response, 200, {
        'active': activeEffort,
        'levels': ['adaptive', 'low', 'high'],
      });
    }
    if (req.method == 'POST' && path == '/effort') {
      activeEffort =
          (await _readJson(req))['effort']?.toString() ?? activeEffort;
      return _json(req.response, 200, {'ok': true});
    }

    return _json(req.response, 404, {'ok': false, 'error': 'Not found'});
  }

  Future<void> _openStream(HttpRequest req) async {
    final res = req.response;
    res.statusCode = 200;
    res.bufferOutput = false;
    res.headers.contentType = ContentType('text', 'event-stream');
    res.headers.set(HttpHeaders.cacheControlHeader, 'no-cache, no-transform');
    res.headers.set(HttpHeaders.connectionHeader, 'keep-alive');
    final client = _SseClient(res);
    _streams.add(client);
    res.done.whenComplete(() => _streams.remove(client));
    client.write('retry: 3000\n\n');
    client.write(
      'data: ${jsonEncode({
            'kind': 'hello',
            'status': _status(),
            'chats': chats
          })}\n\n',
    );
  }

  Map<String, dynamic> _status() => {
        'app': 'talon-bridge',
        'protocol': 1,
        'botName': 'Talon',
        'backend': 'test',
        'model': activeModel,
        'activeChats': chats.length,
        'startedAt': '2026-01-01T00:00:00.000Z',
      };

  String? _bearer(HttpRequest req) {
    final header = req.headers.value(HttpHeaders.authorizationHeader);
    if (header != null && header.startsWith('Bearer ')) {
      return header.substring('Bearer '.length);
    }
    return req.uri.queryParameters['token'];
  }

  bool _authOk(HttpRequest req) {
    final expected = token;
    if (expected == null || expected.isEmpty) return true;
    if (issuedCredentials.contains(_bearer(req))) return true;
    if (req.headers.value(HttpHeaders.authorizationHeader) ==
        'Bearer $expected') {
      return true;
    }
    return req.uri.queryParameters['token'] == expected;
  }

  Future<Map<String, dynamic>> _readJson(HttpRequest req) async {
    final raw = await utf8.decoder.bind(req).join();
    if (raw.trim().isEmpty) return {};
    final decoded = jsonDecode(raw);
    return decoded is Map ? decoded.cast<String, dynamic>() : {};
  }

  void _json(HttpResponse res, int status, Map<String, dynamic> body) {
    res.statusCode = status;
    res.headers.contentType = ContentType.json;
    res.write(jsonEncode(body));
    unawaited(res.close());
  }
}

class _SseClient {
  _SseClient(HttpResponse response) {
    unawaited(
        response.addStream(_controller.stream).whenComplete(response.close));
  }

  final StreamController<List<int>> _controller = StreamController<List<int>>();

  void write(String frame) {
    if (!_controller.isClosed) _controller.add(utf8.encode(frame));
  }

  Future<void> close() => _controller.close();
}
