import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/services/bridge_client.dart';
import 'package:talon_companion/src/services/mesh_audit.dart';
import 'package:talon_companion/src/services/mesh_service.dart';
import 'package:talon_companion/src/services/prefs.dart';

import 'mock_bridge.dart';

MeshAuditEntry _entry(String id, {bool ok = true, String name = 'stat'}) =>
    MeshAuditEntry(
      ts: 1000,
      commandId: id,
      name: name,
      target: '/tmp/$id',
      ok: ok,
      error: ok ? null : 'boom',
      durationMs: 3,
      credential: 'shared',
      tier: 'app',
    );

void main() {
  late Directory dir;
  late File file;

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('talon-mesh-audit-');
    file = File('${dir.path}/${MeshAudit.fileName}');
  });
  tearDown(() => dir.delete(recursive: true));

  MeshAudit auditAt(File f, {int keep = MeshAudit.defaultKeep}) =>
      MeshAudit(file: () async => f, keep: keep);

  test('records entries and reads them back newest first', () async {
    final audit = auditAt(file);
    for (final id in ['c0', 'c1', 'c2']) {
      await audit.record(_entry(id));
    }
    final all = await audit.read();
    expect(all.map((e) => e.commandId), ['c2', 'c1', 'c0']);
    expect(all.first.target, '/tmp/c2');
    expect(all.first.tier, 'app');
    expect((await audit.read(limit: 1)).single.commandId, 'c2');
    // A second instance (the UI isolate) reads what the first wrote.
    expect((await auditAt(file).read()).length, 3);
    if (Platform.isLinux) {
      final mode = (await file.stat()).modeString();
      expect(mode, 'rw-------');
    }
  });

  test('stays a bounded ring', () async {
    final audit = auditAt(file, keep: 5);
    for (var i = 0; i < 23; i++) {
      await audit.record(_entry('c$i'));
    }
    final lines = (await file.readAsLines()).where((l) => l.isNotEmpty);
    expect(lines.length, lessThan(10));
    final all = await audit.read();
    expect(all.first.commandId, 'c22');
    expect(all.length, greaterThanOrEqualTo(5));
  });

  test('concurrent records all land', () async {
    final audit = auditAt(file);
    await Future.wait([
      for (var i = 0; i < 20; i++) audit.record(_entry('c$i')),
    ]);
    expect((await audit.read()).length, 20);
  });

  test('clear empties the log', () async {
    final audit = auditAt(file);
    await audit.record(_entry('c0'));
    await audit.clear();
    expect(await audit.read(), isEmpty);
    await audit.record(_entry('c1'));
    expect((await audit.read()).single.commandId, 'c1');
  });

  test('never throws when the file cannot be written or resolved', () async {
    final blocker = File('${dir.path}/blocker')..writeAsStringSync('x');
    final broken = auditAt(File('${blocker.path}/nested/audit.jsonl'));
    await broken.record(_entry('c0'));
    expect(await broken.read(), isEmpty);

    final none = MeshAudit(file: () async => null);
    await none.record(_entry('c0'));
    expect(await none.read(), isEmpty);

    final throwing = MeshAudit(file: () async => throw StateError('no dir'));
    await throwing.record(_entry('c0'));
    expect(await throwing.read(), isEmpty);
  });

  test('skips torn lines', () async {
    await file.writeAsString('{"ts":1,"name":"stat","ok":true}\n{"ts":2,"na');
    final all = await auditAt(file).read();
    expect(all.single.name, 'stat');
  });

  group('entryFor', () {
    test('hashes the exec command line, never records it', () {
      const cmd = "curl -H 'Authorization: Bearer hunter2' https://x";
      final e = MeshAudit.entryFor(
        commandId: 'c1',
        name: 'exec',
        params: {'cmd': cmd, 'cwd': '/'},
        ok: true,
        message: null,
        data: {'stdout': 'secret output', 'via': 'root'},
        elapsed: const Duration(milliseconds: 42),
        token: 'shared-token',
      );
      expect(e.target, startsWith('sha256:'));
      expect(e.target!.length, 'sha256:'.length + 64);
      final json = e.toJson().toString();
      expect(json, isNot(contains('hunter2')));
      expect(json, isNot(contains('secret output')));
      expect(json, isNot(contains('shared-token')));
      expect(e.tier, 'root');
      expect(e.durationMs, 42);
      expect(e.credential, 'shared');
    });

    test('records paths, not file bodies', () {
      final e = MeshAudit.entryFor(
        commandId: 'c1',
        name: 'write_file',
        params: {'path': '/sdcard/a.txt', 'base64': 'c2VjcmV0'},
        ok: false,
        message: 'write_file failed:\nno space',
        data: null,
        elapsed: Duration.zero,
        token: null,
      );
      expect(e.target, '/sdcard/a.txt');
      expect(e.toJson().toString(), isNot(contains('c2VjcmV0')));
      expect(e.error, 'write_file failed: no space');
      expect(e.tier, 'app');
      expect(e.credential, 'none');
    });

    test('moves record both ends; clips long errors', () {
      final e = MeshAudit.entryFor(
        commandId: 'c1',
        name: 'move',
        params: {'from': '/a', 'to': '/b'},
        ok: false,
        message: 'x' * 1000,
        data: null,
        elapsed: Duration.zero,
        token: 'tdc1.0123456789abcdef.${'A' * 43}',
      );
      expect(e.target, '/a -> /b');
      expect(e.error!.length, MeshAudit.maxError + 1);
      expect(e.credential, 'device:0123456789abcdef');
    });
  });

  test('MeshService audits each command after answering it', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final bridge = await MockBridge.start();
    addTearDown(bridge.close);
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
    final audit = auditAt(file);
    final service = MeshService(
      prefs,
      client,
      batteryProvider: () async => const MeshBattery(),
      nameProvider: () async => 'Test phone',
      versionProvider: () async => '1.0.0+1',
      foregroundStarter: () async {},
      systemInfoProvider: () async => const {},
      audit: audit,
    );
    addTearDown(service.stop);
    await service.start();
    await _waitFor(() => bridge.devices.length == 1);
    final id = bridge.devices.single['id'] as String;

    await bridge.emit({
      'kind': 'device_command',
      'id': 'cmd-stat',
      'deviceId': id,
      'name': 'stat',
      'params': {'path': dir.path},
    });
    await bridge.emit({
      'kind': 'device_command',
      'id': 'cmd-bad',
      'deviceId': id,
      'name': 'read_file',
      'params': {'path': '${dir.path}/missing'},
    });
    await _waitFor(() => bridge.commandResults.length == 2);
    List<MeshAuditEntry> entries = const [];
    await _waitForAsync(() async {
      entries = await audit.read();
      return entries.length == 2;
    });
    final byId = {for (final e in entries) e.commandId: e};
    expect(byId['cmd-stat']!.ok, isTrue);
    expect(byId['cmd-stat']!.target, dir.path);
    expect(byId['cmd-stat']!.tier, 'app');
    expect(byId['cmd-bad']!.ok, isFalse);
    expect(byId['cmd-bad']!.error, contains('No such file'));
  });
}

Future<void> _waitFor(bool Function() test) =>
    _waitForAsync(() async => test());

Future<void> _waitForAsync(Future<bool> Function() test) async {
  final deadline = DateTime.now().add(const Duration(seconds: 3));
  while (DateTime.now().isBefore(deadline)) {
    if (await test()) return;
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
  fail('condition not met before timeout');
}
