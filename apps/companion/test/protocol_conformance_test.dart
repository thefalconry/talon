import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/models/credentials.dart';
import 'package:talon_companion/src/services/bridge_client.dart';
import 'package:talon_companion/src/services/device_exec.dart';
import 'package:talon_companion/src/services/mesh_service.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';

import 'mock_bridge.dart';

/// Companion-side leg of the tri-implementation Bridge Protocol conformance
/// suite (see protocol/README.md). The daemon asserts the same fixtures from
/// TypeScript and talon-node from Go; this leg replays the canonical event
/// session over a LIVE SSE connection into the real AppState, and runs the
/// canonical device commands through the real DeviceExec — so a wire drift
/// fails here instead of shipping a silent misrender or a command timeout.
void main() {
  final eventsFixture = jsonDecode(
    File('../../protocol/fixtures/events_v1.json').readAsStringSync(),
  ) as Map<String, dynamic>;
  final meshFixture = jsonDecode(
    File('../../protocol/fixtures/mesh_v1.json').readAsStringSync(),
  ) as Map<String, dynamic>;

  final authFixture = jsonDecode(
    File('../../protocol/fixtures/auth_v1.json').readAsStringSync(),
  ) as Map<String, dynamic>;

  List<Map<String, dynamic>> mapList(dynamic v) => (v as List)
      .map((e) => (e as Map).cast<String, dynamic>())
      .toList();
  List<String> stringList(dynamic v) => (v as List).cast<String>();

  group('canonical event session (events_v1.json)', () {
    late MockBridge bridge;
    late AppState state;
    late List<Map<String, dynamic>> events;
    late int cursor;

    setUp(() async {
      bridge = await MockBridge.start();
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      await prefs.setConnection(ConnectionConfig(
        host: bridge.host,
        port: bridge.port,
        manageLocalDaemon: false,
        localAutoDiscover: false,
      ));
      // Phone layout: no auto-select, so no history hydration races the
      // replayed session — every message on screen came from the fixture.
      state = AppState(prefs, narrowLayout: true);
      await state.start();
      await _waitFor(() => bridge.streamCount == 1);
      events = mapList(eventsFixture['events']);
      cursor = 0;
    });

    tearDown(() async {
      state.dispose();
      await bridge.close();
    });

    /// Emit fixture events in order up to and including the next event of
    /// [kind]. The fixture's order is part of the contract — the session must
    /// replay top-to-bottom — so running past the end fails loudly.
    Future<void> playThrough(String kind, {int skip = 0}) async {
      var toSkip = skip;
      while (cursor < events.length) {
        final event = events[cursor++];
        await bridge.emit(event);
        if (event['kind'] == kind && toSkip-- == 0) return;
      }
      fail('events fixture has no "$kind" event left to play '
          '(reordered or removed?)');
    }

    test('replays top-to-bottom against the live AppState', () async {
      await playThrough('hello');
      await _waitFor(() => state.status.activeChats == 3);
      expect(state.chats.map((c) => c.id), contains('d_abc123'));

      await playThrough('status');
      await _waitFor(() => state.status.activeChats == 4);

      await playThrough('chat_created');
      await _waitFor(() => state.chats.any((c) => c.id == 'd_new777'));

      await playThrough('chat_updated');
      await _waitFor(() =>
          state.chats.any((c) => c.id == 'd_abc123' && c.queued != null));
      final updated = state.chats.firstWhere((c) => c.id == 'd_abc123');
      expect(updated.queued?.text, 'and after that, the hedgehog');
      expect(updated.context?.pct, 20);

      await playThrough('message');
      await _waitFor(
          () => state.messagesFor('d_abc123').any((m) => m.id == '2001'));

      await playThrough('delta');
      final turn = state.turnFor('d_abc123');
      await _waitFor(() => turn.draft.isNotEmpty);
      expect(turn.active, isTrue);
      expect(turn.typing, isTrue);
      expect(turn.reasoning.join(), contains('fox'));
      expect(turn.draft, contains('Looking for the fox'));

      await playThrough('tool', skip: 3); // both calls + both results
      await _waitFor(() => turn.tools.length == 2);

      await playThrough('message');
      await _waitFor(
          () => state.messagesFor('d_abc123').any((m) => m.id == '2002'));
      expect(
        state
            .messagesFor('d_abc123')
            .firstWhere((m) => m.id == '2002')
            .tools
            .map((t) => t.id),
        containsAll(['toolu_c1', 'toolu_c2']),
      );

      await playThrough('typing'); // plays turn_end, stops at typing off
      await _waitFor(() => !turn.active && !turn.typing);
      final assistant =
          state.messagesFor('d_abc123').firstWhere((m) => m.id == '2002');
      expect(assistant.durationMs, 4200);
      expect(assistant.tokensIn, 1200);
      expect(assistant.tokensOut, 340);

      await playThrough('message_edited');
      await _waitFor(() => state
          .messagesFor('d_abc123')
          .firstWhere((m) => m.id == '2002')
          .text
          .contains('(edited)'));

      await playThrough('reaction');
      await _waitFor(() => state
          .messagesFor('d_abc123')
          .firstWhere((m) => m.id == '2002')
          .reactions
          .contains('👍'));

      await playThrough('message_deleted');
      await _waitFor(
          () => !state.messagesFor('d_abc123').any((m) => m.id == '2001'));

      await playThrough('error');
      await _waitFor(() =>
          state.messagesFor('d_abc123').last.text.contains('SDK error'));

      // locate + device_command are mesh events — the chat layer must
      // tolerate them silently; the trailing chat_deleted proves the stream
      // survived them.
      await playThrough('chat_deleted');
      await _waitFor(() => !state.chats.any((c) => c.id == 'd_new777'));

      expect(cursor, events.length,
          reason: 'test fell out of sync with the fixture session');
    });

    test('forward-compat frames never break the stream', () async {
      for (final frame in mapList(eventsFixture['forwardCompat'])) {
        await bridge.emit(frame);
      }
      // A known event after the unknown ones must still apply.
      await bridge.emit({
        'kind': 'chat_created',
        'chat': {
          'id': 'd_after',
          'title': 'Still alive',
          'createdAt': 1,
          'lastActive': 2,
          'preview': '',
        },
      });
      await _waitFor(() => state.chats.any((c) => c.id == 'd_after'));
    });
  });

  group('mesh surface (mesh_v1.json)', () {
    test('advertised capabilities match the canonical lists', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();

      final core = stringList(meshFixture['companionCoreCapabilities']);
      final control =
          stringList(meshFixture['companionDeviceControlCapabilities']);

      await prefs.setMeshDeviceControl(true);
      expect(
        MeshService.capabilitiesFor(prefs, sandboxed: false),
        [...core, ...control],
      );
      // The Flatpak build is client-only: core surface, whatever the switch.
      expect(MeshService.capabilitiesFor(prefs, sandboxed: true), core);

      await prefs.setMeshDeviceControl(false);
      expect(MeshService.capabilitiesFor(prefs, sandboxed: false), core);
    });

    test('DeviceExec answers the canonical commands with contract keys',
        () async {
      final execCaps = DeviceExec.capabilities.toSet();
      final exec = DeviceExec();
      var covered = 0;

      for (final entry in mapList(meshFixture['commands'])) {
        final command = (entry['command'] as Map).cast<String, dynamic>();
        final name = command['name'] as String;
        if (entry['run'] != true || !execCaps.contains(name)) continue;
        covered++;

        final sandbox = await Directory.systemTemp.createTemp('talon-conf-');
        addTearDown(() => sandbox.delete(recursive: true));
        for (final file
            in (meshFixture['sandboxFiles'] as Map).cast<String, String>().entries) {
          await File('${sandbox.path}/${file.key}').writeAsString(file.value);
        }

        final params = <String, dynamic>{
          for (final p in (command['params'] as Map).cast<String, dynamic>().entries)
            p.key: p.value is String
                ? (p.value as String).replaceAll('{{TMP}}', sandbox.path)
                : p.value,
        };

        final outcome = await exec.handle(name, params);
        expect(outcome, isNotNull,
            reason: 'DeviceExec must handle advertised command "$name"');
        expect(outcome!.ok, entry['expectOk'],
            reason: '$name: ${outcome.message}');
        for (final key in stringList(entry['dataKeys'])) {
          expect(outcome.data, isNotNull, reason: '$name data missing');
          expect(outcome.data!.containsKey(key), isTrue,
              reason: '$name result data is missing contract key "$key" '
                  '(got ${outcome.data})');
        }
      }
      expect(covered, greaterThanOrEqualTo(8),
          reason: 'fixture should exercise the full exec/fs surface');
    });

    test('streamed transfers (transfer: true) answer with contract keys',
        () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      final config = ConnectionConfig(
        host: bridge.host,
        port: bridge.port,
        manageLocalDaemon: false,
        localAutoDiscover: false,
      );
      await prefs.setConnection(config);
      await prefs.setMeshDeviceControl(true);
      final client = BridgeClient(config);
      addTearDown(client.dispose);
      await client.connect();
      final service = MeshService(
        prefs,
        client,
        batteryProvider: () async => const MeshBattery(),
        nameProvider: () async => 'rack-01',
        versionProvider: () async => '1.0.0+1',
        foregroundStarter: () async {},
      );
      addTearDown(service.stop);
      await service.start();
      await _waitFor(() => bridge.devices.length == 1);
      final id = bridge.devices.single['id'] as String;

      final body = utf8.encode(meshFixture['transferBody'] as String);
      final bodySha = sha256.convert(body).toString();
      final sandbox = await Directory.systemTemp.createTemp('talon-conf-');
      addTearDown(() => sandbox.delete(recursive: true));
      for (final file in (meshFixture['sandboxFiles'] as Map)
          .cast<String, String>()
          .entries) {
        await File('${sandbox.path}/${file.key}').writeAsString(file.value);
      }

      var covered = 0;
      for (final entry in mapList(meshFixture['commands'])) {
        if (entry['transfer'] != true) continue;
        covered++;
        final command = (entry['command'] as Map).cast<String, dynamic>();
        final params = <String, dynamic>{
          for (final p
              in (command['params'] as Map).cast<String, dynamic>().entries)
            p.key: p.value is String
                ? (p.value as String).replaceAll('{{TMP}}', sandbox.path)
                : p.value,
        };
        final token = params['token'] as String;
        bridge.uploadTokens.add(token);
        bridge.downloadFiles[token] = body;

        final before = bridge.commandResults.length;
        await bridge.emit({
          'kind': 'device_command',
          ...command,
          'deviceId': id,
          'params': params,
        });
        await _waitFor(() => bridge.commandResults.length == before + 1);
        final result = bridge.commandResults.last;
        final name = command['name'];
        expect(result['ok'], entry['expectOk'], reason: '$name: $result');
        final data = (result['data'] as Map).cast<String, dynamic>();
        for (final key in stringList(entry['dataKeys'])) {
          expect(data.containsKey(key), isTrue,
              reason: '$name result data is missing contract key "$key"');
        }
        if (name == 'download_file') {
          expect(params['sha256'], bodySha);
          expect(data['sha256'], bodySha);
        } else {
          final sent = bridge.uploadedFiles[token]!;
          expect(data['sha256'], sha256.convert(sent).toString());
        }
      }
      expect(covered, 2, reason: 'upload_file and download_file samples');
    });
  });

  group('per-device credentials (auth_v1.json)', () {
    Map<String, dynamic> section(String key) =>
        (authFixture[key] as Map).cast<String, dynamic>();
    Map<String, dynamic> sample(String key, String name) =>
        (section(key)[name] as Map).cast<String, dynamic>();
    final credentials = stringList(authFixture['sampleCredentials']);
    final sharedTokens = stringList(authFixture['sampleSharedTokens']);

    test('tells a per-device credential from the shared token', () {
      for (final t in credentials) {
        expect(isDeviceCredential(t), isTrue, reason: t);
      }
      for (final t in sharedTokens) {
        expect(isDeviceCredential(t), isFalse, reason: t);
      }
    });

    test('the upgrade request BridgeClient sends is the fixture', () {
      final want = jsonDecode(
        jsonEncode(sample('upgradeRequests', 'companion'))
            .replaceAll('{{DEVICE_ID}}', 'dev_pixel8'),
      );
      final got = jsonDecode(
        jsonEncode(BridgeClient.upgradeRequestBody('dev_pixel8')),
      );
      expect(got, want);
    });

    test('every fixture upgrade reply parses to its credential', () {
      for (final name in ['node', 'companion']) {
        final reply = sample('upgradeReplies', name);
        final grant = CredentialGrant.fromJson(reply);
        expect(grant.token, reply['token']);
        expect(grant.credentialId, reply['credentialId']);
        expect(grant.deviceId, reply['deviceId']);
        expect(grant.scopes, stringList(reply['scopes']));
      }
      for (final error in mapList(authFixture['upgradeErrors'])) {
        expect(
          () => CredentialGrant.fromJson(
            (error['body'] as Map).cast<String, dynamic>(),
          ),
          throwsFormatException,
        );
      }
    });

    test('whoami: act on upgrade/rotate only, ignore anything else', () {
      final shared = sharedTokens.first;
      final own = credentials.first;
      final byName = {
        for (final name in ['shared', 'device', 'rotate', 'open'])
          name: CredentialStatus.fromJson(sample('whoami', name)),
      };
      expect(byName['shared']!.wantsNewCredential(shared), isTrue);
      expect(byName['shared']!.wantsNewCredential(own), isFalse);
      expect(byName['device']!.wantsNewCredential(own), isFalse);
      expect(byName['device']!.deviceId, 'dev_node01');
      expect(byName['rotate']!.wantsNewCredential(own), isTrue);
      expect(byName['open']!.wantsNewCredential(shared), isFalse);
      final future = CredentialStatus.fromJson({
        ...sample('whoami', 'device'),
        'action': (section('registerReplies')['forwardCompat']
            as Map)['credential']['action'],
      });
      expect(future.wantsNewCredential(own), isFalse);
      expect(future.wantsNewCredential(shared), isFalse);
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
