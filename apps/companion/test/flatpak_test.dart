import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/services/autostart.dart';
import 'package:talon_companion/src/services/device_exec.dart';
import 'package:talon_companion/src/services/mesh_service.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/services/sandbox.dart';
import 'package:talon_companion/src/services/update_installer.dart';
import 'package:talon_companion/src/services/updater.dart';

/// Fails the test if the updater ever gets as far as installing anything.
class _NeverInstaller implements UpdateInstaller {
  _NeverInstaller(this.dir);
  final Directory dir;

  @override
  Future<Directory> stagingDir() async => dir;

  @override
  Future<InstallOutcome> install(File artifact, UpdateRelease release) =>
      throw StateError('a Flatpak build must never self-install');

  @override
  Future<void> quitForSwap() async =>
      throw StateError('a Flatpak build must never self-install');
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<Prefs> freshPrefs() async {
    SharedPreferences.setMockInitialValues({});
    return Prefs.load();
  }

  group('detectFlatpak', () {
    test('FLATPAK_ID in the environment means sandboxed', () {
      expect(
        detectFlatpak(
          environment: {'FLATPAK_ID': 'io.github.thefalconry.TalonCompanion'},
          fileExists: (_) => false,
        ),
        isTrue,
      );
    });

    test('/.flatpak-info alone is enough', () {
      final probed = <String>[];
      expect(
        detectFlatpak(
          environment: const {},
          fileExists: (p) {
            probed.add(p);
            return p == '/.flatpak-info';
          },
        ),
        isTrue,
      );
      expect(probed, ['/.flatpak-info']);
    });

    test('neither signal (or an empty FLATPAK_ID) means a normal install', () {
      expect(
        detectFlatpak(environment: const {}, fileExists: (_) => false),
        isFalse,
      );
      expect(
        detectFlatpak(
          environment: const {'FLATPAK_ID': ''},
          fileExists: (_) => false,
        ),
        isFalse,
      );
    });

    test('an unreadable filesystem reads as "not sandboxed", not a crash', () {
      expect(
        detectFlatpak(
          environment: const {},
          fileExists: (_) => throw const FileSystemException('denied'),
        ),
        isFalse,
      );
    });
  });

  group('UpdateService under Flatpak', () {
    late Directory tmp;
    setUp(() async {
      tmp = await Directory.systemTemp.createTemp('talon-flatpak-');
    });
    tearDown(() async {
      if (await tmp.exists()) await tmp.delete(recursive: true);
    });

    test('never checks, never schedules, never downloads', () async {
      final prefs = await freshPrefs();
      var requests = 0;
      final svc = UpdateService(
        prefs: prefs,
        client: MockClient((_) async {
          requests++;
          return http.Response('{}', 200);
        }),
        installer: _NeverInstaller(tmp),
        versionProvider: () async => '5.7.0',
        platform: 'linux',
        flatpak: true,
      );
      addTearDown(svc.dispose);

      expect(svc.managedByFlatpak, isTrue);
      expect(svc.supported, isFalse);

      // Auto-check is on by default: a normal Linux build would hit the feed
      // here. The Flatpak build only reads its own version.
      await svc.start();
      expect(svc.currentVersion.toString(), '5.7.0');

      expect(await svc.check(force: true), isNull);
      await svc.downloadAndInstall();

      expect(requests, 0);
      expect(svc.phase, UpdatePhase.idle);
    });

    test('the same Linux build outside Flatpak still updates itself',
        () async {
      final prefs = await freshPrefs();
      final svc = UpdateService(
        prefs: prefs,
        client: MockClient((_) async => http.Response('{}', 200)),
        installer: _NeverInstaller(tmp),
        versionProvider: () async => '5.7.0',
        platform: 'linux',
        flatpak: false,
      );
      addTearDown(svc.dispose);
      expect(svc.managedByFlatpak, isFalse);
      expect(svc.supported, isTrue);
    });
  });

  group('mesh capabilities under Flatpak', () {
    test('device control is never advertised from the sandbox', () async {
      final prefs = await freshPrefs();
      await prefs.setMeshDeviceControl(true);

      final sandboxed = MeshService.capabilitiesFor(prefs, sandboxed: true);
      expect(sandboxed, MeshService.capabilities);
      for (final cap in [
        ...DeviceExec.capabilities,
        ...MeshService.transferCapabilities,
      ]) {
        expect(sandboxed, isNot(contains(cap)), reason: cap);
      }
      expect(
        MeshService.deviceControlAllowed(prefs, sandboxed: true),
        isFalse,
      );

      // Outside the sandbox the user's switch still decides.
      expect(
        MeshService.capabilitiesFor(prefs, sandboxed: false),
        containsAll(DeviceExec.capabilities),
      );
      expect(
        MeshService.deviceControlAllowed(prefs, sandboxed: false),
        isTrue,
      );
    });
  });

  group('Autostart', () {
    test('is not offered inside Flatpak', () {
      // launch_at_startup would write ~/.config/autostart/Talon.desktop
      // pointing at /app/bin/... — unreachable from the host session, so the
      // toggle would report success and nothing would start at login.
      expect(Autostart.isSupportedIn(sandboxed: true), isFalse);
    });

    test('is offered on desktop outside Flatpak', () {
      final desktop = Platform.isLinux || Platform.isMacOS || Platform.isWindows;
      expect(Autostart.isSupportedIn(sandboxed: false), desktop);
    });
  });
}
