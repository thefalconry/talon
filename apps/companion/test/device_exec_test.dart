import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/services/device_exec.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory tmp;
  final exec = DeviceExec();

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('talon-exec-');
  });
  tearDown(() async {
    if (await tmp.exists()) await tmp.delete(recursive: true);
  });

  test('runs a shell command and captures stdout + exit code', () async {
    final r = await exec.exec('echo hello-device');
    expect(r.ok, isTrue);
    expect(r.data!['stdout'], contains('hello-device'));
    expect(r.data!['exitCode'], 0);
  });

  test('reports a non-zero exit', () async {
    final r = await exec.exec('exit 7');
    expect(r.ok, isFalse);
    expect(r.data!['exitCode'], 7);
  });

  test('a backgrounded child does not pin the exec open (pipe-drain grace)',
      () async {
    // The shell exits immediately; the orphaned `sleep` inherits stdout and
    // holds the pipe open for 30s. Before the drain grace, this call hung
    // until the mesh transport gave up — persistent streams (adb logcat &)
    // were impossible to launch.
    final sw = Stopwatch()..start();
    final r = await exec.exec('sleep 30 > /dev/null 2>&1 & echo bg-started');
    sw.stop();
    expect(r.ok, isTrue);
    expect(r.data!['stdout'], contains('bg-started'));
    expect(r.data!['exitCode'], 0);
    // Well under the old hang (bounded by exit + the 2s drain grace).
    expect(sw.elapsed, lessThan(const Duration(seconds: 10)));
  });

  test('shell invocation matches the platform terminal', () {
    expect(
      DeviceExec.shellInvocation('echo x', os: 'windows'),
      ['cmd', '/c', 'echo x'],
    );
    // macOS is a *login* zsh so the user's real PATH (Homebrew etc.) applies.
    expect(
      DeviceExec.shellInvocation('echo x', os: 'macos'),
      ['/bin/zsh', '-l', '-c', 'echo x'],
    );
    expect(
      DeviceExec.shellInvocation('echo x', os: 'linux'),
      ['sh', '-c', 'echo x'],
    );
    expect(
      DeviceExec.shellInvocation('echo x', os: 'android'),
      ['sh', '-c', 'echo x'],
    );
  });

  test('uses Shizuku only after the permission callback verifies readiness',
      () async {
    const channel = MethodChannel('talon/shizuku-test-ready');
    var ready = false;
    var permissionRequests = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      switch (call.method) {
        case 'getStatus':
          return {
            'ready': ready,
            'state': ready ? 'ready' : 'permission-needed'
          };
        case 'requestPermission':
          permissionRequests++;
          ready = true;
          return true;
        case 'exec':
          return {'stdout': 'shell', 'stderr': '', 'exitCode': 0};
      }
      return null;
    });
    addTearDown(() => TestDefaultBinaryMessengerBinding
        .instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null));

    final elevated = DeviceExec(shizukuChannel: channel, isAndroid: () => true);
    final result = await elevated.exec('id');

    expect(permissionRequests, 1);
    expect(result.ok, isTrue);
    expect(result.data!['via'], 'shizuku');
    expect(result.data!['stdout'], 'shell');
  });

  test('marks app-UID results as limited when Shizuku is unavailable',
      () async {
    const channel = MethodChannel('talon/shizuku-test-unavailable');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'getStatus') {
        return {'ready': false, 'state': 'not-running'};
      }
      if (call.method == 'requestPermission') return false;
      return null;
    });
    addTearDown(() => TestDefaultBinaryMessengerBinding
        .instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null));

    final limited = DeviceExec(shizukuChannel: channel, isAndroid: () => true);
    final result = await limited.exec('printf app');

    expect(result.ok, isTrue);
    expect(result.data!['via'], 'app');
    // The fallback warning surfaces the actual Shizuku state (why it wasn't
    // used) so a remote caller can diagnose without adb.
    expect(result.data!['privilegeWarning'], contains('shizuku=not-running'));
    expect(result.data!['privilegeWarning'], contains('app UID'));
  });

  test('root outranks Shizuku and never falls through to it', () async {
    const root = MethodChannel('talon/root-test-ready');
    const shizuku = MethodChannel('talon/shizuku-test-outranked');
    var shizukuCalls = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(root, (call) async {
      switch (call.method) {
        case 'getStatus':
          return {'tier': 'root', 'method': 'su', 'state': 'root via su', 'uid': 10123};
        case 'exec':
          return {
            'stdout': 'uid=0',
            'stderr': '',
            'exitCode': 0,
            'via': 'su',
          };
      }
      return null;
    });
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(shizuku, (call) async {
      shizukuCalls++;
      return null;
    });
    addTearDown(() {
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(root, null);
      messenger.setMockMethodCallHandler(shizuku, null);
    });

    final elevated = DeviceExec(
      rootChannel: root,
      shizukuChannel: shizuku,
      isAndroid: () => true,
    );
    final result = await elevated.exec('id -u');

    expect(shizukuCalls, 0);
    expect(result.ok, isTrue);
    expect(result.data!['via'], 'root');
    // How root was reached travels with the result, so a mesh reply
    // distinguishes a Magisk grant from the adb agent without another probe.
    expect(result.data!['rootMethod'], 'su');
    expect(result.data!['stdout'], 'uid=0');
  });

  test('a failing root path degrades to Shizuku for the same command',
      () async {
    const root = MethodChannel('talon/root-test-broken');
    const shizuku = MethodChannel('talon/shizuku-test-rescue');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(root, (call) async {
      if (call.method == 'getStatus') {
        return {'tier': 'root', 'method': 'agent', 'state': 'root via the adb agent'};
      }
      // The agent died between the probe and the command.
      throw PlatformException(code: 'root_unavailable');
    });
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(shizuku, (call) async {
      switch (call.method) {
        case 'getStatus':
          return {'ready': true, 'state': 'ready', 'uid': 2000};
        case 'exec':
          return {'stdout': 'shell', 'stderr': '', 'exitCode': 0};
      }
      return null;
    });
    addTearDown(() {
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(root, null);
      messenger.setMockMethodCallHandler(shizuku, null);
    });

    final dev = DeviceExec(
      rootChannel: root,
      shizukuChannel: shizuku,
      isAndroid: () => true,
    );
    final result = await dev.exec('id -u');

    expect(result.ok, isTrue);
    expect(result.data!['via'], 'shizuku');
    // Root was demoted, so the tier reported afterwards matches what actually
    // ran rather than the stale probe.
    expect((await dev.privilegeStatus())['execPrivilege'], 'shizuku');
  });

  test('a Shizuku server started as root is reported as root, not shell',
      () async {
    const root = MethodChannel('talon/root-test-absent');
    const shizuku = MethodChannel('talon/shizuku-test-uid0');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(root, (call) async {
      if (call.method == 'getStatus') {
        return {'tier': 'app', 'method': 'none', 'state': 'no root'};
      }
      return null;
    });
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(shizuku, (call) async {
      if (call.method == 'getStatus') {
        // uid 0 = Shizuku's own server was started from a root adb shell.
        return {'ready': true, 'state': 'ready', 'uid': 0};
      }
      return null;
    });
    addTearDown(() {
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(root, null);
      messenger.setMockMethodCallHandler(shizuku, null);
    });

    final dev = DeviceExec(
      rootChannel: root,
      shizukuChannel: shizuku,
      isAndroid: () => true,
    );
    final privilege = await dev.privilegeStatus();

    expect(privilege['execPrivilege'], 'root');
    expect(privilege['execVia'], 'shizuku');
    expect(privilege['shizuku'], contains('uid 0'));
  });

  test('caps runaway exec output but keeps the tail (cwd marker survives)',
      () async {
    // 400KB of noise then a trailing marker — like the teleport wrapper's
    // cwd marker, which is always the LAST bytes of stdout. The cap must
    // elide the middle, never the tail.
    final r = await exec.exec(
      "dd if=/dev/zero bs=1024 count=400 2>/dev/null | tr '\\0' x; "
      'printf TALON_TAIL_MARKER',
    );
    expect(r.ok, isTrue);
    final stdout = r.data!['stdout'] as String;
    expect(stdout.length, lessThan(300 * 1024));
    expect(stdout, contains('chars truncated'));
    expect(stdout, endsWith('TALON_TAIL_MARKER'));
  });

  test('desktop exec never consults Shizuku and stays unannotated', () async {
    const channel = MethodChannel('talon/shizuku-test-desktop');
    var channelCalls = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      channelCalls++;
      return null;
    });
    addTearDown(() => TestDefaultBinaryMessengerBinding
        .instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null));

    final desktop = DeviceExec(shizukuChannel: channel, isAndroid: () => false);
    final result = await desktop.exec('echo desktop');

    expect(channelCalls, 0);
    expect(result.ok, isTrue);
    expect(result.data!.containsKey('via'), isFalse);
    expect(result.data!.containsKey('privilegeWarning'), isFalse);
    expect(await desktop.privilegeStatus(), {'execPrivilege': 'user'});
  });

  test('writes then reads a file in chunks (base64 roundtrip)', () async {
    final f = '${tmp.path}/note.txt';
    final content = 'A' * (300 * 1024); // > one 256KB chunk
    // First chunk truncates, second appends.
    final first = utf8.encode(content.substring(0, 256 * 1024));
    final second = utf8.encode(content.substring(256 * 1024));
    final w1 =
        await exec.writeFile(f, base64Encode(first), offset: 0, truncate: true);
    expect(w1.ok, isTrue);
    final w2 = await exec.writeFile(f, base64Encode(second),
        offset: first.length, truncate: false);
    expect(w2.ok, isTrue);

    // Read back the first chunk and confirm eof=false, then final chunk.
    final r1 = await exec.readFile(f, offset: 0, len: 256 * 1024);
    expect(r1.ok, isTrue);
    expect(r1.data!['eof'], isFalse);
    final r2 = await exec.readFile(f, offset: 256 * 1024, len: 256 * 1024);
    expect(r2.data!['eof'], isTrue);
    expect(await File(f).length(), content.length);
  });

  test('rejects an out-of-order or duplicate chunk instead of appending',
      () async {
    final f = '${tmp.path}/ordered.txt';
    final w1 = await exec.writeFile(f, base64Encode(utf8.encode('hello ')),
        offset: 0, truncate: true);
    expect(w1.ok, isTrue);

    // Duplicate retry of the first chunk (offset 0 again) must not append.
    final dup = await exec.writeFile(f, base64Encode(utf8.encode('hello ')),
        offset: 0, truncate: false);
    expect(dup.ok, isFalse);
    expect(dup.message, contains('out-of-order'));

    // A gap (offset beyond current size) must be rejected too.
    final gap = await exec.writeFile(f, base64Encode(utf8.encode('!')),
        offset: 100, truncate: false);
    expect(gap.ok, isFalse);

    // The correctly-ordered chunk still lands.
    final w2 = await exec.writeFile(f, base64Encode(utf8.encode('world')),
        offset: 6, truncate: false);
    expect(w2.ok, isTrue);
    expect(await File(f).readAsString(), 'hello world');
  });

  test('lists a directory and stats a file', () async {
    await File('${tmp.path}/a.txt').writeAsString('hi');
    await Directory('${tmp.path}/sub').create();
    final ls = await exec.listDir(tmp.path);
    expect(ls.ok, isTrue);
    final names = (ls.data!['entries'] as List).map((e) => e['name']).toList();
    expect(names, containsAll(['a.txt', 'sub']));

    final st = await exec.statPath('${tmp.path}/a.txt');
    expect(st.ok, isTrue);
    expect(st.data!['type'], 'file');
    expect(st.data!['size'], 2);
  });

  test('handle() dispatches by command name and ignores unknown', () async {
    final ok = await exec.handle('exec', {'cmd': 'echo x'});
    expect(ok, isNotNull);
    expect(ok!.ok, isTrue);
    final unknown = await exec.handle('teleport_home', {});
    expect(unknown, isNull);
  });

  group('install_apk', () {
    test('is refused on non-Android platforms', () async {
      final desktop = DeviceExec(isAndroid: () => false);
      final r = await desktop.installApk('${tmp.path}/app.apk');
      expect(r.ok, isFalse);
      expect(r.message, contains('only supported on Android'));
    });

    test('fails clearly when Shizuku is unavailable', () async {
      const channel = MethodChannel('talon/shizuku-install-noshizuku');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'getStatus') {
          return {'ready': false, 'state': 'not-running'};
        }
        if (call.method == 'requestPermission') return false;
        return null;
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding
          .instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null));

      final apk = File('${tmp.path}/app.apk')..writeAsStringSync('fake-apk');
      final dev = DeviceExec(shizukuChannel: channel, isAndroid: () => true);
      final r = await dev.installApk(apk.path);
      expect(r.ok, isFalse);
      expect(r.message, contains('Shizuku'));
    });

    const goodSha =
        'abc1230000000000000000000000000000000000000000000000000000000000';

    /// A Shizuku bridge whose exec answers the staging step with [stage] and
    /// records every command it was asked to run.
    List<String> mockShizuku(
      MethodChannel channel,
      Map<String, Object> stage,
    ) {
      final execCmds = <String>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'getStatus') {
          return {'ready': true, 'state': 'ready'};
        }
        if (call.method == 'exec') {
          final cmd = (call.arguments as Map)['cmd'] as String;
          execCmds.add(cmd);
          if (cmd.contains('mktemp')) return stage;
          return {'stdout': '', 'stderr': '', 'exitCode': 0};
        }
        return null;
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding
          .instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null));
      return execCmds;
    }

    test('aborts on a sha256 mismatch before touching pm', () async {
      const channel = MethodChannel('talon/shizuku-install-badhash');
      final execCmds = mockShizuku(channel, {
        'stdout': '',
        'stderr': 'deadbeef',
        'exitCode': 6,
      });
      final dev = DeviceExec(shizukuChannel: channel, isAndroid: () => true);
      final r = await dev.installApk('/sdcard/Download/app.apk', sha256: goodSha);
      expect(r.ok, isFalse);
      expect(r.message, contains('integrity check failed'));
      expect(r.message, contains('deadbeef'));
      expect(execCmds.any((c) => c.contains('pm install')), isFalse);
    });

    test('refuses a malformed digest without touching the device', () async {
      const channel = MethodChannel('talon/shizuku-install-malformed');
      final execCmds = mockShizuku(channel, {'exitCode': 0, 'stdout': ''});
      final dev = DeviceExec(shizukuChannel: channel, isAndroid: () => true);
      final r = await dev.installApk('/sdcard/app.apk', sha256: 'cafe; reboot');
      expect(r.ok, isFalse);
      expect(execCmds, isEmpty);
    });

    test('reports a missing APK', () async {
      const channel = MethodChannel('talon/shizuku-install-missing');
      mockShizuku(channel, {'stdout': '', 'stderr': '', 'exitCode': 3});
      final dev = DeviceExec(shizukuChannel: channel, isAndroid: () => true);
      final r = await dev.installApk('/sdcard/nope.apk');
      expect(r.ok, isFalse);
      expect(r.message, contains('No such APK'));
    });

    test('stages privately and detaches a same-or-newer pm install', () async {
      const channel = MethodChannel('talon/shizuku-install-ok');
      const dir = '/data/local/tmp/talon-update.Ab12Cd34Ef';
      final execCmds = mockShizuku(channel, {
        'stdout': '$dir\n',
        'stderr': '',
        'exitCode': 0,
      });
      final dev = DeviceExec(shizukuChannel: channel, isAndroid: () => true);
      final r = await dev.installApk(
        '/sdcard/Download/app.apk',
        sha256: goodSha.toUpperCase(),
        delayMs: 1000,
      );
      expect(r.ok, isTrue, reason: r.message);
      expect(r.data!['staged'], isTrue);
      expect(r.data!['via'], 'shizuku');
      expect(r.data!['stagedPath'], '$dir/update.apk');
      expect(r.data!['log'], '$dir/install.log');
      // Staging (probe + private copy + hash) is one elevated invocation.
      final stage = execCmds.firstWhere((c) => c.contains('mktemp'));
      expect(stage, contains('/sdcard/Download/app.apk'));
      expect(stage, contains(goodSha));
      // The install is detached (setsid + background), re-verifies the digest
      // and never allows a downgrade.
      final install = execCmds.firstWhere((c) => c.contains('pm install'));
      expect(install, contains('setsid'));
      expect(install, contains('pm install -r '));
      expect(install, isNot(contains('-d ')));
      expect(install, contains('sha256sum'));
      expect(install, contains('$dir/update.apk'));
    });

    test('allow_downgrade opts the install into pm install -d', () async {
      const channel = MethodChannel('talon/shizuku-install-downgrade');
      const dir = '/data/local/tmp/talon-update.Zz98Yy76Xx';
      final execCmds = mockShizuku(channel, {
        'stdout': '$dir\n',
        'stderr': '',
        'exitCode': 0,
      });
      final dev = DeviceExec(shizukuChannel: channel, isAndroid: () => true);
      final r = await dev.handle('install_apk', {
        'path': '/sdcard/Download/app.apk',
        'sha256': goodSha,
        'allow_downgrade': true,
      });
      expect(r!.ok, isTrue, reason: r.message);
      expect(r.data!['allowDowngrade'], isTrue);
      final install = execCmds.firstWhere((c) => c.contains('pm install'));
      expect(install, contains('pm install -r -d '));
    });

    test('refuses a staging directory it did not ask for', () async {
      const channel = MethodChannel('talon/shizuku-install-oddpath');
      final execCmds = mockShizuku(channel, {
        'stdout': '/sdcard/elsewhere\n',
        'stderr': '',
        'exitCode': 0,
      });
      final dev = DeviceExec(shizukuChannel: channel, isAndroid: () => true);
      final r = await dev.installApk('/sdcard/app.apk');
      expect(r.ok, isFalse);
      expect(execCmds.any((c) => c.contains('pm install')), isFalse);
    });

    group('staging and install scripts (run for real in sh)', () {
      late Directory root;
      late Directory bin;
      late File apk;
      late String apkSha;

      setUp(() async {
        root = await Directory('${tmp.path}/stage').create();
        bin = await Directory('${tmp.path}/bin').create();
        apk = File('${tmp.path}/app.apk')..writeAsStringSync('fake-apk');
        final sum = await Process.run('sha256sum', [apk.path]);
        apkSha = (sum.stdout as String).split(' ').first;
        // A stand-in pm that records its arguments.
        final pm = File('${bin.path}/pm')
          ..writeAsStringSync('#!/bin/sh\necho "\$@" > "${tmp.path}/pm-args"\n');
        await Process.run('chmod', ['+x', pm.path]);
      });

      Future<ProcessResult> sh(String script) => Process.run(
            'sh',
            ['-c', script],
            environment: {
              'PATH': '${bin.path}:${Platform.environment['PATH']}',
            },
          );

      test('stages into a fresh private directory', () async {
        final r = await sh(
          DeviceExec.stageApkScript(apk.path, apkSha, root: root.path),
        );
        expect(r.exitCode, 0, reason: '${r.stderr}');
        final dir = (r.stdout as String).trim();
        expect(dir, startsWith('${root.path}/talon-update.'));
        expect(File('$dir/update.apk').readAsStringSync(), 'fake-apk');
        expect(FileStat.statSync(dir).mode & 0x1ff, 0x1c0); // 0700
      });

      test('a digest mismatch leaves nothing behind', () async {
        final wrong = '0' * 64;
        final r = await sh(
          DeviceExec.stageApkScript(apk.path, wrong, root: root.path),
        );
        expect(r.exitCode, 6);
        expect((r.stderr as String).trim(), apkSha);
        expect(root.listSync(), isEmpty);
      });

      test('a missing source exits 3', () async {
        final r = await sh(
          DeviceExec.stageApkScript('${tmp.path}/nope.apk', '', root: root.path),
        );
        expect(r.exitCode, 3);
      });

      test('the worker installs only the bytes it verified', () async {
        final staged = await sh(
          DeviceExec.stageApkScript(apk.path, apkSha, root: root.path),
        );
        final dir = (staged.stdout as String).trim();
        final args = File('${tmp.path}/pm-args');

        // Tampered after staging: the worker's own re-check refuses it.
        File('$dir/update.apk').writeAsStringSync('evil-apk');
        await sh(DeviceExec.installApkWorker(dir, apkSha, 0));
        expect(args.existsSync(), isFalse);
        expect(File('$dir/install.log').readAsStringSync(),
            contains('integrity check failed'));
        expect(File('$dir/update.apk').existsSync(), isFalse);

        // Intact: pm installs it with -r and without -d.
        final again = await sh(
          DeviceExec.stageApkScript(apk.path, apkSha, root: root.path),
        );
        final dir2 = (again.stdout as String).trim();
        await sh(DeviceExec.installApkWorker(dir2, apkSha, 0));
        expect(args.readAsStringSync().trim(), 'install -r $dir2/update.apk');
        expect(File('$dir2/install.log').readAsStringSync(), contains('exit=0'));
        expect(File('$dir2/update.apk').existsSync(), isFalse);

        // Opted in: the same pipeline adds -d for a deliberate rollback.
        final third = await sh(
          DeviceExec.stageApkScript(apk.path, apkSha, root: root.path),
        );
        final dir3 = (third.stdout as String).trim();
        await sh(
            DeviceExec.installApkWorker(dir3, apkSha, 0, allowDowngrade: true));
        expect(
            args.readAsStringSync().trim(), 'install -r -d $dir3/update.apk');
      });
    }, skip: !Platform.isLinux);

    test('routes through handle() by name', () async {
      final desktop = DeviceExec(isAndroid: () => false);
      final r = await desktop.handle('install_apk', {'path': '/x/app.apk'});
      expect(r, isNotNull);
      expect(r!.ok, isFalse); // non-Android → refused, but dispatched
    });
  });
}
