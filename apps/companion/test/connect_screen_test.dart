import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/services/bridge_client.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/connect_screen.dart';

/// The remote fields are the first thing a phone user touches, and a blank
/// host or a nonsense port used to surface only as an opaque socket failure
/// after the dial timed out. These tests pin the pre-flight check.
void main() {
  _pairLinkTests();
  Future<_RecordingState> pumpConnect(
    WidgetTester tester, {
    ConnectionConfig? saved,
  }) async {
    // Tall surface: the whole card must be on screen for Connect to hit-test.
    await tester.binding.setSurfaceSize(const Size(800, 1200));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    if (saved != null) await prefs.setConnection(saved);
    final state = _RecordingState(prefs);
    addTearDown(state.dispose);

    TalonTheme.mode.value = ThemeMode.light;
    TalonTheme.apply(Brightness.light);

    await tester.pumpWidget(
      MaterialApp(
        theme: buildTalonTheme(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
        // firstRun mode returns a bare body — RootView supplies the Scaffold
        // in the real app, so the test has to as well.
        home: Scaffold(
          body: ConnectScreen(state: state, firstRun: true),
        ),
      ),
    );
    await tester.pump();

    // Force remote mode so the host/port/token fields are on screen.
    await tester.tap(find.text('Remote bridge'));
    await tester.pump();
    return state;
  }

  testWidgets('a blank host is reported inline and does not dial', (
    tester,
  ) async {
    final state = await pumpConnect(tester);

    await tester.tap(find.text('Connect'));
    await tester.pump();

    expect(find.text('Enter the host or IP of your Talon bridge.'),
        findsOneWidget);
    expect(state.applied, isEmpty);

    // Typing clears the error immediately — it must not outlive the mistake.
    await tester.enterText(find.byType(TextField).first, '192.168.1.20');
    await tester.pump();
    expect(find.text('Enter the host or IP of your Talon bridge.'), findsNothing);
  });

  testWidgets('an out-of-range port is reported inline and does not dial', (
    tester,
  ) async {
    final state = await pumpConnect(tester);

    final fields = find.byType(TextField);
    await tester.enterText(fields.first, '192.168.1.20');
    await tester.enterText(fields.at(1), '99999');
    await tester.pump();

    await tester.tap(find.text('Connect'));
    await tester.pump();

    expect(find.text('Port must be a number between 1 and 65535.'),
        findsOneWidget);
    expect(state.applied, isEmpty);
  });

  testWidgets('a pasted https URL with no port dials 443, not the stale box', (
    tester,
  ) async {
    final state = await pumpConnect(tester);

    final fields = find.byType(TextField);
    // The port box still holds the daemon default from a previous setup —
    // exactly the state a user is in when moving a bridge behind a proxy.
    await tester.enterText(fields.at(1), '19880');
    await tester.enterText(fields.first, 'https://mesh.example.org');
    await tester.pump();

    await tester.tap(find.text('Connect'));
    await tester.pumpAndSettle();

    expect(state.applied, hasLength(1));
    expect(state.applied.single.host, 'mesh.example.org');
    expect(state.applied.single.port, 443);
    expect(state.applied.single.tls, isTrue);
    expect(state.applied.single.baseUrl, 'https://mesh.example.org');
  });

  testWidgets('a blank port falls back to the scheme default', (tester) async {
    final state = await pumpConnect(tester);

    final fields = find.byType(TextField);
    await tester.enterText(fields.at(1), '');
    await tester.enterText(fields.first, 'http://mesh.example.org');
    await tester.pump();

    await tester.tap(find.text('Connect'));
    await tester.pumpAndSettle();

    expect(state.applied.single.port, 80);
    expect(state.applied.single.tls, isFalse);
  });

  testWidgets('an explicit port in the URL still wins', (tester) async {
    final state = await pumpConnect(tester);

    final fields = find.byType(TextField);
    await tester.enterText(fields.first, 'https://gw.ts.net:19880');
    await tester.pump();

    await tester.tap(find.text('Connect'));
    await tester.pumpAndSettle();

    expect(state.applied.single.port, 19880);
    expect(state.applied.single.baseUrl, 'https://gw.ts.net:19880');
  });

  testWidgets('valid remote details dial through', (tester) async {
    final state = await pumpConnect(tester);

    final fields = find.byType(TextField);
    await tester.enterText(fields.first, '192.168.1.20');
    await tester.enterText(fields.at(1), '19880');
    await tester.pump();

    await tester.tap(find.text('Connect'));
    await tester.pumpAndSettle();

    expect(state.applied, hasLength(1));
    expect(state.applied.single.host, '192.168.1.20');
    expect(state.applied.single.port, 19880);
  });

  _certificateConfirmationTests(pumpConnect);
  _plainHttpWarningTests(pumpConnect);
}

const _fp = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

typedef _Pump = Future<_RecordingState> Function(
  WidgetTester tester, {
  ConnectionConfig? saved,
});

Future<void> _enterRemote(WidgetTester tester, String host,
    {String token = 'tok'}) async {
  final fields = find.byType(TextField);
  await tester.enterText(fields.first, host);
  await tester.enterText(fields.at(2), token);
  await tester.pump();
  await tester.tap(find.text('Connect'));
  await tester.pumpAndSettle();
}

void _certificateConfirmationTests(_Pump pumpConnect) {
  group('manual entry: certificate confirmation', () {
    testWidgets('shows the fingerprint and pins it once confirmed', (
      tester,
    ) async {
      final state = await pumpConnect(tester);
      state.probeResult =
          const CertificateProbe(fingerprint: _fp, reached: true);

      await _enterRemote(tester, 'https://10.0.0.5:19880');

      // Probed first, and nothing applied (so no token sent) yet.
      expect(state.probed.single.baseUrl, 'https://10.0.0.5:19880');
      expect(state.applied, isEmpty);
      expect(find.text('Trust this bridge?'), findsOneWidget);
      expect(
          find.text(ConnectionConfig.formatFingerprint(_fp)), findsOneWidget);
      expect(find.textContaining('talon status'), findsOneWidget);

      await tester.tap(find.text('Trust and connect'));
      await tester.pumpAndSettle();

      expect(state.applied.single.fingerprint, _fp);
      expect(state.applied.single.token, 'tok');
    });

    testWidgets('cancel sends nothing', (tester) async {
      final state = await pumpConnect(tester);
      state.probeResult =
          const CertificateProbe(fingerprint: _fp, reached: true);

      await _enterRemote(tester, 'https://10.0.0.5:19880');
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(state.applied, isEmpty);
    });

    testWidgets('the certificate already pinned for that address is kept', (
      tester,
    ) async {
      final state = await pumpConnect(
        tester,
        saved: const ConnectionConfig(
          host: '10.0.0.5',
          port: 19880,
          tls: true,
          fingerprint: _fp,
          manageLocalDaemon: false,
          localAutoDiscover: false,
        ),
      );
      state.probeResult =
          const CertificateProbe(fingerprint: _fp, reached: true);

      await _enterRemote(tester, 'https://10.0.0.5:19880');

      expect(find.text('Trust this bridge?'), findsNothing);
      expect(state.applied.single.fingerprint, _fp);
    });

    testWidgets('a different certificate than the pinned one is called out', (
      tester,
    ) async {
      final state = await pumpConnect(
        tester,
        saved: ConnectionConfig(
          host: '10.0.0.5',
          port: 19880,
          tls: true,
          fingerprint: '11' * 32,
          manageLocalDaemon: false,
          localAutoDiscover: false,
        ),
      );
      state.probeResult =
          const CertificateProbe(fingerprint: _fp, reached: true);

      await _enterRemote(tester, 'https://10.0.0.5:19880');

      expect(
          find.byKey(const ValueKey('cert-confirm-changed')), findsOneWidget);
      // Still a confirmation, never a refusal.
      await tester.tap(find.text('Trust and connect'));
      await tester.pumpAndSettle();
      expect(state.applied.single.fingerprint, _fp);
    });

    testWidgets('an unreachable bridge can still be connected to', (
      tester,
    ) async {
      final state = await pumpConnect(tester);
      state.probeResult = const CertificateProbe(reached: false);

      await _enterRemote(tester, 'https://10.0.0.5:19880');

      expect(find.byKey(const ValueKey('cert-confirm-unreachable')),
          findsOneWidget);
      await tester.tap(find.text('Connect anyway'));
      await tester.pumpAndSettle();
      expect(state.applied.single.fingerprint, isNull);
    });

    testWidgets('plain http is not probed', (tester) async {
      final state = await pumpConnect(tester);

      await _enterRemote(tester, 'http://192.168.1.20:19880');

      expect(state.probed, isEmpty);
      expect(state.applied, hasLength(1));
    });

    testWidgets('a pasted pairing link pins without asking', (tester) async {
      const link = 'talon://pair?u=https%3A%2F%2F10.0.0.9%3A19880&t=s3cr3t'
          '&f=$_fp';
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async =>
            call.method == 'Clipboard.getData' ? {'text': link} : null,
      );
      addTearDown(() => tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null));
      final state = await pumpConnect(tester);
      state.probeResult =
          const CertificateProbe(fingerprint: _fp, reached: true);

      await tester.tap(find.text('Paste a pairing link'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      expect(state.probed, isEmpty);
      expect(find.text('Trust this bridge?'), findsNothing);
      expect(state.applied.single.host, '10.0.0.9');
      expect(state.applied.single.fingerprint, _fp);
      expect(state.applied.single.token, 's3cr3t');
    });
  });
}

void _plainHttpWarningTests(_Pump pumpConnect) {
  group('plain-http warning', () {
    Finder warning() => find.byKey(const ValueKey('plain-http-warning'));

    testWidgets('shows for a public host over http, and still connects', (
      tester,
    ) async {
      final state = await pumpConnect(tester);
      await tester.enterText(find.byType(TextField).first, 'mesh.example.org');
      await tester.pump();
      expect(warning(), findsOneWidget);

      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();
      expect(state.applied.single.tls, isFalse);
    });

    testWidgets('stays away for private addresses and https', (tester) async {
      await pumpConnect(tester);
      final host = find.byType(TextField).first;

      await tester.enterText(host, '192.168.1.20');
      await tester.pump();
      expect(warning(), findsNothing);

      await tester.enterText(host, 'https://mesh.example.org');
      await tester.pump();
      expect(warning(), findsNothing);
    });
  });
}

class _RecordingState extends AppState {
  _RecordingState(super.prefs) : super(narrowLayout: true);

  final applied = <ConnectionConfig>[];
  final probed = <ConnectionConfig>[];

  /// What the certificate probe reports. The default is a CA-trusted
  /// endpoint (nothing to pin, nothing to ask).
  CertificateProbe probeResult = const CertificateProbe(reached: true);

  @override
  Future<CertificateProbe> probeCertificate(ConnectionConfig candidate) async {
    probed.add(candidate);
    return probeResult;
  }

  @override
  Future<void> applyConfig(ConnectionConfig config) async {
    applied.add(config);
  }

  @override
  Future<ConfigSnapshot?> loadConfig() async => null;

  @override
  Future<void> refreshMeshDevices() async {}

  @override
  Future<void> refreshMeshBackgroundHealth() async {}
}

void _pairLinkTests() {
  const fp = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
  group('talon://pair links', () {
    test('builds a remote profile from the daemon link', () {
      final c = ConnectionConfig.fromPairLink(
        'talon://pair?u=https%3A%2F%2F192.168.1.20%3A19880&t=s3cr3t'
        '&f=${fp.toUpperCase()}&n=Talon',
      );

      expect(c, isNotNull);
      expect(c!.host, '192.168.1.20');
      expect(c.port, 19880);
      expect(c.token, 's3cr3t');
      expect(c.tls, isTrue);
      expect(c.fingerprint, fp);
      // A paired bridge lives somewhere else: never adopt it as a daemon this
      // device is supposed to launch and supervise.
      expect(c.manageLocalDaemon, isFalse);
      expect(c.localAutoDiscover, isFalse);
    });

    test('falls back to the scheme port when the link omits one', () {
      final c = ConnectionConfig.fromPairLink(
        'talon://pair?u=https%3A%2F%2Fmesh.example.org&t=x&f=$fp',
      );

      expect(c!.port, 443);
      expect(c.tls, isTrue);
    });

    test('carries no fingerprint over plain HTTP on a private address', () {
      final c = ConnectionConfig.fromPairLink(
        'talon://pair?u=http%3A%2F%2F10.0.0.5%3A19880&t=x',
      );

      expect(c!.tls, isFalse);
      expect(c.fingerprint, isNull);
    });

    test('refuses anything that is not a usable pairing link', () {
      // A clipboard full of something else must be a quiet no, not a wrong
      // profile replacing a working one.
      for (final raw in [
        '',
        'hello',
        'https://example.org/pair?grant=abc',
        'talon://other?u=http%3A%2F%2Fh%3A1',
        'talon://pair?t=token-but-no-url',
      ]) {
        expect(ConnectionConfig.fromPairLink(raw), isNull, reason: raw);
      }
    });
  });
}
