import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/services/device_exec.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/services/update_installer.dart';
import 'package:talon_companion/src/services/updater.dart';

/// Counts silent-install attempts; never elevated, so it always declines.
class _RecordingExec extends DeviceExec {
  _RecordingExec() : super(isAndroid: () => true);
  int installs = 0;

  @override
  Future<CommandOutcome> installApk(
    String path, {
    String? sha256,
    int? delayMs,
    bool allowDowngrade = false,
  }) async {
    installs++;
    return CommandOutcome.fail('no root or Shizuku');
  }
}

/// Records what it was handed instead of touching the machine.
class _FakeInstaller implements UpdateInstaller {
  _FakeInstaller(this.dir,
      {this.outcome = const InstallOutcome.restartPending('ready')});

  final Directory dir;
  final InstallOutcome outcome;
  File? installed;
  int quits = 0;

  @override
  Future<Directory> stagingDir() async => dir;

  @override
  Future<InstallOutcome> install(File artifact, UpdateRelease release) async {
    installed = artifact;
    return outcome;
  }

  @override
  Future<void> quitForSwap() async => quits++;
}

Map<String, dynamic> _feed({
  required String tag,
  required List<int> apkBytes,
  String assetName = 'talon-companion-android.apk',
  bool withDigest = true,
  String body = 'Release notes',
}) =>
    {
      'tag_name': tag,
      'html_url': 'https://github.com/thefalconry/talon/releases/tag/$tag',
      'body': body,
      'assets': [
        {
          'name': 'SHA256SUMS',
          'browser_download_url': 'https://example.invalid/SHA256SUMS',
          'size': 42,
        },
        {
          'name': assetName,
          'browser_download_url': 'https://example.invalid/$assetName',
          'size': apkBytes.length,
          if (withDigest) 'digest': 'sha256:${sha256.convert(apkBytes)}',
        },
      ],
    };

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final apk = utf8.encode('a pretend APK');

  Future<Prefs> freshPrefs([Map<String, Object> seed = const {}]) async {
    SharedPreferences.setMockInitialValues(seed);
    return Prefs.load();
  }

  group('AppVersion', () {
    test('parses release tags, plain versions and Flutter build strings', () {
      expect(AppVersion.tryParse('v4.2.0').toString(), '4.2.0');
      expect(AppVersion.tryParse('4.2.0+402000').toString(), '4.2.0');
      expect(AppVersion.tryParse(' 4.2 ').toString(), '4.2.0');
      expect(AppVersion.tryParse('v4.2.0-rc.1')!.isPreRelease, isTrue);
    });

    test('rejects nonsense rather than guessing at it', () {
      expect(AppVersion.tryParse(''), isNull);
      expect(AppVersion.tryParse('nightly'), isNull);
      expect(AppVersion.tryParse('4.2.0.1'), isNull);
      expect(AppVersion.tryParse('4.x.0'), isNull);
    });

    test('orders numerically, not lexically', () {
      // The bug this pins: '4.10.0' < '4.9.0' as strings.
      expect(AppVersion.tryParse('4.10.0')! > AppVersion.tryParse('4.9.0')!,
          isTrue);
      expect(AppVersion.tryParse('5.0.0')! > AppVersion.tryParse('4.99.99')!,
          isTrue);
      expect(AppVersion.tryParse('4.1.0')! <= AppVersion.tryParse('4.1.0')!,
          isTrue);
    });

    test('a pre-release sorts below the release it leads to', () {
      final rc = AppVersion.tryParse('4.2.0-rc.1')!;
      final rc2 = AppVersion.tryParse('4.2.0-rc.2')!;
      final stable = AppVersion.tryParse('4.2.0')!;
      expect(rc < stable, isTrue);
      expect(rc < rc2, isTrue);
      expect(rc > AppVersion.tryParse('4.1.9')!, isTrue);
    });
  });

  group('UpdateRelease.fromFeedJson', () {
    test('picks this platform’s asset and its published digest', () {
      final rel = UpdateRelease.fromFeedJson(
        _feed(tag: 'v4.2.0', apkBytes: apk),
        platform: 'android',
      )!;
      expect(rel.version.toString(), '4.2.0');
      expect(rel.assetName, 'talon-companion-android.apk');
      expect(rel.assetSize, apk.length);
      expect(rel.sha256, sha256.convert(apk).toString());
      expect(rel.notes, 'Release notes');
    });

    test('a missing or malformed digest leaves sha256 unset', () {
      final none = UpdateRelease.fromFeedJson(
        _feed(tag: 'v4.2.0', apkBytes: apk, withDigest: false),
        platform: 'android',
      )!;
      expect(none.sha256, isNull);
      final feed = _feed(tag: 'v4.2.0', apkBytes: apk);
      ((feed['assets'] as List)[1] as Map)['digest'] = 'sha256:not-hex';
      expect(
        UpdateRelease.fromFeedJson(feed, platform: 'android')!.sha256,
        isNull,
      );
    });

    test('every shipped platform has an asset name, web has none', () {
      expect(
          UpdateRelease.assetNameFor('android'), 'talon-companion-android.apk');
      expect(
          UpdateRelease.assetNameFor('windows'), 'talon-companion-windows.zip');
      expect(UpdateRelease.assetNameFor('macos'), 'talon-companion-macos.dmg');
      expect(
          UpdateRelease.assetNameFor('linux'), 'talon-companion-linux.tar.gz');
      expect(UpdateRelease.assetNameFor('unsupported'), isNull);
    });

    test('assetNameFor formats with version tag when provided', () {
      expect(UpdateRelease.assetNameFor('android', '5.22.0'),
          'talon-companion-android-5.22.0.apk');
      expect(UpdateRelease.assetNameFor('windows', '5.22.0'),
          'talon-companion-windows-5.22.0.zip');
      expect(UpdateRelease.assetNameFor('macos', '5.22.0'),
          'talon-companion-macos-5.22.0.dmg');
      expect(UpdateRelease.assetNameFor('linux', '5.22.0'),
          'talon-companion-linux-5.22.0.tar.gz');
    });

    test('fromFeedJson matches versioned release assets', () {
      final feed = _feed(
        tag: 'v5.22.0',
        apkBytes: apk,
        assetName: 'talon-companion-android-5.22.0.apk',
      );
      final rel = UpdateRelease.fromFeedJson(feed, platform: 'android');
      expect(rel, isNotNull);
      expect(rel!.assetName, 'talon-companion-android-5.22.0.apk');
    });

    test('a release without this platform’s build reads as nothing to do', () {
      final rel = UpdateRelease.fromFeedJson(
        _feed(tag: 'v4.2.0', apkBytes: apk),
        platform: 'linux',
      );
      expect(rel, isNull);
    });

    test('an unparseable tag is ignored', () {
      final rel = UpdateRelease.fromFeedJson(
        _feed(tag: 'nightly-2026-09-17', apkBytes: apk),
        platform: 'android',
      );
      expect(rel, isNull);
    });
  });

  group('UpdateService.check', () {
    late Directory tmp;
    setUp(() async {
      tmp = await Directory.systemTemp.createTemp('talon-update-');
    });
    tearDown(() async {
      if (await tmp.exists()) await tmp.delete(recursive: true);
    });

    UpdateService service(
      Prefs prefs,
      http.Client client, {
      String running = '4.1.0',
      UpdateInstaller? installer,
      DateTime Function()? clock,
    }) =>
        UpdateService(
          prefs: prefs,
          client: client,
          installer: installer ?? _FakeInstaller(tmp),
          versionProvider: () async => running,
          platform: 'android',
          clock: clock,
        );

    test('offers a newer release', () async {
      final prefs = await freshPrefs();
      final svc = service(
        prefs,
        MockClient((_) async => http.Response(
            jsonEncode(_feed(tag: 'v4.2.0', apkBytes: apk)), 200)),
      );
      addTearDown(svc.dispose);

      final rel = await svc.check();
      expect(rel, isNotNull);
      expect(svc.phase, UpdatePhase.available);
      expect(svc.updateAvailable, isTrue);
      expect(prefs.updateLastCheckedAt, isNotNull);
    });

    test('the running version is up to date, and so is an older release',
        () async {
      for (final tag in ['v4.1.0', 'v4.0.9']) {
        final prefs = await freshPrefs();
        final svc = service(
          prefs,
          MockClient((_) async =>
              http.Response(jsonEncode(_feed(tag: tag, apkBytes: apk)), 200)),
        );
        addTearDown(svc.dispose);
        expect(await svc.check(), isNull, reason: tag);
        expect(svc.phase, UpdatePhase.upToDate, reason: tag);
      }
    });

    test('a skipped version stays skipped until the user forces a check',
        () async {
      final prefs = await freshPrefs();
      var now = DateTime(2026, 9, 17, 12);
      final svc = service(
        prefs,
        MockClient((_) async => http.Response(
            jsonEncode(_feed(tag: 'v4.2.0', apkBytes: apk)), 200)),
        clock: () => now,
      );
      addTearDown(svc.dispose);

      expect(await svc.check(), isNotNull);
      await svc.skipCurrentRelease();
      expect(prefs.skippedUpdateVersion, '4.2.0');
      expect(svc.phase, UpdatePhase.upToDate);

      // A later scheduled check finds the same release and stays quiet.
      now = now.add(const Duration(hours: 7));
      expect(await svc.check(), isNull);
      expect(svc.phase, UpdatePhase.upToDate);

      // "Check now" is the user asking — it ignores their own earlier skip.
      expect(await svc.check(force: true), isNotNull);
      expect(svc.phase, UpdatePhase.available);
    });

    test('a scheduled check inside the freshness window makes no request',
        () async {
      final now = DateTime(2026, 9, 17, 12);
      final prefs = await freshPrefs();
      await prefs.setUpdateLastCheckedAt(
        now.subtract(const Duration(hours: 1)),
      );
      var calls = 0;
      final svc = service(
        prefs,
        MockClient((_) async {
          calls++;
          return http.Response(
              jsonEncode(_feed(tag: 'v4.2.0', apkBytes: apk)), 200);
        }),
        clock: () => now,
      );
      addTearDown(svc.dispose);

      await svc.check();
      expect(calls, 0);
      await svc.check(force: true);
      expect(calls, 1);
    });

    test('a failing feed surfaces an error instead of a fake "up to date"',
        () async {
      final prefs = await freshPrefs();
      final svc = service(
        prefs,
        MockClient((_) async => http.Response('rate limited', 403)),
      );
      addTearDown(svc.dispose);

      expect(await svc.check(), isNull);
      expect(svc.phase, UpdatePhase.error);
      expect(svc.error, contains('403'));
    });
  });

  group('UpdateService.downloadAndInstall', () {
    late Directory tmp;
    setUp(() async {
      tmp = await Directory.systemTemp.createTemp('talon-update-');
    });
    tearDown(() async {
      if (await tmp.exists()) await tmp.delete(recursive: true);
    });

    Future<(UpdateService, _FakeInstaller)> armed({
      List<int>? served,
      bool withDigest = true,
      InstallOutcome outcome = const InstallOutcome.restartPending('ready'),
    }) async {
      final prefs = await freshPrefs();
      final installer = _FakeInstaller(tmp, outcome: outcome);
      final client = MockClient((req) async {
        if (req.url.path.endsWith('.apk')) {
          return http.Response.bytes(served ?? apk, 200);
        }
        return http.Response(
          jsonEncode(
              _feed(tag: 'v4.2.0', apkBytes: apk, withDigest: withDigest)),
          200,
        );
      });
      final svc = UpdateService(
        prefs: prefs,
        client: client,
        installer: installer,
        versionProvider: () async => '4.1.0',
        platform: 'android',
      );
      await svc.check();
      return (svc, installer);
    }

    test('downloads, verifies and installs', () async {
      final (svc, installer) = await armed();
      addTearDown(svc.dispose);
      await svc.downloadAndInstall();
      expect(svc.phase, UpdatePhase.restartPending);
      expect(installer.installed, isNotNull);
      expect(await installer.installed!.readAsBytes(), apk);
    });

    test('a corrupted download is never installed', () async {
      final (svc, installer) = await armed(
        served: utf8.encode('a pretend APQ'), // same length, wrong bytes
      );
      addTearDown(svc.dispose);
      await svc.downloadAndInstall();
      expect(svc.phase, UpdatePhase.error);
      expect(svc.error, contains('checksum'));
      expect(installer.installed, isNull);
      expect(
        await tmp.list().where((e) => e.path.endsWith('.apk')).isEmpty,
        isTrue,
        reason: 'the bad download is deleted, not left to be retried',
      );
    });

    test('a truncated download is caught before hashing', () async {
      final (svc, installer) = await armed(served: apk.sublist(0, 4));
      addTearDown(svc.dispose);
      await svc.downloadAndInstall();
      expect(svc.phase, UpdatePhase.error);
      expect(svc.error, contains('cut short'));
      expect(installer.installed, isNull);
    });

    test('a release with no published digest is refused, not downloaded',
        () async {
      final (svc, installer) = await armed(withDigest: false);
      addTearDown(svc.dispose);
      expect(svc.updateAvailable, isTrue, reason: 'still offered');
      await svc.downloadAndInstall();
      expect(svc.phase, UpdatePhase.error);
      expect(svc.error, contains('no SHA-256 checksum'));
      expect(installer.installed, isNull);
      expect(await tmp.list().isEmpty, isTrue, reason: 'nothing downloaded');
    });

    test('a managed install degrades to "do it yourself", not a failure',
        () async {
      final (svc, _) = await armed(
        outcome:
            const InstallOutcome.manual('Talon cannot write to /opt/talon'),
      );
      addTearDown(svc.dispose);
      await svc.downloadAndInstall();
      expect(svc.phase, UpdatePhase.handedOff);
      expect(svc.error, contains('/opt/talon'));
    });

    test('restart only quits once something is actually staged', () async {
      final (svc, installer) = await armed();
      addTearDown(svc.dispose);
      await svc.applyAndRestart();
      expect(installer.quits, 0, reason: 'nothing staged yet');
      await svc.downloadAndInstall();
      await svc.applyAndRestart();
      expect(installer.quits, 1);
    });
  });

  group('desktop staging directory', () {
    test('is fresh, private and never the shared /tmp/talon-update', () async {
      final installer = PlatformUpdateInstaller(platform: 'linux');
      final a = await installer.stagingDir();
      final b = await installer.stagingDir();
      addTearDown(() async {
        for (final d in [a, b]) {
          if (await d.exists()) await d.delete(recursive: true);
        }
      });
      expect(a.path, isNot(b.path));
      final shared =
          '${Directory.systemTemp.path}${Platform.pathSeparator}talon-update';
      expect(a.path, isNot(shared));
      expect(a.existsSync(), isTrue);
      if (Platform.isLinux || Platform.isMacOS) {
        expect(FileStat.statSync(a.path).mode & 0x1ff, 0x1c0); // 0700
      }
    });
  });

  group('swap scripts', () {
    test('the POSIX script waits for this pid, then copies and relaunches', () {
      final s = PlatformUpdateInstaller.unixSwapScript(
        pid: 4242,
        sourceDir: '/tmp/talon-update/new',
        installDir: '/home/ada/Apps/talon',
        relaunch: '/home/ada/Apps/talon/talon_companion',
        cleanupDir: '/tmp/talon-update',
      );
      expect(s, contains('PID=4242'));
      expect(s, contains('kill -0'));
      // Copy INTO the install dir (keeps the path, desktop entry and pins).
      expect(
          s,
          contains("cp -a '/tmp/talon-update/new'/. "
              "'/home/ada/Apps/talon'/"));
      expect(s, contains("exec '/home/ada/Apps/talon/talon_companion'"));
      // Bounded: a wedged process must not leave a script spinning forever.
      expect(s, contains('-gt 300'));
    });

    test('paths with a quote in them cannot break out of the script', () {
      final s = PlatformUpdateInstaller.unixSwapScript(
        pid: 1,
        sourceDir: "/tmp/it's/new",
        installDir: '/opt/talon',
        relaunch: '/opt/talon/talon_companion',
        cleanupDir: "/tmp/it's",
      );
      expect(s, contains(r"'/tmp/it'\''s/new'"));
      expect(s, isNot(contains("rm -rf /tmp/it's\n")));
    });

    test('the macOS script mounts, replaces, detaches and reopens', () {
      final s = PlatformUpdateInstaller.macSwapScript(
        pid: 77,
        dmgPath: '/tmp/talon-update/talon-companion-macos.dmg',
        appBundle: '/Applications/Talon.app',
        cleanupDir: '/tmp/talon-update',
      );
      expect(s, contains('hdiutil attach'));
      expect(s, contains("rm -rf '/Applications/Talon.app'"));
      expect(s, contains('ditto'));
      expect(s, contains('hdiutil detach'));
      expect(s, contains('com.apple.quarantine'));
      expect(s, contains("open '/Applications/Talon.app'"));
    });

    test('the PowerShell script waits on the pid and doubles quotes', () {
      final s = PlatformUpdateInstaller.windowsSwapScript(
        pid: 9001,
        sourceDir: r"C:\Users\O'Neill\AppData\Local\Temp\talon-update\new",
        installDir: r'C:\Program Files\Talon',
        relaunch: r'C:\Program Files\Talon\talon_companion.exe',
        cleanupDir: r"C:\Users\O'Neill\AppData\Local\Temp\talon-update",
      );
      expect(s, contains('Wait-Process -Id 9001'));
      expect(s, contains("'C:\\Users\\O''Neill"));
      expect(s, contains('Copy-Item'));
      expect(s, contains('Start-Process'));
    });

    test('the macOS bundle root is derived from the executable path', () {
      expect(
        PlatformUpdateInstaller.macAppBundle(
          '/Applications/Talon.app/Contents/MacOS/Talon',
        ),
        '/Applications/Talon.app',
      );
      expect(
        PlatformUpdateInstaller.macAppBundle('/usr/local/bin/talon_companion'),
        isNull,
      );
    });
  });

  group('Android self-update signer check', () {
    final release = UpdateRelease(
      version: AppVersion.tryParse('4.2.0')!,
      tag: 'v4.2.0',
      notes: '',
      pageUrl: kReleasesPageUrl,
      assetName: 'talon-companion-android.apk',
      assetUrl: 'https://example.invalid/talon-companion-android.apk',
      assetSize: 1,
      sha256: '0' * 64,
    );

    /// A `talon/update` channel whose signer check answers [verdict] and
    /// records every method the installer calls.
    List<String> mockUpdateChannel(
      MethodChannel channel,
      Map<String, Object> verdict,
    ) {
      final calls = <String>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
        calls.add(call.method);
        switch (call.method) {
          case 'checkSelfUpdateApk':
            return verdict;
          case 'canInstallPackages':
          case 'installApk':
            return true;
        }
        return null;
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding
          .instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null));
      return calls;
    }

    test('a differently-signed APK is refused before any install', () async {
      const channel = MethodChannel('talon/update-signer-mismatch');
      final calls = mockUpdateChannel(channel, {
        'ok': false,
        'message': 'The update is signed by a different key.',
      });
      final exec = _RecordingExec();
      final installer = PlatformUpdateInstaller(
        androidChannel: channel,
        exec: exec,
        platform: 'android',
      );
      final out = await installer.install(File('/x/update.apk'), release);
      expect(out.kind, InstallKind.failed);
      expect(out.message, contains('different key'));
      expect(out.message, contains('Nothing was installed'));
      expect(exec.installs, 0, reason: 'pm install never reached');
      expect(calls, ['checkSelfUpdateApk']);
    });

    test('a matching signer goes on to install', () async {
      const channel = MethodChannel('talon/update-signer-match');
      final calls = mockUpdateChannel(channel, {
        'ok': true,
        'message': 'Signer matches.',
      });
      final exec = _RecordingExec();
      final installer = PlatformUpdateInstaller(
        androidChannel: channel,
        exec: exec,
        platform: 'android',
      );
      final out = await installer.install(File('/x/update.apk'), release);
      expect(out.kind, InstallKind.handedOff);
      expect(exec.installs, 1);
      expect(calls, contains('installApk'));
    });
  });
}
