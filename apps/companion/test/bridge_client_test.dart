import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/services/bridge_client.dart';

import 'mock_bridge.dart';

void main() {
  ConnectionConfig configFor(MockBridge bridge, {String? token}) =>
      ConnectionConfig(
        host: bridge.host,
        port: bridge.port,
        token: token,
        manageLocalDaemon: false,
        localAutoDiscover: false,
      );

  group('BridgeClient.health', () {
    test('returns bridge health on happy path', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final client = BridgeClient(configFor(bridge));
      addTearDown(client.dispose);

      final health = await client.health();

      expect(health, isNotNull);
      expect(health?['app'], 'talon-bridge');
      expect(health?['protocol'], 1);
    });

    test('returns null for wrong app, non-200, and timeout', () async {
      final wrongApp = await MockBridge.start(healthApp: 'other');
      addTearDown(wrongApp.close);
      final wrongAppClient = BridgeClient(configFor(wrongApp));
      addTearDown(wrongAppClient.dispose);
      expect(await wrongAppClient.health(), isNull);

      final failing = await MockBridge.start(healthStatus: 503);
      addTearDown(failing.close);
      final failingClient = BridgeClient(configFor(failing));
      addTearDown(failingClient.dispose);
      expect(await failingClient.health(), isNull);

      final slow = await MockBridge.start(
        healthDelay: const Duration(milliseconds: 80),
      );
      addTearDown(slow.close);
      final slowClient = BridgeClient(configFor(slow));
      addTearDown(slowClient.dispose);
      expect(
        await slowClient.health(timeout: const Duration(milliseconds: 10)),
        isNull,
      );
    });
  });

  group('BridgeClient auth and REST', () {
    test('enforces bearer auth for REST and token query for SSE', () async {
      final bridge = await MockBridge.start(token: 'secret');
      addTearDown(bridge.close);

      final noToken = BridgeClient(configFor(bridge));
      addTearDown(noToken.dispose);
      await expectLater(noToken.listChats(), throwsA(isA<BridgeException>()));

      final good = BridgeClient(configFor(bridge, token: 'secret'));
      addTearDown(good.dispose);
      expect(await good.listChats(), hasLength(1));

      final rawClient = http.Client();
      addTearDown(rawClient.close);
      final request = http.Request(
        'GET',
        bridge.uri.replace(
          path: '/events',
          queryParameters: {'token': 'secret'},
        ),
      )..headers['Accept'] = 'text/event-stream';
      final stream = await rawClient.send(request);
      expect(stream.statusCode, 200);
    });

    test(
      'round-trips chats, history, send, config, models, and effort',
      () async {
        final bridge = await MockBridge.start(token: 'secret');
        addTearDown(bridge.close);
        final client = BridgeClient(configFor(bridge, token: 'secret'));
        addTearDown(client.dispose);

        expect(await client.listChats(), hasLength(1));
        final chat = await client.createChat('Scratch');
        expect(chat.title, 'Scratch');

        await client.send(chat.id, 'hello from test');
        final history = await client.history(chat.id);
        expect(history.single.text, 'hello from test');

        final cfg = await client.getConfig();
        expect(cfg.backend, 'test');
        final updated = await client.setConfig({'pulse': true});
        expect(updated.pulse, isTrue);

        final (active, models) = await client.models();
        expect(active, 'm1');
        expect(models.single.reasoning, isTrue);

        final (effort, levels) = await client.effortLevels(chat.id);
        expect(effort, 'adaptive');
        expect(levels, contains('high'));
        await client.setEffort(chat.id, 'high');
        expect(bridge.activeEffort, 'high');
      },
    );

    test('throws BridgeException for 401 and >=400 responses', () async {
      final bridge = await MockBridge.start(token: 'secret');
      addTearDown(bridge.close);
      final bad = BridgeClient(configFor(bridge, token: 'wrong'));
      addTearDown(bad.dispose);

      await expectLater(
        bad.listChats(),
        throwsA(
          isA<BridgeException>().having(
            (e) => e.unauthorized,
            'unauthorized',
            isTrue,
          ),
        ),
      );

      final good = BridgeClient(configFor(bridge, token: 'secret'));
      addTearDown(good.dispose);
      await expectLater(good.send('c1', ''), throwsA(isA<BridgeException>()));
    });
  });

  group('BridgeClient SSE', () {
    test(
      'parses retry, hello, comments, multi-line data, and later frames',
      () async {
        final bridge = await MockBridge.start();
        addTearDown(bridge.close);
        final client = BridgeClient(configFor(bridge));
        addTearDown(client.dispose);

        final events = <Map<String, dynamic>>[];
        final sub = client.events.listen(events.add);
        addTearDown(sub.cancel);

        await client.connect();
        await _waitFor(() => bridge.streamCount == 1);
        await _waitFor(() => events.isNotEmpty);
        expect(events.first['kind'], 'hello');

        await bridge.writeRaw(': keep-alive\n\n');
        await bridge.writeRaw('data: {"kind":"status",\n');
        await bridge.writeRaw(
          'data: "status":${jsonEncode({
                'protocol': 1,
                'botName': 'Talon',
                'backend': 'test',
                'model': 'm1',
                'activeChats': 1,
                'startedAt': 'now'
              })}}\n\n',
        );
        await bridge.emit({'kind': 'turn_start', 'chatId': 'c1'});

        await _waitFor(() => events.length >= 3);
        expect(events[1]['kind'], 'status');
        expect(events[2]['kind'], 'turn_start');
      },
    );

    test('authorises the stream with the header, never a URL token', () async {
      final bridge = await MockBridge.start(token: 'secret');
      addTearDown(bridge.close);
      final client = BridgeClient(configFor(bridge, token: 'secret'))
        ..meshDeviceId = 'dev-1';
      addTearDown(client.dispose);

      await client.connect();
      await _waitFor(() => bridge.streamCount == 1);

      final (uri, auth) = bridge.eventRequests.single;
      expect(uri.queryParameters, {'deviceId': 'dev-1'});
      expect(uri.toString(), isNot(contains('secret')));
      expect(auth, 'Bearer secret');
    });

    test('stream close surfaces an error', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final client = BridgeClient(configFor(bridge));
      addTearDown(client.dispose);
      final error = Completer<Object>();
      final sub = client.events.listen((_) {}, onError: error.complete);
      addTearDown(sub.cancel);

      await client.connect();
      await _waitFor(() => bridge.streamCount == 1);
      await bridge.closeStreams();

      expect(
        await error.future.timeout(const Duration(seconds: 1)),
        isA<BridgeException>(),
      );
    });

    test('a stalled event stream errors after the idle deadline', () async {
      // The mock sends `hello` and then nothing: a half-open socket as seen
      // from the client — no bytes, no FIN, no error.
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final client = BridgeClient(
        configFor(bridge),
        eventStreamIdle: const Duration(milliseconds: 300),
      );
      addTearDown(client.dispose);
      final error = Completer<Object>();
      final sub = client.events.listen((_) {}, onError: error.complete);
      addTearDown(sub.cancel);

      expect(client.lastRx, isNull);
      await client.connect();
      expect(client.lastRx, isNotNull);

      final e = await error.future.timeout(const Duration(seconds: 3));
      expect(
        e,
        isA<BridgeException>().having(
          (e) => e.message,
          'message',
          contains('Event stream idle'),
        ),
      );
    });

    test('keep-alive pings hold the stream open and advance lastRx', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final client = BridgeClient(
        configFor(bridge),
        eventStreamIdle: const Duration(milliseconds: 400),
      );
      addTearDown(client.dispose);
      final errors = <Object>[];
      final sub = client.events.listen((_) {}, onError: errors.add);
      addTearDown(sub.cancel);

      await client.connect();
      await _waitFor(() => bridge.streamCount == 1);
      final opened = client.lastRx!;
      for (var i = 0; i < 8; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
        await bridge.writeRaw(': ping\n\n');
      }
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(errors, isEmpty);
      expect(client.lastRx!.isAfter(opened), isTrue);
    });

    test('connect timeout closes the half-open client', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      final requests = <HttpRequest>[];
      unawaited(server.listen(requests.add).asFuture<void>());
      final client = BridgeClient(
        ConnectionConfig(
          host: '127.0.0.1',
          port: server.port,
          manageLocalDaemon: false,
        ),
      );
      addTearDown(client.dispose);

      await expectLater(
        client.connect(timeout: const Duration(microseconds: 1)),
        throwsA(
          isA<BridgeException>().having(
            (e) => e.message,
            'message',
            contains('Timed out'),
          ),
        ),
      );
    });
  });

  group('BridgeClient streamed transfers', () {
    test('uploadFile streams raw bytes in one request', () async {
      final bridge = await MockBridge.start(token: 'tok');
      addTearDown(bridge.close);
      final client = BridgeClient(configFor(bridge, token: 'tok'));
      addTearDown(client.dispose);

      bridge.uploadTokens.add('t-up');
      final payload = List<int>.generate(3 * 1024 * 1024, (i) => i % 251);
      final sent = await client.uploadFile(
        't-up',
        Stream.fromIterable([payload]),
        payload.length,
      );
      expect(sent, payload.length);
      expect(bridge.uploadedFiles['t-up'], payload);
    });

    test('uploadFile surfaces a rejected token as an error', () async {
      final bridge = await MockBridge.start(token: 'tok');
      addTearDown(bridge.close);
      final client = BridgeClient(configFor(bridge, token: 'tok'));
      addTearDown(client.dispose);

      expect(
        () => client.uploadFile(
            'bogus',
            Stream.fromIterable([
              <int>[1]
            ]),
            1),
        throwsA(isA<BridgeException>().having(
          (e) => e.message,
          'message',
          contains('409'),
        )),
      );
    });

    test('downloadFile streams the body and validates length', () async {
      final bridge = await MockBridge.start(token: 'tok');
      addTearDown(bridge.close);
      final client = BridgeClient(configFor(bridge, token: 'tok'));
      addTearDown(client.dispose);

      final payload = List<int>.generate(2 * 1024 * 1024, (i) => (i * 7) % 256);
      bridge.downloadFiles['t-down'] = payload;
      final received = <int>[];
      final n = await client.downloadFile('t-down', (chunk) async {
        received.addAll(chunk);
      });
      expect(n, payload.length);
      expect(received, payload);
    });

    test('downloadFile gives up on a body that stalls mid-stream', () async {
      final bridge = await MockBridge.start(token: 'tok');
      addTearDown(bridge.close);
      final client = BridgeClient(configFor(bridge, token: 'tok'));
      addTearDown(client.dispose);

      // Headers and a first slice arrive, then the connection goes quiet
      // without an end-of-stream — before the idle timeout existed this
      // call never returned and never threw, so the mesh command it backs
      // was never answered at all.
      bridge.stalledDownloads['t-stall'] = List<int>.filled(64, 1);

      await expectLater(
        client.downloadFile(
          't-stall',
          (_) async {},
          idleTimeout: const Duration(milliseconds: 150),
        ),
        throwsA(isA<BridgeException>().having(
          (e) => e.message,
          'message',
          contains('stalled'),
        )),
      );
    });

    test('downloadFile does not cut off a slow but live transfer', () async {
      final bridge = await MockBridge.start(token: 'tok');
      addTearDown(bridge.close);
      final client = BridgeClient(configFor(bridge, token: 'tok'));
      addTearDown(client.dispose);

      // The deadline is between events, not overall — so neither a server
      // that trickles nor a consumer slower than the deadline may abort a
      // transfer that is still making progress.
      final payload = List<int>.generate(64 * 1024, (i) => i % 256);
      bridge.downloadFiles['t-slow'] = payload;
      bridge.downloadSliceBytes = 8 * 1024;
      bridge.downloadSliceGap = const Duration(milliseconds: 60);

      final received = <int>[];
      final n = await client.downloadFile(
        't-slow',
        (chunk) async {
          received.addAll(chunk);
          await Future<void>.delayed(const Duration(milliseconds: 40));
        },
        idleTimeout: const Duration(milliseconds: 200),
      );

      expect(n, payload.length);
      expect(received, payload);
      // Total wall clock (8 slices × ~100ms) comfortably exceeds the
      // deadline; only a per-event deadline lets this pass.
      expect(payload.length ~/ (8 * 1024), greaterThan(4));
    });

    test('downloadFile surfaces an unknown token as an error', () async {
      final bridge = await MockBridge.start(token: 'tok');
      addTearDown(bridge.close);
      final client = BridgeClient(configFor(bridge, token: 'tok'));
      addTearDown(client.dispose);

      expect(
        () => client.downloadFile('bogus', (_) async {}),
        throwsA(isA<BridgeException>().having(
          (e) => e.message,
          'message',
          contains('404'),
        )),
      );
    });
  });
}

Future<void> _waitFor(
  bool Function() test, {
  Duration timeout = const Duration(seconds: 2),
}) async {
  final end = DateTime.now().add(timeout);
  while (!test()) {
    if (DateTime.now().isAfter(end)) {
      fail('Timed out waiting for condition');
    }
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}
