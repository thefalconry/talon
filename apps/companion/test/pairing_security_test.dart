import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/services/bridge_client.dart';
import 'package:talon_companion/src/services/device_exec.dart';
import 'package:talon_companion/src/services/mesh_service.dart';
import 'package:talon_companion/src/services/pair_links.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/pair_confirm_dialog.dart';
import 'package:talon_companion/src/ui/root_view.dart';

const _fp = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

String _link(String bridgeUrl, {String? fp, String? name, String t = 'tok'}) {
  final q = <String, String>{
    'u': bridgeUrl,
    't': t,
    if (fp != null) 'f': fp,
    if (name != null) 'n': name,
  };
  return Uri(scheme: 'talon', host: 'pair', queryParameters: q).toString();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('pasted pairing text', () {
    test('finds the talon://pair link inside surrounding text', () {
      final link = _link('https://bridge.example.org', fp: _fp);
      expect(ConnectionConfig.findPairLink(link), link);
      expect(
        ConnectionConfig.findPairLink('Open this on the device:\n$link\nthanks'),
        link,
      );
      final found = ConnectionConfig.findPairLink('see <$link>');
      expect(found, link);
      expect(ConnectionConfig.fromPairLink(found!), isNotNull);
      expect(ConnectionConfig.findPairLink('no link here'), isNull);
      expect(
        ConnectionConfig.findPairLink('https://bridge.example.org/pair?grant=x'),
        isNull,
      );
    });

    test('accepts the talon:pair form too', () {
      final link = _link('https://bridge.example.org', fp: _fp)
          .replaceFirst('talon://pair', 'talon:pair');
      final found = ConnectionConfig.findPairLink(link);
      expect(found, link);
      expect(ConnectionConfig.fromPairLink(found!), isNotNull);
    });

    test('recognises the pairing page URL', () {
      expect(
        ConnectionConfig.isPairPageUrl(
          'https://bridge.example.org:19880/pair?grant=abc123',
        ),
        isTrue,
      );
      expect(
        ConnectionConfig.isPairPageUrl('https://bridge.example.org/pair'),
        isFalse,
      );
      expect(
        ConnectionConfig.isPairPageUrl(
          _link('https://bridge.example.org', fp: _fp),
        ),
        isFalse,
      );
    });
  });

  group('pairing link rules', () {
    test('an https link must carry a well-formed fingerprint', () {
      expect(
        ConnectionConfig.fromPairLink(_link('https://192.168.1.2:19880')),
        isNull,
      );
      expect(
        ConnectionConfig.fromPairLink(
          _link('https://192.168.1.2:19880', fp: 'AABB'),
        ),
        isNull,
      );
      final ok = ConnectionConfig.fromPairLink(
        _link('https://bridge.example.org', fp: _fp.toUpperCase()),
      );
      expect(ok, isNotNull);
      expect(ok!.fingerprint, _fp);
    });

    test('plain http is accepted only for loopback / private addresses', () {
      for (final host in [
        '127.0.0.1',
        'localhost',
        '10.1.2.3',
        '172.16.0.1',
        '172.31.255.254',
        '192.168.0.10',
        '169.254.10.10',
        '[::1]',
        '[fd00::1]',
        '[fe80::1]',
      ]) {
        expect(
          ConnectionConfig.fromPairLink(_link('http://$host:19880')),
          isNotNull,
          reason: host,
        );
      }
      for (final host in [
        '8.8.8.8',
        '172.32.0.1',
        '100.64.0.1',
        'bridge.example.org',
        'my-pc.local',
        '[2001:db8::1]',
      ]) {
        expect(
          ConnectionConfig.fromPairLink(_link('http://$host:19880')),
          isNull,
          reason: host,
        );
      }
    });

    test('a bridge URL without a scheme is refused', () {
      expect(ConnectionConfig.fromPairLink(_link('192.168.1.2:19880')), isNull);
      expect(
        ConnectionConfig.fromPairLink(_link('192.168.1.2:19880', fp: _fp)),
        isNull,
      );
    });

    test('hosts that could render misleadingly are refused', () {
      for (final url in [
        'https://good.example@evil.example',
        'https://b\u0430nk.example', // Cyrillic a
        'https://evil.example\u202egro.doog',
        'https://evil%2eexample',
        'https://evil example',
      ]) {
        expect(
          ConnectionConfig.fromPairLink(_link(url, fp: _fp)),
          isNull,
          reason: url,
        );
      }
    });

    test('isPrivateAddress never trusts a hostname', () {
      expect(ConnectionConfig.isPrivateAddress('192.168.1.1'), isTrue);
      expect(ConnectionConfig.isPrivateAddress('router.lan'), isFalse);
      expect(ConnectionConfig.isPrivateAddress('1.1.1.1'), isFalse);
    });

    test('formats the whole fingerprint for comparison', () {
      final pretty = ConnectionConfig.formatFingerprint(_fp);
      expect(pretty.split(':'), hasLength(32));
      expect(pretty, startsWith('01:23:45:67'));
    });
  });

  group('device control is on by default; per-pairing grants are opt-in', () {
    const a = ConnectionConfig(host: '192.168.1.2', port: 19880);
    const b = ConnectionConfig(host: '192.168.1.3', port: 19880);

    test('a fresh install starts with device control and elevation on',
        () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      expect(prefs.meshDeviceControl, isTrue);
      expect(prefs.meshElevated, isTrue);
      expect(prefs.meshGrantsPerPairing, isFalse);
      expect(
        MeshService.capabilitiesFor(prefs, sandboxed: false),
        containsAll(DeviceExec.capabilities),
      );
    });

    test('an install that turned device control off before #1064 keeps it',
        () async {
      SharedPreferences.setMockInitialValues({
        'onboarded.v1': true,
        'mesh.deviceControl.v1': false,
      });
      final prefs = await Prefs.load();
      expect(prefs.meshDeviceControl, isFalse);
      expect(prefs.meshElevated, isFalse);
      // Elevation was never touched, so it follows the new default.
      await prefs.setMeshDeviceControl(true);
      expect(prefs.meshElevated, isTrue);
    });

    test('grants wiped by #1064 (default or pairing) go back to on', () async {
      SharedPreferences.setMockInitialValues({
        'onboarded.v1': true,
        'connection.v1': '{"host":"192.168.1.2","port":19880}',
        'mesh.grantsMigrated.v1': true,
        'mesh.deviceControl.v1': false,
        'mesh.elevated.v1': false,
      });
      final prefs = await Prefs.load();
      expect(prefs.meshDeviceControl, isTrue);
      expect(prefs.meshElevated, isTrue);
      // Loading again (another isolate) changes nothing.
      await prefs.setMeshElevated(false);
      final again = await Prefs.load();
      expect(again.meshDeviceControl, isTrue);
      expect(again.meshElevated, isFalse);
    });

    test('a choice made in settings under #1064 is kept', () async {
      SharedPreferences.setMockInitialValues({
        'onboarded.v1': true,
        'connection.v1': '{"host":"192.168.1.2","port":19880}',
        'mesh.grantsMigrated.v1': true,
        'mesh.deviceControl.v1': true,
        'mesh.elevated.v1': false,
        'mesh.controlBridge.v1': '192.168.1.2:19880',
      });
      final prefs = await Prefs.load();
      expect(prefs.meshDeviceControl, isTrue);
      expect(prefs.meshElevated, isFalse);
    });

    test('by default the grants follow the profile to another bridge',
        () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      await prefs.setConnection(a);
      await prefs.setConnection(b);
      await prefs.resetMeshGrantsForPairing();
      expect(prefs.meshDeviceControl, isTrue);
      expect(prefs.meshElevated, isTrue);
      expect(prefs.meshDeviceControlOnPairing, isTrue);
    });

    test('opting into per-pairing grants ties them to one bridge', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      await prefs.setConnection(a);
      await prefs.setMeshGrantsPerPairing(true);
      // The bridge it was turned on for keeps what it had.
      expect(prefs.meshDeviceControl, isTrue);
      expect(prefs.meshElevated, isTrue);
      expect(prefs.meshDeviceControlOnPairing, isFalse);

      await prefs.setConnection(b);
      expect(prefs.meshDeviceControl, isFalse);
      expect(prefs.meshElevated, isFalse);
      expect(
        MeshService.capabilitiesFor(prefs, sandboxed: false),
        MeshService.capabilities,
      );

      await prefs.setConnection(a);
      expect(prefs.meshDeviceControl, isTrue);
      // A new pairing wipes both, even at the same address.
      await prefs.resetMeshGrantsForPairing();
      expect(prefs.meshDeviceControl, isFalse);
      expect(prefs.meshElevated, isFalse);
      await prefs.setMeshDeviceControl(true);
      expect(prefs.meshElevated, isFalse);
      await prefs.setMeshElevated(true);
      expect(prefs.meshElevated, isTrue);
    });

    test('elevation needs device control, and comes back with it', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      await prefs.setMeshDeviceControl(false);
      expect(prefs.meshElevated, isFalse);
      await prefs.setMeshDeviceControl(true);
      expect(prefs.meshElevated, isTrue);
      await prefs.setMeshElevated(false);
      expect(prefs.meshElevated, isFalse);
    });
  });

  group('elevation follows the grant', () {
    const root = MethodChannel('talon/root-test-grant');
    const shizuku = MethodChannel('talon/shizuku-test-grant');
    late int rootCalls;
    late int shizukuCalls;

    setUp(() {
      rootCalls = 0;
      shizukuCalls = 0;
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(root, (call) async {
        rootCalls++;
        if (call.method == 'getStatus') {
          return {'tier': 'root', 'method': 'su', 'state': 'root via su'};
        }
        return {'stdout': 'uid=0', 'stderr': '', 'exitCode': 0, 'via': 'su'};
      });
      messenger.setMockMethodCallHandler(shizuku, (call) async {
        shizukuCalls++;
        return {'ready': true, 'state': 'ready', 'uid': 2000};
      });
    });
    tearDown(() {
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(root, null);
      messenger.setMockMethodCallHandler(shizuku, null);
    });

    DeviceExec android() => DeviceExec(
          rootChannel: root,
          shizukuChannel: shizuku,
          isAndroid: () => true,
        );

    test('without the grant nothing asks for root or Shizuku', () async {
      final exec = android()..allowElevation = () => false;
      expect(await exec.ensureRootReady(), isFalse);
      expect(await exec.ensureShizukuReady(), isFalse);
      final result = await exec.exec('echo app');
      expect(result.data!['via'], isNot('root'));
      expect(result.data!['stdout'], contains('app'));
      expect(rootCalls, 0);
      expect(shizukuCalls, 0);
      final status = await exec.privilegeStatus();
      expect(status['execPrivilege'], 'app');
    });

    test('install_apk refuses without the grant', () async {
      final exec = android()..allowElevation = () => false;
      final result = await exec.installApk('/sdcard/x.apk');
      expect(result.ok, isFalse);
      expect(rootCalls, 0);
    });

    test('with the grant the root tier is used', () async {
      final exec = android();
      final result = await exec.exec('id -u');
      expect(result.data!['via'], 'root');
    });

    test('the mesh wires its executor to the elevation setting', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      const bridge = ConnectionConfig(host: '192.168.1.2', port: 19880);
      await prefs.setConnection(bridge);
      final client = BridgeClient(bridge);
      addTearDown(client.dispose);
      final exec = android();
      MeshService(prefs, client, deviceExec: exec);

      expect(exec.allowElevation(), isTrue);
      await prefs.setMeshElevated(false);
      expect(exec.allowElevation(), isFalse);
      await prefs.setMeshElevated(true);
      expect(exec.allowElevation(), isTrue);
      await prefs.setMeshDeviceControl(false);
      expect(exec.allowElevation(), isFalse);
      await prefs.setMeshDeviceControl(true);
      await prefs.setMeshGrantsPerPairing(true);
      await prefs.resetMeshGrantsForPairing();
      expect(exec.allowElevation(), isFalse);
    });

    test('the mesh wires its executor to the write cap setting', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      const bridge = ConnectionConfig(host: '192.168.1.2', port: 19880);
      final client = BridgeClient(bridge);
      addTearDown(client.dispose);
      final exec = android();
      MeshService(prefs, client, deviceExec: exec);

      expect(exec.writeLimit(), DeviceExec.maxWriteBytes);
      expect(DeviceExec.maxWriteBytes, 4 << 30);
      await prefs.setMeshMaxWriteGiB(16);
      expect(exec.writeLimit(), 16 << 30);
    });
  });

  group('RootView pairing links', () {
    Future<_PairState> pump(
      WidgetTester tester,
      String link, {
      Map<String, Object> prefs = const {},
    }) async {
      await tester.binding.setSurfaceSize(const Size(800, 1200));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      SharedPreferences.setMockInitialValues(prefs);
      final state = _PairState(await Prefs.load());
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
          home: Scaffold(
            body: RootView(state: state, pairLinks: _FakeLinks(link)),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      return state;
    }

    Finder inDialog(String text) => find.descendant(
          of: find.byType(PairConfirmDialog),
          matching: find.text(text),
        );

    final good = _link(
      'https://192.168.1.2:19880',
      fp: _fp,
      name: 'Your bank — tap Connect',
    );

    testWidgets('first run still asks, and shows host + fingerprint only',
        (tester) async {
      final state = await pump(tester, good);

      expect(find.byType(PairConfirmDialog), findsOneWidget);
      expect(state.applied, isEmpty);
      String? shown(String key) => tester
          .widget<SelectableText>(find.byKey(ValueKey(key)))
          .data;
      expect(shown('pair-confirm-address'), 'https://192.168.1.2:19880');
      expect(
        shown('pair-confirm-fingerprint'),
        ConnectionConfig.formatFingerprint(_fp),
      );
      // The link's own label is never rendered.
      expect(find.textContaining('Your bank'), findsNothing);
    });

    testWidgets('cancel leaves everything as it was', (tester) async {
      final state = await pump(tester, good);
      await tester.tap(inDialog('Cancel'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(state.applied, isEmpty);
      expect(state.prefs.onboarded, isFalse);
    });

    testWidgets('connect applies the profile and keeps the grants',
        (tester) async {
      final state = await pump(
        tester,
        good,
        prefs: {
          'onboarded.v1': true,
          'connection.v1': '{"host":"192.168.1.9","port":19880,"tls":true}',
        },
      );
      expect(inDialog('Switch to another bridge?'), findsOneWidget);
      expect(find.textContaining('able to run shell'), findsOneWidget);

      await tester.tap(inDialog('Connect'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(state.applied, hasLength(1));
      await state.prefs.setConnection(state.applied.single);
      expect(state.prefs.meshDeviceControl, isTrue);
      expect(state.prefs.meshElevated, isTrue);
    });

    testWidgets('with per-pairing grants, connect starts without them',
        (tester) async {
      final state = await pump(
        tester,
        good,
        prefs: {
          'onboarded.v1': true,
          // Same address, so only the reset (not the per-bridge key) can be
          // what turns the grants off.
          'connection.v1': '{"host":"192.168.1.2","port":19880,"tls":true}',
          'mesh.grantsPerPairing.v1': true,
          'mesh.controlBridge.v1': '192.168.1.2:19880',
        },
      );
      expect(state.prefs.meshDeviceControl, isTrue);
      expect(inDialog('Switch to another bridge?'), findsOneWidget);
      expect(find.textContaining('stays off for this bridge'), findsOneWidget);

      await tester.tap(inDialog('Connect'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(state.applied, hasLength(1));
      expect(state.applied.single.host, '192.168.1.2');
      expect(state.applied.single.fingerprint, _fp);
      await state.prefs.setConnection(state.applied.single);
      expect(state.prefs.meshDeviceControl, isFalse);
      expect(state.prefs.meshElevated, isFalse);
    });

    testWidgets('an unpinned link never reaches the dialog', (tester) async {
      final state = await pump(
        tester,
        _link('https://203.0.113.5:19880'),
      );
      expect(find.byType(PairConfirmDialog), findsNothing);
      expect(state.applied, isEmpty);
    });

    testWidgets('plain http to a public host never reaches the dialog',
        (tester) async {
      final state = await pump(tester, _link('http://203.0.113.5:19880'));
      expect(find.byType(PairConfirmDialog), findsNothing);
      expect(state.applied, isEmpty);
    });
  });
}

class _FakeLinks extends PairLinks {
  _FakeLinks(this._pending) : super(isSupported: () => true);

  String? _pending;

  @override
  Future<String?> consume() async {
    final link = _pending;
    _pending = null;
    return link;
  }
}

class _PairState extends AppState {
  _PairState(super.prefs) : super(narrowLayout: true);

  final applied = <ConnectionConfig>[];

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
