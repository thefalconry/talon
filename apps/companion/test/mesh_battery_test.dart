import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/services/bridge_client.dart';
import 'package:talon_companion/src/services/command_wake_lock.dart';
import 'package:talon_companion/src/services/mesh_liveness.dart';
import 'package:talon_companion/src/services/prefs.dart';

import 'mock_bridge.dart';

/// #1060: the Android mesh service must let the device sleep, register once
/// a minute, keep liveness out of the prefs store, and not decode the token
/// firehose a second time.
void main() {
  group('CommandWakeLock', () {
    late List<String> calls;
    setUp(() {
      CommandWakeLock.resetForTest();
      calls = [];
      CommandWakeLock.debugInvoke = (method, _) async => calls.add(method);
    });
    tearDown(CommandWakeLock.resetForTest);

    test('holds only while commands run, released after the last', () async {
      final a = CommandWakeLock.hold(() async {
        await Future<void>.delayed(const Duration(milliseconds: 30));
        return 1;
      });
      final b = CommandWakeLock.hold(() async {
        await Future<void>.delayed(const Duration(milliseconds: 60));
        return 2;
      });
      await Future<void>.delayed(Duration.zero);
      expect(CommandWakeLock.active, 2);
      expect(calls, ['acquire', 'acquire']);

      expect(await a, 1);
      expect(calls, isNot(contains('release')),
          reason: 'still one command running');
      expect(await b, 2);
      expect(calls.last, 'release');
      expect(calls.where((c) => c == 'release'), hasLength(1));
      expect(CommandWakeLock.active, 0);
    });

    test('a failing command still releases', () async {
      await expectLater(
        CommandWakeLock.hold<void>(() async => throw StateError('boom')),
        throwsStateError,
      );
      expect(calls, ['acquire', 'release']);
      expect(CommandWakeLock.active, 0);
    });

    test('is a no-op off Android without a hook', () async {
      CommandWakeLock.debugInvoke = null;
      expect(await CommandWakeLock.hold(() async => 'ok'), 'ok');
    });
  });

  group('event kind peek', () {
    test('reads the leading kind without decoding', () {
      expect(BridgeClient.peekKind('{"kind":"delta","chatId":"c1"}'), 'delta');
      expect(BridgeClient.peekKind('{"kind":"status",\n"status":{}}'),
          'status');
    });

    test('anything unusual falls back to a full decode', () {
      expect(BridgeClient.peekKind('{"chatId":"c1","kind":"delta"}'), isNull);
      expect(BridgeClient.peekKind('{ "kind": "delta"}'), isNull);
      expect(BridgeClient.peekKind('{"kind":"de\\"lta"}'), isNull);
      expect(BridgeClient.peekKind('{"kind":"delta'), isNull);
    });
  });

  test('skipKinds drops the firehose before decoding, keeps the rest',
      () async {
    final bridge = await MockBridge.start();
    addTearDown(bridge.close);
    final client = BridgeClient(
      ConnectionConfig(
        host: bridge.host,
        port: bridge.port,
        manageLocalDaemon: false,
        localAutoDiscover: false,
      ),
      skipKinds: const {'delta', 'reasoning'},
    );
    addTearDown(client.dispose);
    final kinds = <Object?>[];
    final sub = client.events.listen((e) => kinds.add(e['kind']));
    addTearDown(sub.cancel);

    await client.connect();
    await _waitFor(() => kinds.contains('hello'));
    await bridge.emit({'kind': 'delta', 'chatId': 'c1', 'text': 'x'});
    await bridge.emit({'kind': 'reasoning', 'chatId': 'c1', 'text': 'y'});
    await bridge.emit({'kind': 'device_command', 'id': 'cmd1'});
    await _waitFor(() => kinds.contains('device_command'));
    expect(kinds, isNot(contains('delta')));
    expect(kinds, isNot(contains('reasoning')));
  });

  test('liveness round-trips (prefs fallback without an app directory)',
      () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    expect(await MeshLiveness.read(prefs), isNull);
    await MeshLiveness.stamp(prefs, 1234);
    expect(await MeshLiveness.read(prefs), 1234);
  });
}

Future<void> _waitFor(
  bool Function() test, {
  Duration timeout = const Duration(seconds: 2),
}) async {
  final end = DateTime.now().add(timeout);
  while (!test()) {
    if (DateTime.now().isAfter(end)) fail('Timed out waiting for condition');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}
