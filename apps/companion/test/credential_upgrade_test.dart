import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/models/credentials.dart';
import 'package:talon_companion/src/services/bridge_client.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';

import 'mock_bridge.dart';

/// Per-device credentials (#1042 phase 2): a profile still holding the
/// shared bridge token trades it for this device's own credential right
/// after connecting, persists it in the connection profile, and uses it for
/// everything after — and rotates it when the daemon asks.
void main() {
  ConnectionConfig configFor(MockBridge bridge, String? token) =>
      ConnectionConfig(
        host: bridge.host,
        port: bridge.port,
        token: token,
        manageLocalDaemon: false,
        localAutoDiscover: false,
      );

  Future<(AppState, Prefs)> stateFor(
    MockBridge bridge,
    String? token, {
    String deviceId = 'dev_pixel8',
  }) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    await prefs.setConnection(configFor(bridge, token));
    await prefs.setMeshDeviceId(deviceId);
    return (AppState(prefs, narrowLayout: false), prefs);
  }

  test('a shared-token profile upgrades in band and keeps using the new credential',
      () async {
    final bridge = await MockBridge.start(token: 'shared-secret');
    bridge.issueCredentials = true;
    addTearDown(bridge.close);
    final (state, prefs) = await stateFor(bridge, 'shared-secret');
    addTearDown(state.dispose);

    await state.start();
    await _waitFor(() => isDeviceCredential(prefs.connection.token));

    expect(bridge.upgradeRequests, [
      BridgeClient.upgradeRequestBody('dev_pixel8'),
    ]);
    final credential = bridge.issuedCredentials.single;
    expect(prefs.connection.token, credential);
    expect(state.config.token, credential);
    expect(state.activeConfig.token, credential);

    // Everything after the swap authenticates as this device.
    final before = bridge.bearers.length;
    await state.refreshMeshDevices();
    expect(bridge.bearers.sublist(before), everyElement(credential));
  });

  test('a daemon without per-device credentials leaves the profile alone',
      () async {
    final bridge = await MockBridge.start(token: 'shared-secret');
    addTearDown(bridge.close);
    final (state, prefs) = await stateFor(bridge, 'shared-secret');
    addTearDown(state.dispose);

    await state.start();
    await _waitFor(() => state.conn == ConnState.connected);
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(prefs.connection.token, 'shared-secret');
    expect(bridge.upgradeRequests, isEmpty);
  });

  test('a requested rotation replaces the credential of this device', () async {
    final bridge = await MockBridge.start(token: 'shared-secret');
    bridge.issueCredentials = true;
    bridge.requestRotation = true;
    const old = 'tdc1.00000000000000aa.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx0';
    bridge.issuedCredentials.add(old);
    addTearDown(bridge.close);
    final (state, prefs) = await stateFor(bridge, old);
    addTearDown(state.dispose);

    await state.start();
    await _waitFor(() => prefs.connection.token != old);
    expect(isDeviceCredential(prefs.connection.token), isTrue);
    expect(prefs.connection.token, bridge.issuedCredentials.last);
    expect(bridge.upgradeRequests.single['deviceId'], 'dev_pixel8');
  });

  test('a per-device credential with nothing to do is never re-issued',
      () async {
    final bridge = await MockBridge.start(token: 'shared-secret');
    bridge.issueCredentials = true;
    const current = 'tdc1.00000000000000bb.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1';
    bridge.issuedCredentials.add(current);
    addTearDown(bridge.close);
    final (state, prefs) = await stateFor(bridge, current);
    addTearDown(state.dispose);

    await state.start();
    await _waitFor(() => state.conn == ConnState.connected);
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(prefs.connection.token, current);
    expect(bridge.upgradeRequests, isEmpty);
  });

  group('CredentialGrant', () {
    test('refuses a reply without a well-formed credential', () {
      expect(
        () => CredentialGrant.fromJson({'ok': true, 'token': 'hunter2'}),
        throwsFormatException,
      );
      expect(
        () => CredentialGrant.fromJson({'ok': false, 'error': 'nope'}),
        throwsFormatException,
      );
    });
  });
}

Future<void> _waitFor(
  bool Function() test, {
  Duration timeout = const Duration(seconds: 3),
}) async {
  final end = DateTime.now().add(timeout);
  while (!test()) {
    if (DateTime.now().isAfter(end)) fail('Timed out waiting for condition');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}
