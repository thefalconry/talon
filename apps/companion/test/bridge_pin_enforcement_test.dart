import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/services/bridge_client.dart';
import 'package:talon_companion/src/services/bridge_trust.dart';

/// A certificate that chains to a trusted CA used to skip the pin entirely:
/// `badCertificateCallback` only fires when platform validation fails. So
/// anyone who could get a CA-valid certificate for the bridge's name — a
/// hijacked dynamic-DNS name gets one in minutes — was accepted by the app
/// even though talon-node, which always checks the pin, would refuse it.
///
/// Here the daemon's fixture certificate is made "CA-valid" by trusting it
/// in this isolate's default context (each test file runs in its own), and
/// the profile pins a *different* certificate: exactly the impostor case.
void main() {
  const certPath = 'test/fixtures/bridge-cert.pem';
  const keyPath = 'test/fixtures/bridge-key.pem';
  final otherPin = '00' * 32;

  String fixtureFingerprint() {
    final pem = File(certPath).readAsStringSync();
    final body = pem
        .replaceAll(RegExp(r'-----(BEGIN|END) CERTIFICATE-----'), '')
        .replaceAll(RegExp(r'\s'), '');
    return sha256.convert(base64Decode(body)).toString();
  }

  setUpAll(() {
    SecurityContext.defaultContext.setTrustedCertificates(certPath);
  });

  Future<HttpServer> startCaValidServer() async {
    final context = SecurityContext()
      ..useCertificateChain(certPath)
      ..usePrivateKey(keyPath);
    final server = await HttpServer.bindSecure('127.0.0.1', 0, context);
    server.listen((req) {
      req.response
        ..headers.contentType = ContentType.json
        ..write(jsonEncode({'app': 'talon-bridge', 'ok': true}));
      req.response.close();
    });
    addTearDown(() => server.close(force: true));
    return server;
  }

  ConnectionConfig profile(int port, String pin, {required bool observed}) =>
      ConnectionConfig(
        host: '127.0.0.1',
        port: port,
        tls: true,
        fingerprint: pin,
        pinObserved: observed,
        manageLocalDaemon: false,
        localAutoDiscover: false,
      );

  test(
      'a profile whose pin was never observed still accepts a CA-valid '
      'certificate (reverse proxy with its own CA certificate)', () async {
    final server = await startCaValidServer();
    final client =
        BridgeClient(profile(server.port, otherPin, observed: false));
    addTearDown(client.dispose);

    expect(await client.health(), isNotNull);
    // The pin was never consulted, so nothing was observed.
    expect(client.pinObserved, isFalse);
  });

  test('an enforced pin refuses a CA-valid certificate that does not match',
      () async {
    final server = await startCaValidServer();
    final client = BridgeClient(profile(server.port, otherPin, observed: true));
    addTearDown(client.dispose);

    await expectLater(
      client.health(),
      throwsA(isA<BridgeException>()
          .having((e) => e.certificateChanged, 'certificateChanged', isTrue)),
    );
  });

  test('an enforced pin still connects to the pinned certificate', () async {
    final server = await startCaValidServer();
    final client = BridgeClient(
        profile(server.port, fixtureFingerprint(), observed: true));
    addTearDown(client.dispose);

    expect(await client.health(), isNotNull);
    await client.connect();
  });

  test('switching a live client to an enforced pin takes effect at once',
      () async {
    final server = await startCaValidServer();
    final client =
        BridgeClient(profile(server.port, otherPin, observed: false));
    addTearDown(client.dispose);
    expect(await client.health(), isNotNull);

    client.config = client.config.copyWith(pinObserved: true);
    await expectLater(client.health(), throwsA(isA<BridgeException>()));
  });

  group('BridgeTrust (implicitly-created clients)', () {
    tearDown(() => BridgeTrust.pin(null));

    Future<bool> reachable(HttpClient http, int port,
        {String host = '127.0.0.1'}) async {
      try {
        final req = await http.getUrl(Uri.parse('https://$host:$port/'));
        // A fresh connection every time: a pooled one would skip the
        // handshake this is about.
        req.persistentConnection = false;
        await (await req.close()).drain<void>();
        return true;
      } on HandshakeException {
        return false;
      }
    }

    ({String host, int port}) at(HttpServer s) =>
        (host: '127.0.0.1', port: s.port);

    test('enforces the pin on the bridge address', () async {
      final server = await startCaValidServer();
      final http = BridgeTrust().createHttpClient(null);
      addTearDown(() => http.close(force: true));

      BridgeTrust.pin(otherPin);
      expect(await reachable(http, server.port), isTrue,
          reason: 'CA-valid, pin not enforced');
      BridgeTrust.pin(otherPin, enforceOn: at(server));
      expect(await reachable(http, server.port), isFalse);
      BridgeTrust.pin(fixtureFingerprint(), enforceOn: at(server));
      expect(await reachable(http, server.port), isTrue);
    });

    test(
        'leaves CA-valid HTTPS to every other host alone (update checks, '
        'model downloads, web images)', () async {
      final bridge = await startCaValidServer();
      final elsewhere = await startCaValidServer();
      BridgeTrust.pin(otherPin, enforceOn: at(bridge));
      final http = BridgeTrust().createHttpClient(null);
      addTearDown(() => http.close(force: true));

      expect(await reachable(http, bridge.port), isFalse);
      expect(await reachable(http, elsewhere.port), isTrue);
      // Same port, another name: not the bridge's address either.
      expect(await reachable(http, bridge.port, host: 'localhost'), isTrue);
    });

    test(
        'a client created before the pin became binding enforces it too '
        "(NetworkImage's shared client lives as long as the process)",
        () async {
      final server = await startCaValidServer();
      BridgeTrust.pin(otherPin);
      final http = BridgeTrust().createHttpClient(null);
      addTearDown(() => http.close(force: true));
      expect(await reachable(http, server.port), isTrue);

      BridgeTrust.pin(otherPin, enforceOn: at(server));
      expect(await reachable(http, server.port), isFalse);
      BridgeTrust.pin(otherPin);
      expect(await reachable(http, server.port), isTrue);
    });

    test(
        "BridgeClient keeps its own pin when BridgeTrust is the app's "
        'HttpOverrides', () async {
      final server = await startCaValidServer();
      final previous = HttpOverrides.current;
      BridgeTrust.install();
      addTearDown(() => HttpOverrides.global = previous);
      // The process-wide pin is some other profile's.
      BridgeTrust.pin(otherPin, enforceOn: at(server));

      final client = BridgeClient(
          profile(server.port, fixtureFingerprint(), observed: true));
      addTearDown(client.dispose);
      expect(await client.health(), isNotNull);
      expect(client.pinObserved, isTrue);
    });
  });

  group('ConnectionConfig.pinObserved', () {
    const fp =
        'a1eeb6400000000000000000000000000000000000000000000000000000beef';
    const base = ConnectionConfig(
      host: 'mesh.example.org',
      port: 443,
      tls: true,
      fingerprint: fp,
      pinObserved: true,
    );

    test('round-trips through JSON; older profiles read as not observed', () {
      expect(ConnectionConfig.fromJson(base.toJson()).pinObserved, isTrue);
      final legacy = base.toJson()..remove('pinObserved');
      expect(ConnectionConfig.fromJson(legacy).pinObserved, isFalse);
    });

    test('enforces only with TLS and a pin', () {
      expect(base.enforcesPin, isTrue);
      expect(base.copyWith(tls: false).enforcesPin, isFalse);
      expect(base.copyWith(pinObserved: false).enforcesPin, isFalse);
    });

    test('survives unrelated edits and the LAN endpoint', () {
      expect(base.copyWith(token: 't').pinObserved, isTrue);
      expect(base.copyWith(fingerprint: fp).pinObserved, isTrue);
      expect(
        base
            .copyWith(localUrl: 'https://192.168.0.5:19880')
            .localEndpoint()!
            .enforcesPin,
        isTrue,
      );
    });

    test('resets when the pin changes or is cleared', () {
      expect(base.copyWith(fingerprint: 'b' * 64).pinObserved, isFalse);
      expect(base.copyWith(clearFingerprint: true).pinObserved, isFalse);
      // The main address behind a LAN one is checked the normal way.
      expect(
        base
            .copyWith(localUrl: 'https://192.168.0.5:19880')
            .remoteEndpoint()
            .enforcesPin,
        isFalse,
      );
    });
  });
}
