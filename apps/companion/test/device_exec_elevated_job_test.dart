import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/services/device_exec.dart';

/// Stands in for the root or Shizuku bridge by running each script in a real
/// shell, so these tests exercise the job scripts themselves.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory tmp;
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('talon-ejob-');
  });
  tearDown(() async {
    await Process.run('sh', [
      '-c',
      'for f in "${tmp.path}"/talon-job.*/pid; do '
          '[ -f "\$f" ] && kill -9 -"\$(cat "\$f")" 2>/dev/null; done; true',
    ]);
    await tmp.delete(recursive: true);
  });

  DeviceExec shizukuExec(String name, {void Function(String)? onExec}) {
    final channel = MethodChannel('talon/shizuku-ejob-$name');
    messenger.setMockMethodCallHandler(channel, (call) async {
      switch (call.method) {
        case 'getStatus':
        case 'checkPermission':
        case 'requestPermission':
          return {'state': 'granted', 'ready': true, 'granted': true};
        case 'exec':
          final args = Map<String, dynamic>.from(call.arguments as Map);
          onExec?.call(args['cmd'] as String);
          final r = await Process.run(
              'sh',
              [
                '-c',
                args['cmd'] as String,
              ],
              workingDirectory: args['cwd'] as String?);
          return {
            'stdout': r.stdout,
            'stderr': r.stderr,
            'exitCode': r.exitCode,
          };
      }
      return null;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    return DeviceExec(
      elevatedJobRoot: tmp.path,
      shizukuChannel: channel,
      rootChannel: MethodChannel('talon/root-ejob-absent-$name'),
      isAndroid: () => true,
    );
  }

  Future<bool> alive(String pid) async =>
      (await Process.run('kill', ['-0', pid])).exitCode == 0;

  test('a command that ends in budget reads like a plain exec', () async {
    final exec = shizukuExec('quick');
    final r = await exec.exec(
      "echo out; echo err >&2; printf 'R\\n'; exit 3",
      timeoutMs: 5000,
      detachOnTimeout: true,
    );
    expect(r.ok, isFalse);
    expect(r.data!['exitCode'], 3);
    expect(r.data!['stdout'], 'out\nR\n');
    expect(r.data!['stderr'], 'err\n');
    expect(r.data!['via'], 'shizuku');
    expect(r.data!.containsKey('detached'), isFalse);
  });

  test('a command past its budget survives, and finishes as a job', () async {
    final exec = shizukuExec('slow');
    final marker = '${tmp.path}/done';
    final r = await exec.exec(
      'echo begun; sleep 2; echo end; touch $marker; exit 7',
      timeoutMs: 1000,
      detachOnTimeout: true,
    );
    expect(r.ok, isTrue);
    expect(r.data!['detached'], isTrue);
    expect(File(marker).existsSync(), isFalse);
    final id = r.data!['jobId'] as String;
    expect(id, startsWith('ejob_shizuku_'));

    final running = await exec.execJob(id);
    expect(running.data!['running'], isTrue);
    expect(running.data!['stdout'], 'begun\n');

    while (!File(marker).existsSync()) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    await Future<void>.delayed(const Duration(milliseconds: 300));
    final done = await exec.execJob(id);
    expect(done.data!['running'], isFalse);
    expect(done.data!['exitCode'], 7);
    expect(done.data!['stdout'], 'begun\nend\n');
  });

  test('kill stops the whole job, children included', () async {
    final exec = shizukuExec('kill');
    final childPid = '${tmp.path}/child';
    final r = await exec.exec(
      'sleep 60 & echo \$! > $childPid; wait',
      timeoutMs: 1000,
      detachOnTimeout: true,
    );
    final id = r.data!['jobId'] as String;
    final child = File(childPid).readAsStringSync().trim();
    expect(await alive(child), isTrue);

    final killed = await exec.execJob(id, action: 'kill');
    expect(killed.data!['running'], isFalse);
    expect(killed.data!['exitCode'], 137);
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(await alive(child), isFalse);
  });

  test('a job is still readable by a new executor', () async {
    final first = shizukuExec('restart-a');
    final r = await first.exec(
      'echo hi; sleep 30',
      timeoutMs: 1000,
      detachOnTimeout: true,
    );
    final second = shizukuExec('restart-b');
    final read = await second.execJob(r.data!['jobId'] as String);
    expect(read.ok, isTrue);
    expect(read.data!['running'], isTrue);
    expect(read.data!['stdout'], 'hi\n');
  });

  test('a job with a dead process and no exit file reads as lost', () async {
    final exec = shizukuExec('lost');
    final dir = Directory('${tmp.path}/talon-job.gone1')..createSync();
    File('${dir.path}/pid').writeAsStringSync('999999\n');
    final read = await exec.execJob('ejob_shizuku_gone1');
    expect(read.data!['running'], isFalse);
    expect(read.data!['exitCode'], -1);
  });

  test('ids that could reach the shell are refused unrun', () async {
    final scripts = <String>[];
    final exec = shizukuExec('inject', onExec: scripts.add);
    for (final id in [
      "ejob_shizuku_x'; touch pwned; '",
      'ejob_shizuku_../../etc',
      'ejob_other_abc',
      'ejob_shizuku_',
    ]) {
      final r = await exec.execJob(id);
      expect(r.ok, isFalse, reason: id);
    }
    expect(scripts, isEmpty);
  });

  test('a full job table falls back to a plain exec', () async {
    final scripts = <String>[];
    final exec = shizukuExec('full', onExec: scripts.add);
    final sleepers = <Process>[];
    addTearDown(() {
      for (final p in sleepers) {
        p.kill(ProcessSignal.sigkill);
      }
    });
    for (var i = 0; i < DeviceExec.maxRunningExecJobs; i++) {
      final p = await Process.start('sleep', ['30']);
      sleepers.add(p);
      final d = Directory('${tmp.path}/talon-job.full$i')..createSync();
      File('${d.path}/pid').writeAsStringSync('${p.pid}\n');
    }
    final r = await exec.exec(
      'echo direct',
      timeoutMs: 2000,
      detachOnTimeout: true,
    );
    expect(r.data!['stdout'], 'direct\n');
    expect(scripts.last, 'echo direct');
  });

  test('a job that cannot be started does not run twice', () async {
    const channel = MethodChannel('talon/shizuku-ejob-throw');
    var execs = 0;
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'exec') {
        execs++;
        throw PlatformException(code: 'boom');
      }
      return {'state': 'granted', 'ready': true, 'granted': true};
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    final exec = DeviceExec(
      elevatedJobRoot: tmp.path,
      shizukuChannel: channel,
      rootChannel: const MethodChannel('talon/root-ejob-absent-throw'),
      isAndroid: () => true,
    );
    final r = await exec.exec(
      'echo once > ${tmp.path}/ran',
      timeoutMs: 1000,
      detachOnTimeout: true,
    );
    expect(r.ok, isFalse);
    expect(execs, 1);
    expect(File('${tmp.path}/ran').existsSync(), isFalse);
  });
}
