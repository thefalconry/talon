import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/services/bridge_client.dart';
import 'package:talon_companion/src/services/endpoint.dart';

/// Immich-style access through a reverse proxy: an imported .p12 client
/// certificate gets the app through a proxy that demands one, and the app
/// switches between the local and the main address on its own.
///
/// Fixtures: a throwaway test CA (client-ca-cert.pem) and a client
/// certificate it signed, exported as client.p12 (password "talon") with
/// `openssl pkcs12 -export -legacy` — the command the docs recommend.
void main() {
  const serverCert = 'test/fixtures/bridge-cert.pem';
  const serverKey = 'test/fixtures/bridge-key.pem';
  const clientCa = 'test/fixtures/client-ca-cert.pem';
  const clientP12 = 'test/fixtures/client.p12';

  String importFixture() => ConnectionConfig.importP12(
        File(clientP12).readAsBytesSync(),
        'talon',
      );

  /// A stand-in for a reverse proxy that asks for a client certificate and
  /// reports the subject of whatever the handshake verified.
  Future<HttpServer> startCertProxy() async {
    final context = SecurityContext()
      ..useCertificateChain(serverCert)
      ..usePrivateKey(serverKey)
      ..setTrustedCertificates(clientCa);
    final server = await HttpServer.bindSecure(
      '127.0.0.1',
      0,
      context,
      requestClientCertificate: true,
    );
    server.listen((req) {
      req.response
        ..headers.contentType = ContentType.json
        ..write(jsonEncode({
          'app': 'talon-bridge',
          'ok': true,
          'clientSubject': req.certificate?.subject,
        }));
      req.response.close();
    });
    return server;
  }

  ConnectionConfig tlsConfig(int port, {String? p12}) => ConnectionConfig(
        host: '127.0.0.1',
        port: port,
        tls: true,
        clientP12: p12,
        clientP12Password: p12 == null ? null : 'talon',
        manageLocalDaemon: false,
        localAutoDiscover: false,
      );

  group('importing a certificate', () {
    test('opens a .p12 with its password', () {
      final p12 = importFixture();
      final c = tlsConfig(1, p12: p12);
      expect(c.hasClientCert, isTrue);
      expect(c.clientSecurityContext(), isNotNull);
    });

    test('refuses a wrong password with a message for the user', () {
      expect(
        () => ConnectionConfig.importP12(
          File(clientP12).readAsBytesSync(),
          'nope',
        ),
        throwsFormatException,
      );
    });

    test('survives the round trip through saved settings', () {
      final c = tlsConfig(19880, p12: importFixture()).copyWith(
        localUrl: 'https://192.168.1.20:19880',
      );
      final back = ConnectionConfig.fromJson(c.toJson());
      expect(back.clientP12, c.clientP12);
      expect(back.clientP12Password, 'talon');
      expect(back.localUrl, 'https://192.168.1.20:19880');
      expect(back.copyWith(clearClientCert: true).hasClientCert, isFalse);
    });
  });

  group('through a proxy that asks for a certificate', () {
    test('presents the imported certificate', () async {
      final proxy = await startCertProxy();
      addTearDown(() => proxy.close(force: true));
      final client =
          BridgeClient(tlsConfig(proxy.port, p12: importFixture()));
      addTearDown(client.dispose);

      final health = await client.health();

      expect(health, isNotNull);
      expect(health!['clientSubject'], isNotNull);
    });

    test('presents nothing when none is imported', () async {
      final proxy = await startCertProxy();
      addTearDown(() => proxy.close(force: true));
      final client = BridgeClient(tlsConfig(proxy.port));
      addTearDown(client.dispose);

      final health = await client.health();

      expect(health!['clientSubject'], isNull);
    });

    test('reads refusals as "import a certificate"', () async {
      // nginx's answer to a missing certificate, and Cloudflare's.
      for (final refusal in [
        (400, <String, String>{}, 'No required SSL certificate was sent'),
        (403, {'cf-ray': '8a1b2c3d4e5f-AMS'}, '<html>Access denied</html>'),
      ]) {
        final server = await HttpServer.bind('127.0.0.1', 0);
        server.listen((req) {
          req.response.statusCode = refusal.$1;
          refusal.$2.forEach(req.response.headers.set);
          req.response
            ..write(refusal.$3)
            ..close();
        });
        final client = BridgeClient(ConnectionConfig(
          host: '127.0.0.1',
          port: server.port,
          manageLocalDaemon: false,
          localAutoDiscover: false,
        ));
        await expectLater(
          client.health(),
          throwsA(isA<BridgeException>().having(
              (e) => e.clientCertificateRequired, 'certRequired', isTrue)),
        );
        client.dispose();
        await server.close(force: true);
      }
    });

    test('recognises a TLS client-certificate alert', () {
      expect(
        BridgeClient.isClientCertificateAlert(
          const HandshakeException('TLSV13_ALERT_CERTIFICATE_REQUIRED'),
        ),
        isTrue,
      );
      expect(
        BridgeClient.isClientCertificateAlert(
          const HandshakeException('CERTIFICATE_VERIFY_FAILED'),
        ),
        isFalse,
      );
    });
  });

  group('local ↔ main address', () {
    Future<HttpServer> startPlainBridge() async {
      final server = await HttpServer.bind('127.0.0.1', 0);
      server.listen((req) {
        req.response
          ..headers.contentType = ContentType.json
          ..write(jsonEncode({'app': 'talon-bridge', 'ok': true}));
        req.response.close();
      });
      return server;
    }

    ConnectionConfig profile(String localUrl) => ConnectionConfig(
          host: 'talon.example.com',
          port: 443,
          tls: true,
          token: 'secret',
          fingerprint: 'ab' * 32,
          localUrl: localUrl,
          manageLocalDaemon: false,
          localAutoDiscover: false,
        );

    test('uses the local address when it answers', () async {
      final lan = await startPlainBridge();
      addTearDown(() => lan.close(force: true));

      final chosen =
          await resolveEndpoint(profile('http://127.0.0.1:${lan.port}'));

      expect(chosen.host, '127.0.0.1');
      expect(chosen.port, lan.port);
      expect(chosen.token, 'secret'); // still authenticates the same way
      // The pin is the LAN bridge's, so it travels with the local address.
      expect(chosen.fingerprint, 'ab' * 32);
    });

    test('falls back to the main address when the local one is out of reach',
        () async {
      final closed = await HttpServer.bind('127.0.0.1', 0);
      final port = closed.port;
      await closed.close(force: true);

      final chosen = await resolveEndpoint(
        profile('http://127.0.0.1:$port'),
        probeTimeout: const Duration(milliseconds: 500),
      );

      expect(chosen.host, 'talon.example.com');
      expect(chosen.token, 'secret');
      // The proxy's certificate is checked the normal way, not against the
      // LAN bridge's pin.
      expect(chosen.fingerprint, isNull);
    });

    test('a profile without a local address is used as-is', () async {
      const c = ConnectionConfig(host: 'h', port: 1);
      expect(identical(await resolveEndpoint(c), c), isTrue);
    });
  });
}
