import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/security/app_lock/app_lock_controller.dart';
import 'package:talon_companion/src/security/app_lock/approval_relay.dart';
import 'package:talon_companion/src/security/app_lock/secret_store.dart';
import 'package:talon_companion/src/security/app_lock/snapshot_cipher.dart';
import 'package:talon_companion/src/services/bridge_client.dart';
import 'package:talon_companion/src/services/mesh_service.dart';
import 'package:talon_companion/src/services/prefs.dart';

import 'app_lock_harness.dart';
import 'mock_bridge.dart';

void main() {
  // No TestWidgetsFlutterBinding here: it swaps in an HttpClient that answers
  // every request with 400, and the MeshService tests talk to a real
  // MockBridge (same as mesh_service_test.dart).
  tearDown(() => Prefs.sealedSnapshotSink = null);

  Future<Prefs> prefsWith(Map<String, Object> values) async {
    SharedPreferences.setMockInitialValues(values);
    return Prefs.load();
  }

  const gateOn = {
    'applock.enabled.v1': true,
    'applock.elevatedGate.v1': true,
  };

  group('background approver (Android mesh isolate)', () {
    test('gate off: allows without asking', () async {
      final prefs = await prefsWith({});
      final sent = <Object>[];
      final approver = BackgroundCommandApprover(send: sent.add);
      expect(await approver.approve(prefs, 'exec'), isNull);
      expect(sent, isEmpty);
    });

    test('the gate needs the lock itself to be on', () async {
      final prefs = await prefsWith({'applock.elevatedGate.v1': true});
      expect(prefs.appLockElevatedGate, isFalse);
    });

    test('no UI in front: refused without asking', () async {
      final prefs = await prefsWith({...gateOn, 'ui.foreground.v1': false});
      final sent = <Object>[];
      final approver = BackgroundCommandApprover(send: sent.add);
      expect(
        await approver.approve(prefs, 'exec'),
        AppLockController.deniedInBackground,
      );
      expect(sent, isEmpty);
    });

    test('asks the UI and follows its answer', () async {
      final prefs = await prefsWith({...gateOn, 'ui.foreground.v1': true});
      final sent = <Object>[];
      final approver = BackgroundCommandApprover(send: sent.add);

      final allowed = approver.approve(prefs, 'exec');
      await Future<void>.delayed(Duration.zero);
      final request = ApprovalMessages.parseRequest(sent.single)!;
      expect(request.command, 'exec');
      expect(approver.handle(ApprovalMessages.resultOf(request.id, true)), isTrue);
      expect(await allowed, isNull);

      final refused = approver.approve(prefs, 'delete');
      await Future<void>.delayed(Duration.zero);
      final second = ApprovalMessages.parseRequest(sent.last)!;
      approver.handle(ApprovalMessages.resultOf(second.id, false));
      expect(await refused, AppLockController.deniedByUser);
    });

    test('no answer in time: refused', () async {
      final prefs = await prefsWith({...gateOn, 'ui.foreground.v1': true});
      final approver = BackgroundCommandApprover(
        send: (_) {},
        timeout: const Duration(milliseconds: 30),
      );
      expect(
        await approver.approve(prefs, 'exec'),
        AppLockController.deniedByUser,
      );
    });

    test('ignores unrelated messages', () {
      final approver = BackgroundCommandApprover(send: (_) {});
      expect(approver.handle('mesh.reconfigure.v1'), isFalse);
      expect(approver.handle({'type': 'other'}), isFalse);
    });
  });

  test('round trip through the UI controller', () async {
    final prefs = await prefsWith({'ui.foreground.v1': true});
    final lock = AppLockController(
      prefs: prefs,
      store: MemorySecretStore(),
      sealedSnapshots: MemorySealedSnapshotStore(),
      deriver: const FakeDeriver(),
      cipher: const SnapshotCipher(useIsolate: false),
    );
    addTearDown(lock.dispose);
    await lock.load();
    await lock.enable('123456');
    await lock.setRequireUnlockForElevated(true);

    late BackgroundCommandApprover background;
    final ui = UiApprovalResponder(lock, reply: (m) => background.handle(m));
    background = BackgroundCommandApprover(send: ui.onTaskData);

    final result = background.approve(prefs, 'install_apk');
    await Future<void>.delayed(Duration.zero);
    expect(lock.pendingApproval?.command, 'install_apk');
    expect((await lock.approveWithPasscode('123456')).ok, isTrue);
    expect(await result, isNull);
  });

  group('MeshService gate', () {
    ConnectionConfig configFor(MockBridge bridge) => ConnectionConfig(
          host: bridge.host,
          port: bridge.port,
          manageLocalDaemon: false,
          localAutoDiscover: false,
        );

    test('covers exec-class commands only', () {
      for (final c in ['exec', 'write_file', 'delete', 'install_apk',
          'upload_file', 'download_file', 'read_file']) {
        expect(MeshService.needsApproval(c), isTrue, reason: c);
      }
      for (final c in ['locate', 'ring', 'status']) {
        expect(MeshService.needsApproval(c), isFalse, reason: c);
      }
    });

    Future<({MockBridge bridge, String id, List<String> asked})> start(
      Map<String, Object> values, {
      String? Function(String command)? decide,
      bool useDefault = false,
    }) async {
      final prefs = await prefsWith(values);
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      await prefs.setConnection(configFor(bridge));
      await prefs.setMeshDeviceControl(true);
      final client = BridgeClient(configFor(bridge));
      addTearDown(client.dispose);
      await client.connect();
      final asked = <String>[];
      final service = MeshService(
        prefs,
        client,
        locationProvider: () async => const MeshFix(lat: 1, lon: 2, ts: 1),
        batteryProvider: () async => const MeshBattery(),
        nameProvider: () async => 'Test phone',
        versionProvider: () async => '1.0.0+1',
        foregroundStarter: () async {},
        approver: useDefault
            ? null
            : (command) async {
                asked.add(command);
                return decide?.call(command);
              },
      );
      addTearDown(service.stop);
      await service.start();
      await _waitFor(() => bridge.devices.length == 1);
      return (
        bridge: bridge,
        id: bridge.devices.single['id'] as String,
        asked: asked,
      );
    }

    Future<Map<String, dynamic>> run(
      MockBridge bridge,
      String id,
      String name,
      Map<String, dynamic> params,
    ) async {
      final before = bridge.commandResults.length;
      await bridge.emit({
        'kind': 'device_command',
        'id': 'cmd-${before + 1}',
        'deviceId': id,
        'name': name,
        'params': params,
      });
      await _waitFor(() => bridge.commandResults.length == before + 1);
      return bridge.commandResults.last;
    }

    test('a refusal is returned to the daemon and nothing runs', () async {
      final s = await start({}, decide: (_) => 'nope');
      final r = await run(s.bridge, s.id, 'exec', {'cmd': 'echo ran'});
      expect(r, containsPair('ok', false));
      expect(r, containsPair('message', 'nope'));
      expect(s.asked, ['exec']);
    });

    test('an approval lets it run', () async {
      final s = await start({}, decide: (_) => null);
      final r = await run(s.bridge, s.id, 'exec', {'cmd': 'echo ran'});
      expect(r, containsPair('ok', true));
    });

    test('status never asks', () async {
      final s = await start({}, decide: (_) => 'nope');
      final r = await run(s.bridge, s.id, 'status', {});
      expect(r, containsPair('ok', true));
      expect(s.asked, isEmpty);
    });

    test('with nobody to ask, the gate fails closed', () async {
      final s = await start(gateOn, useDefault: true);
      final r = await run(s.bridge, s.id, 'exec', {'cmd': 'echo ran'});
      expect(r, containsPair('ok', false));
      expect(r['message'], contains('local approval'));
    });

    test('with the gate off and nobody to ask, commands run as before',
        () async {
      final s = await start({}, useDefault: true);
      final r = await run(s.bridge, s.id, 'exec', {'cmd': 'echo ran'});
      expect(r, containsPair('ok', true));
    });
  });
}

Future<void> _waitFor(
  bool Function() test, {
  Duration timeout = const Duration(seconds: 3),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    if (test()) return;
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
  fail('condition not met before timeout');
}
