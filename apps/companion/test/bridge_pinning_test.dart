import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/services/bridge_client.dart';
import 'package:talon_companion/src/services/bridge_trust.dart';

/// End-to-end certificate pinning against a real TLS server using the
/// fixture certificate minted by the daemon's own generator
/// (src/frontend/native/bridge/tls.ts) — so this doubles as proof that Dart's TLS
/// stack accepts what the daemon serves.
void main() {
  const certPath = 'test/fixtures/bridge-cert.pem';
  const keyPath = 'test/fixtures/bridge-key.pem';

  /// The pin a client should hold for the fixture: SHA-256 over the DER.
  String fixtureFingerprint() {
    final pem = File(certPath).readAsStringSync();
    final base64Body = pem
        .replaceAll(RegExp(r'-----(BEGIN|END) CERTIFICATE-----'), '')
        .replaceAll(RegExp(r'\s'), '');
    return sha256.convert(base64Decode(base64Body)).toString();
  }

  Future<HttpServer> startTlsBridge() async {
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
    return server;
  }

  ConnectionConfig config(int port, {String? fingerprint}) => ConnectionConfig(
        host: '127.0.0.1',
        port: port,
        tls: true,
        fingerprint: fingerprint,
        manageLocalDaemon: false,
        localAutoDiscover: false,
      );

  test('first connect adopts the certificate (trust on first use)', () async {
    final server = await startTlsBridge();
    addTearDown(() => server.close(force: true));
    final client = BridgeClient(config(server.port));
    addTearDown(client.dispose);

    final health = await client.health();

    expect(health, isNotNull);
    expect(health!['app'], 'talon-bridge');
    expect(client.seenFingerprint, fixtureFingerprint());
  });

  test('a matching pin connects', () async {
    final server = await startTlsBridge();
    addTearDown(() => server.close(force: true));
    final client =
        BridgeClient(config(server.port, fingerprint: fixtureFingerprint()));
    addTearDown(client.dispose);

    expect(await client.health(), isNotNull);
  });

  test('a mismatched pin refuses the handshake with a clear error', () async {
    final server = await startTlsBridge();
    addTearDown(() => server.close(force: true));
    final client =
        BridgeClient(config(server.port, fingerprint: '00' * 32));
    addTearDown(client.dispose);

    await expectLater(
      client.health(),
      throwsA(
        isA<BridgeException>()
            .having((e) => e.certificateChanged, 'certificateChanged', isTrue),
      ),
    );
  });

  test('BridgeTrust accepts exactly the pinned certificate', () async {
    final server = await startTlsBridge();
    addTearDown(() => server.close(force: true));

    // Reach the server the way Image.network would: a plain HttpClient
    // whose only trust comes from the badCertificateCallback.
    Future<bool> reachable() async {
      final http = BridgeTrust().createHttpClient(null);
      try {
        final req =
            await http.getUrl(Uri.parse('https://127.0.0.1:${server.port}/'));
        await (await req.close()).drain<void>();
        return true;
      } on HandshakeException {
        return false;
      } finally {
        http.close(force: true);
      }
    }

    BridgeTrust.pin(null);
    expect(await reachable(), isFalse);

    BridgeTrust.pin('11' * 32);
    expect(await reachable(), isFalse);

    BridgeTrust.pin(fixtureFingerprint());
    expect(await reachable(), isTrue);

    BridgeTrust.pin(null); // leave no global state for other tests
  });

  group('probeCertificate (manual-entry confirmation)', () {
    test('reports the certificate without sending the token', () async {
      final seen = <(String, String?)>[];
      final context = SecurityContext()
        ..useCertificateChain(certPath)
        ..usePrivateKey(keyPath);
      final server = await HttpServer.bindSecure('127.0.0.1', 0, context);
      addTearDown(() => server.close(force: true));
      server.listen((req) {
        seen.add((
          req.uri.toString(),
          req.headers.value(HttpHeaders.authorizationHeader),
        ));
        req.response
          ..headers.contentType = ContentType.json
          ..write(jsonEncode({'app': 'talon-bridge', 'ok': true}));
        req.response.close();
      });

      // A token and a stale pin on the profile: neither reaches the wire,
      // and the stale pin does not stop the certificate being observed.
      final probe = await BridgeClient.probeCertificate(
        config(server.port, fingerprint: '00' * 32)
            .copyWith(token: 'secret-token'),
      );

      expect(probe.fingerprint, fixtureFingerprint());
      expect(probe.reached, isTrue);
      expect(seen, [('/health', null)]);
    });

    test('nothing listening: no fingerprint, not reached', () async {
      final socket = await ServerSocket.bind('127.0.0.1', 0);
      final port = socket.port;
      await socket.close();

      final probe = await BridgeClient.probeCertificate(
        config(port),
        timeout: const Duration(seconds: 2),
      );

      expect(probe.fingerprint, isNull);
      expect(probe.reached, isFalse);
    });
  });
}
