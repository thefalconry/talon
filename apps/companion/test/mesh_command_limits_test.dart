import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/services/bridge_client.dart';
import 'package:talon_companion/src/services/device_exec.dart';
import 'package:talon_companion/src/services/mesh_service.dart';
import 'package:talon_companion/src/services/prefs.dart';

import 'mock_bridge.dart';

/// A burst of mesh commands must not pile up unbounded work on the device:
/// a fixed number run, a bounded number wait, the rest are answered "busy".
void main() {
  test('commands run on a bounded pool; overflow is answered busy', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final bridge = await MockBridge.start();
    addTearDown(bridge.close);
    final client = BridgeClient(
      ConnectionConfig(
        host: bridge.host,
        port: bridge.port,
        manageLocalDaemon: false,
        localAutoDiscover: false,
      ),
    );
    addTearDown(client.dispose);
    await client.connect();

    var running = 0;
    var peak = 0;
    final release = Completer<void>();
    final service = MeshService(
      prefs,
      client,
      locationProvider: () async => null,
      batteryProvider: () async => const MeshBattery(),
      nameProvider: () async => 'Test phone',
      versionProvider: () async => '1.0.0+1',
      foregroundStarter: () async {},
      ringHandler: (_) async {
        running++;
        if (running > peak) peak = running;
        await release.future;
        running--;
      },
    );
    addTearDown(service.stop);
    await service.start();
    await _waitFor(() => bridge.devices.length == 1);
    final id = bridge.devices.single['id'] as String;

    const burst = MeshService.maxConcurrentCommands +
        MeshService.maxQueuedCommands +
        5;
    for (var i = 0; i < burst; i++) {
      await bridge.emit({
        'kind': 'device_command',
        'id': 'ring-$i',
        'deviceId': id,
        'name': 'ring',
        'params': <String, dynamic>{},
      });
    }

    // Only the overflow has answered so far — and it said "busy".
    await _waitFor(() => bridge.commandResults.length == 5);
    expect(
      bridge.commandResults.every(
        (r) => r['ok'] == false && '${r['message']}'.contains('busy'),
      ),
      isTrue,
    );
    expect(running, MeshService.maxConcurrentCommands);

    release.complete();
    await _waitFor(() => bridge.commandResults.length == burst);
    expect(peak, MeshService.maxConcurrentCommands);
    expect(
      bridge.commandResults.where((r) => r['ok'] == true),
      hasLength(MeshService.maxConcurrentCommands +
          MeshService.maxQueuedCommands),
    );
  });

  test('the command limits follow the settings', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final bridge = await MockBridge.start();
    addTearDown(bridge.close);
    final client = BridgeClient(
      ConnectionConfig(
        host: bridge.host,
        port: bridge.port,
        manageLocalDaemon: false,
        localAutoDiscover: false,
      ),
    );
    addTearDown(client.dispose);
    await client.connect();
    await prefs.setMeshMaxConcurrent(1);
    await prefs.setMeshMaxQueued(2);

    var running = 0;
    var peak = 0;
    final release = Completer<void>();
    final service = MeshService(
      prefs,
      client,
      locationProvider: () async => null,
      batteryProvider: () async => const MeshBattery(),
      nameProvider: () async => 'Test phone',
      versionProvider: () async => '1.0.0+1',
      foregroundStarter: () async {},
      ringHandler: (_) async {
        running++;
        if (running > peak) peak = running;
        await release.future;
        running--;
      },
    );
    addTearDown(service.stop);
    await service.start();
    await _waitFor(() => bridge.devices.length == 1);
    final id = bridge.devices.single['id'] as String;

    for (var i = 0; i < 5; i++) {
      await bridge.emit({
        'kind': 'device_command',
        'id': 'ring-$i',
        'deviceId': id,
        'name': 'ring',
        'params': <String, dynamic>{},
      });
    }
    await _waitFor(() => bridge.commandResults.length == 2);
    expect('${bridge.commandResults.first['message']}', contains('1 commands'));
    release.complete();
    await _waitFor(() => bridge.commandResults.length == 5);
    expect(peak, 1);
  });

  test('write_file honours a raised write cap', () async {
    final dir = await Directory.systemTemp.createTemp('talon-write-cap-');
    addTearDown(() => dir.delete(recursive: true));
    final exec = DeviceExec()..writeLimit = () => DeviceExec.maxWriteBytes * 2;
    final r = await exec.writeFile(
      '${dir.path}/big.bin',
      base64Encode([1, 2, 3]),
      offset: 0,
      truncate: true,
    );
    expect(r.ok, isTrue);
    final capped = DeviceExec()..writeLimit = () => 2;
    final refused = await capped.writeFile(
      '${dir.path}/small.bin',
      base64Encode([1, 2, 3]),
      offset: 0,
      truncate: true,
    );
    expect(refused.ok, isFalse);
    expect(refused.message, contains('2-byte limit'));
  });

  test('write_file refuses to grow a file past the mesh write cap', () async {
    final dir = await Directory.systemTemp.createTemp('talon-write-cap-');
    addTearDown(() => dir.delete(recursive: true));
    final r = await DeviceExec().writeFile(
      '${dir.path}/big.bin',
      base64Encode([1, 2, 3]),
      offset: DeviceExec.maxWriteBytes - 1,
      truncate: false,
    );
    expect(r.ok, isFalse);
    expect(r.message, contains('limit'));
    expect(File('${dir.path}/big.bin').existsSync(), isFalse);
  });
}

Future<void> _waitFor(
  bool Function() test, {
  Duration timeout = const Duration(seconds: 5),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    if (test()) return;
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
  fail('condition not met before timeout');
}
