import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/services/connection_vault.dart';
import 'package:talon_companion/src/services/log.dart';
import 'package:talon_companion/src/services/prefs.dart';

/// #1056: the bridge token (shared or per-device) and the client certificate
/// live in the OS keystore, not in the SharedPreferences JSON.
void main() {
  late MemoryConnectionVault vault;

  setUp(() {
    vault = MemoryConnectionVault();
    Prefs.vault = vault;
    Prefs.resetVaultWarning();
  });

  tearDown(() => Prefs.vault = null);

  const profile = ConnectionConfig(
    host: 'mesh.example.org',
    port: 443,
    token: 'tok-1',
    tls: true,
    clientP12: 'cDEy',
    clientP12Password: 'pw',
    manageLocalDaemon: false,
    localAutoDiscover: false,
  );

  Map<String, dynamic> storedJson(SharedPreferences sp) =>
      (jsonDecode(sp.getString('connection.v1')!) as Map)
          .cast<String, dynamic>();

  Map<String, dynamic> vaulted() =>
      (jsonDecode(vault.blob!) as Map).cast<String, dynamic>();

  test('moves secrets out of the settings file on first load', () async {
    SharedPreferences.setMockInitialValues({
      'connection.v1': jsonEncode(profile.toJson()),
    });

    final prefs = await Prefs.load();
    final sp = await SharedPreferences.getInstance();

    expect(vaulted(), {
      'token': 'tok-1',
      'clientP12': 'cDEy',
      'clientP12Password': 'pw',
    });
    final json = storedJson(sp);
    for (final k in ConnectionConfig.secretKeys) {
      expect(json.containsKey(k), isFalse, reason: k);
    }
    expect(json['host'], 'mesh.example.org');

    // The profile reads back whole.
    final c = prefs.connection;
    expect(c.token, 'tok-1');
    expect(c.clientP12, 'cDEy');
    expect(c.clientP12Password, 'pw');
    expect(c.host, 'mesh.example.org');
  });

  test('new profiles write their token to the keystore only', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final sp = await SharedPreferences.getInstance();

    await prefs.setConnection(profile.copyWith(token: 'tok-2'));

    expect(sp.getString('connection.v1'), isNot(contains('tok-2')));
    expect(vaulted()['token'], 'tok-2');
    expect(prefs.connection.token, 'tok-2');
  });

  test('clearing the profile clears the keystore entry', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    await prefs.setConnection(profile);

    await prefs.setConnection(ConnectionConfig.defaults());

    expect(vault.blob, isNull);
    expect(prefs.connection.token, isNull);
  });

  test('another isolate sees a new token after reload', () async {
    // The mesh foreground service is a second Prefs over the same stores.
    SharedPreferences.setMockInitialValues({});
    final ui = await Prefs.load();
    final background = await Prefs.load();
    await ui.setConnection(profile);
    await background.reload();
    expect(background.connection.token, 'tok-1');

    // A per-device credential upgrade in the UI isolate.
    await ui.setConnection(ui.connection.copyWith(token: 'dev-cred'));
    await background.reload();
    expect(background.connection.token, 'dev-cred');
  });

  test('without a keystore the settings file keeps them, with a log line',
      () async {
    vault.failing = true;
    SharedPreferences.setMockInitialValues({
      'connection.v1': jsonEncode(profile.toJson()),
    });

    final prefs = await Prefs.load();
    final sp = await SharedPreferences.getInstance();

    expect(prefs.connection.token, 'tok-1');
    expect(storedJson(sp)['token'], 'tok-1');
    expect(
      AppLog.recent.where((l) => l.contains('OS keystore unavailable')),
      isNotEmpty,
    );

    await prefs.setConnection(profile.copyWith(token: 'tok-3'));
    expect(storedJson(sp)['token'], 'tok-3');
    expect(prefs.connection.token, 'tok-3');

    // Once the keystore works again the next load moves them.
    vault.failing = false;
    await prefs.reload();
    expect(vaulted()['token'], 'tok-3');
    expect(storedJson(sp).containsKey('token'), isFalse);
    expect(prefs.connection.token, 'tok-3');
  });

  test('a token cleared while the keystore was down stays cleared', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    await prefs.setConnection(profile);

    vault.failing = true;
    await prefs.setConnection(profile.copyWith(clearToken: true));
    vault.failing = false;
    await prefs.reload();

    expect(prefs.connection.token, isNull);
    expect(vaulted().containsKey('token'), isFalse);
  });

  test('no vault configured behaves as before (settings file)', () async {
    Prefs.vault = null;
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final sp = await SharedPreferences.getInstance();

    await prefs.setConnection(profile);

    expect(storedJson(sp)['token'], 'tok-1');
    expect(prefs.connection.token, 'tok-1');
    expect(vault.blob, isNull);
  });
}
