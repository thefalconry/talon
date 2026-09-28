import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/services/bridge_client.dart';
import 'package:talon_companion/src/services/mesh_service.dart';
import 'package:talon_companion/src/services/prefs.dart';

import 'mock_bridge.dart';

void main() {
  ConnectionConfig configFor(MockBridge bridge) => ConnectionConfig(
        host: bridge.host,
        port: bridge.port,
        manageLocalDaemon: false,
        localAutoDiscover: false,
      );

  test('registers a stable device and responds to locate SSE with one fix',
      () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final bridge = await MockBridge.start();
    addTearDown(bridge.close);
    final client = BridgeClient(configFor(bridge));
    addTearDown(client.dispose);

    await client.connect();
    final service = MeshService(
      prefs,
      client,
      locationProvider: () async => const MeshFix(
        lat: 53.35,
        lon: -6.26,
        accuracyM: 9,
        ts: 1234,
      ),
      batteryProvider: () async =>
          const MeshBattery(percent: 82, charging: true),
      nameProvider: () async => 'Test phone',
      versionProvider: () async => '1.0.0+1',
      foregroundStarter: () async {},
    );
    addTearDown(service.stop);

    await service.start();
    await _waitFor(() => bridge.devices.length == 1);
    final id = bridge.devices.single['id'] as String;
    expect(id, isNotEmpty);
    expect(bridge.devices.single['name'], 'Test phone');
    expect(bridge.devices.single['battery'], 82);

    await bridge.emit({'kind': 'locate', 'deviceId': id});
    await _waitFor(() => bridge.locations.length == 1);
    expect(bridge.locations.single, containsPair('deviceId', id));
    expect(bridge.locations.single, containsPair('lat', 53.35));
    expect(bridge.locations.single, containsPair('batteryPct', 82));
  });

  test('streams upload_file and download_file via /devices/file', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final bridge = await MockBridge.start();
    addTearDown(bridge.close);
    // Device control is an explicit, per-bridge grant (off by default).
    await prefs.setConnection(configFor(bridge));
    await prefs.setMeshDeviceControl(true);
    final client = BridgeClient(configFor(bridge));
    addTearDown(client.dispose);

    await client.connect();
    final service = MeshService(
      prefs,
      client,
      locationProvider: () async => const MeshFix(lat: 1, lon: 2, ts: 99),
      batteryProvider: () async => const MeshBattery(),
      nameProvider: () async => 'Test phone',
      versionProvider: () async => '1.0.0+1',
      foregroundStarter: () async {},
    );
    addTearDown(service.stop);

    await service.start();
    await _waitFor(() => bridge.devices.length == 1);
    final id = bridge.devices.single['id'] as String;
    expect(
      bridge.devices.single['capabilities'],
      containsAll(['upload_file', 'download_file']),
    );

    final dir = await Directory.systemTemp.createTemp('talon-mesh-transfer-');
    addTearDown(() => dir.delete(recursive: true));

    // upload_file: the device streams a local file up in one HTTP request.
    final src = File('${dir.path}/src.bin');
    final payload = List<int>.generate(512 * 1024, (i) => i % 256);
    await src.writeAsBytes(payload);
    bridge.uploadTokens.add('tok-up');
    await bridge.emit({
      'kind': 'device_command',
      'id': 'cmd-up',
      'deviceId': id,
      'name': 'upload_file',
      'params': {'token': 'tok-up', 'path': src.path},
    });
    await _waitFor(() => bridge.commandResults.length == 1);
    expect(bridge.commandResults.last, containsPair('ok', true));
    expect(
      bridge.commandResults.last['data'],
      containsPair('bytes', payload.length),
    );
    expect(bridge.uploadedFiles['tok-up'], payload);

    // download_file: the device streams the body down and writes atomically.
    bridge.downloadFiles['tok-down'] = payload;
    final dest = '${dir.path}/nested/dest.bin';
    await bridge.emit({
      'kind': 'device_command',
      'id': 'cmd-down',
      'deviceId': id,
      'name': 'download_file',
      'params': {'token': 'tok-down', 'path': dest},
    });
    await _waitFor(() => bridge.commandResults.length == 2);
    expect(bridge.commandResults.last, containsPair('ok', true));
    expect(
      bridge.commandResults.last['data'],
      containsPair('bytesWritten', payload.length),
    );
    expect(await File(dest).readAsBytes(), payload);

    // A bad token comes back as a clean failure, not a hang.
    await bridge.emit({
      'kind': 'device_command',
      'id': 'cmd-bad',
      'deviceId': id,
      'name': 'download_file',
      'params': {'token': 'nope', 'path': '${dir.path}/x.bin'},
    });
    await _waitFor(() => bridge.commandResults.length == 3);
    expect(bridge.commandResults.last, containsPair('ok', false));
  });

  test('streamed transfers carry sha256 and refuse a mismatched push',
      () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final bridge = await MockBridge.start();
    addTearDown(bridge.close);
    await prefs.setConnection(configFor(bridge));
    await prefs.setMeshDeviceControl(true);
    final client = BridgeClient(configFor(bridge));
    addTearDown(client.dispose);
    await client.connect();
    final service = MeshService(
      prefs,
      client,
      batteryProvider: () async => const MeshBattery(),
      nameProvider: () async => 'Test phone',
      versionProvider: () async => '1.0.0+1',
      foregroundStarter: () async {},
    );
    addTearDown(service.stop);
    await service.start();
    await _waitFor(() => bridge.devices.length == 1);
    final id = bridge.devices.single['id'] as String;
    final dir = await Directory.systemTemp.createTemp('talon-mesh-digest-');
    addTearDown(() => dir.delete(recursive: true));
    final payload = List<int>.generate(300 * 1024, (i) => (i * 7) % 256);
    final digest = sha256.convert(payload).toString();

    Future<Map<String, dynamic>> run(
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

    // Pull: the device reports the digest of what it streamed.
    final src = File('${dir.path}/src.bin')..writeAsBytesSync(payload);
    bridge.uploadTokens.add('up');
    final up = await run('upload_file', {'token': 'up', 'path': src.path});
    expect(up['ok'], isTrue);
    expect(up['data'], containsPair('sha256', digest));

    // Push with the right digest (any case): written, digest reported.
    bridge.downloadFiles['ok'] = payload;
    final good = '${dir.path}/good.bin';
    final down = await run('download_file', {
      'token': 'ok',
      'path': good,
      'sha256': digest.toUpperCase(),
    });
    expect(down['ok'], isTrue);
    expect(down['data'], containsPair('sha256', digest));
    expect(File(good).readAsBytesSync(), payload);

    // Push whose bytes don't match: nothing lands, the temp file is gone.
    bridge.downloadFiles['bad'] = [...payload.take(1000), 0, 1, 2];
    final bad = '${dir.path}/bad.bin';
    final refused = await run('download_file', {
      'token': 'bad',
      'path': bad,
      'sha256': digest,
    });
    expect(refused['ok'], isFalse);
    expect('${refused['message']}', contains('integrity check failed'));
    expect(File(bad).existsSync(), isFalse);
    expect(File('$bad.part').existsSync(), isFalse);

    // An older daemon sends no digest: the push works as before.
    bridge.downloadFiles['legacy'] = payload;
    final legacy = await run('download_file', {
      'token': 'legacy',
      'path': '${dir.path}/legacy.bin',
    });
    expect(legacy['ok'], isTrue);
  });

  test('advertises capabilities and answers device commands', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final bridge = await MockBridge.start();
    addTearDown(bridge.close);
    final client = BridgeClient(configFor(bridge));
    addTearDown(client.dispose);

    await client.connect();
    final rings = <String?>[];
    final service = MeshService(
      prefs,
      client,
      locationProvider: () async => const MeshFix(lat: 1, lon: 2, ts: 99),
      batteryProvider: () async =>
          const MeshBattery(percent: 55, charging: false),
      nameProvider: () async => 'Test phone',
      versionProvider: () async => '1.0.0+1',
      foregroundStarter: () async {},
      ringHandler: (message) async => rings.add(message),
      systemInfoProvider: () async => {
        'hardware': 'Google Pixel 9',
        'os': 'android 16',
        'locale': 'en_IE',
        'timezone': 'IST (UTC+01:00)',
        'network': 'wifi',
      },
    );
    addTearDown(service.stop);

    await service.start();
    await _waitFor(() => bridge.devices.length == 1);
    final id = bridge.devices.single['id'] as String;
    expect(
      bridge.devices.single['capabilities'],
      containsAll(['locate', 'ring', 'status']),
    );

    // Commands addressed to another device are ignored.
    await bridge.emit({
      'kind': 'device_command',
      'id': 'cmd-other',
      'deviceId': 'someone-else',
      'name': 'ring',
      'params': <String, dynamic>{},
    });

    await bridge.emit({
      'kind': 'device_command',
      'id': 'cmd-ring',
      'deviceId': id,
      'name': 'ring',
      'params': {'message': 'over here'},
    });
    await _waitFor(() => bridge.commandResults.length == 1);
    expect(rings, ['over here']);
    expect(bridge.commandResults.last, containsPair('commandId', 'cmd-ring'));
    expect(bridge.commandResults.last, containsPair('ok', true));

    await bridge.emit({
      'kind': 'device_command',
      'id': 'cmd-status',
      'deviceId': id,
      'name': 'status',
      'params': <String, dynamic>{},
    });
    await _waitFor(() => bridge.commandResults.length == 2);
    final statusResult = bridge.commandResults.last;
    expect(statusResult, containsPair('ok', true));
    expect(statusResult['data'], containsPair('battery', '55%'));
    expect(statusResult['data'], containsPair('name', 'Test phone'));
    expect(statusResult['data'], containsPair('hardware', 'Google Pixel 9'));
    expect(statusResult['data'], containsPair('network', 'wifi'));
    expect(statusResult['data'], containsPair('timezone', 'IST (UTC+01:00)'));

    // Unknown commands answer ok:false instead of leaving the daemon waiting.
    await bridge.emit({
      'kind': 'device_command',
      'id': 'cmd-unknown',
      'deviceId': id,
      'name': 'teleport',
      'params': <String, dynamic>{},
    });
    await _waitFor(() => bridge.commandResults.length == 3);
    expect(bridge.commandResults.last, containsPair('ok', false));

    // The command addressed elsewhere never produced a result.
    expect(
      bridge.commandResults.where((r) => r['commandId'] == 'cmd-other'),
      isEmpty,
    );
  });
}

Future<void> _waitFor(
  bool Function() test, {
  Duration timeout = const Duration(seconds: 2),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    if (test()) return;
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
  fail('condition not met before timeout');
}
