import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/services/update_installer.dart';
import 'package:talon_companion/src/services/updater.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/settings/updates_card.dart';

class _RecordingInstaller implements UpdateInstaller {
  _RecordingInstaller(this.dir);
  final Directory dir;
  File? installed;
  int quits = 0;

  /// Installs to refuse before succeeding, like a blocked package installer.
  int failuresLeft = 0;

  @override
  Future<Directory> stagingDir() async => dir;

  @override
  Future<InstallOutcome> install(File artifact, UpdateRelease release) async {
    if (failuresLeft > 0) {
      failuresLeft--;
      return const InstallOutcome.failed('The installer was blocked.');
    }
    installed = artifact;
    return const InstallOutcome.restartPending(
      'Restart Talon to finish — it reopens on its own.',
    );
  }

  @override
  Future<void> quitForSwap() async => quits++;
}

/// Alternate real-async gaps with pumps until the file work finishes: the
/// download's dart:io futures complete on the real loop, and their
/// continuations are microtasks in the test's fake-async zone.
Future<void> _settleIo(WidgetTester tester) async {
  for (var i = 0; i < 20; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pump();
  }
}

void main() {
  final asset = utf8.encode('release bytes');

  late Directory tmp;
  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('talon-card-');
    TalonTheme.mode.value = ThemeMode.light;
    TalonTheme.apply(Brightness.light);
  });
  tearDown(() async {
    if (await tmp.exists()) await tmp.delete(recursive: true);
  });

  Future<(AppState, UpdateService, _RecordingInstaller)> harness({
    bool flatpak = false,
    void Function()? onRequest,
  }) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final installer = _RecordingInstaller(tmp);
    final svc = UpdateService(
      prefs: prefs,
      client: MockClient((req) async {
        onRequest?.call();
        if (req.url.path.endsWith('.apk')) {
          return http.Response.bytes(asset, 200);
        }
        return http.Response(
          jsonEncode({
            'tag_name': 'v9.9.9',
            'html_url': 'https://example.invalid/release',
            'body': 'Faster, quieter, fewer bugs.',
            'assets': [
              {
                'name': 'talon-companion-android.apk',
                'browser_download_url':
                    'https://example.invalid/talon-companion-android.apk',
                'size': asset.length,
                'digest': 'sha256:${sha256.convert(asset)}',
              },
            ],
          }),
          200,
        );
      }),
      installer: installer,
      versionProvider: () async => '4.1.0',
      platform: 'android',
      flatpak: flatpak,
    );
    return (AppState(prefs), svc, installer);
  }

  Widget wrap(AppState state, UpdateService svc) => MaterialApp(
        theme: buildTalonTheme(),
        home: Scaffold(
          body: SingleChildScrollView(
            child: UpdatesCard(state: state, service: svc),
          ),
        ),
      );

  testWidgets('offers the release, then installs it on tap', (tester) async {
    final (state, svc, installer) = await harness();
    addTearDown(state.dispose);
    addTearDown(svc.dispose);

    await tester.pumpWidget(wrap(state, svc));
    await tester.pump();

    // Nothing has been checked yet: the card is quiet and offers the manual
    // check rather than pretending to know anything.
    expect(find.text('Check now'), findsOneWidget);
    expect(find.textContaining('available'), findsNothing);

    await tester.tap(find.text('Check now'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text('Talon v9.9.9 is available'), findsOneWidget);
    expect(find.text('Faster, quieter, fewer bugs.'), findsOneWidget);

    // The download writes a real file, so it needs the real event loop —
    // fake-async pumps alone never deliver dart:io completions, and each
    // completion lands as a microtask that only a pump drains.
    await tester.tap(find.text('Download & install'));
    await _settleIo(tester);

    expect(installer.installed, isNotNull);
    expect(find.text('Restart now'), findsOneWidget);
  });

  testWidgets('skipping puts the card back to quiet', (tester) async {
    final (state, svc, _) = await harness();
    addTearDown(state.dispose);
    addTearDown(svc.dispose);

    await tester.pumpWidget(wrap(state, svc));
    await tester.tap(find.text('Check now'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('Skip'), findsOneWidget);

    await tester.tap(find.text('Skip'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text('Up to date'), findsOneWidget);
    expect(state.prefs.skippedUpdateVersion, '9.9.9');
  });

  testWidgets('the automatic-check switch is a real preference',
      (tester) async {
    final (state, svc, _) = await harness();
    addTearDown(state.dispose);
    addTearDown(svc.dispose);

    await tester.pumpWidget(wrap(state, svc));
    await tester.pump();
    expect(state.prefs.autoUpdateCheck, isTrue);

    await tester.tap(find.byType(Switch));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(state.prefs.autoUpdateCheck, isFalse);
  });

  testWidgets('a Flatpak build defers to Flatpak and never checks',
      (tester) async {
    var requests = 0;
    final (state, svc, installer) = await harness(
      flatpak: true,
      onRequest: () => requests++,
    );
    addTearDown(state.dispose);
    addTearDown(svc.dispose);

    await tester.pumpWidget(wrap(state, svc));
    await tester.pump();

    expect(find.text('Updates are managed by Flatpak'), findsOneWidget);
    // No auto-check switch to flip, and "Check now" is inert.
    expect(find.byType(Switch), findsNothing);
    await tester.tap(find.text('Check now'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(requests, 0);
    expect(find.textContaining('is available'), findsNothing);
    expect(installer.installed, isNull);
  });

  testWidgets('a refused install offers Retry install without re-downloading',
      (tester) async {
    var downloads = 0;
    final (state, svc, installer) = await harness(onRequest: () => downloads++);
    addTearDown(state.dispose);
    addTearDown(svc.dispose);
    installer.failuresLeft = 1;

    await tester.pumpWidget(wrap(state, svc));
    await tester.tap(find.text('Check now'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    await tester.tap(find.text('Download & install'));
    await _settleIo(tester);

    expect(installer.installed, isNull);
    expect(svc.canInstallStaged, isTrue);
    final requestsAfterDownload = downloads;

    await tester.tap(find.text('Retry install').first);
    await _settleIo(tester);

    expect(installer.installed, isNotNull);
    expect(downloads, requestsAfterDownload, reason: 'no second download');
    expect(find.text('Restart now'), findsOneWidget);
  });
}
