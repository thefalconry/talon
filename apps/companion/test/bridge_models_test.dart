import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/models/connection.dart';

void main() {
  group('ConnectionConfig', () {
    test('builds base + events URLs; the token rides only in the header', () {
      const c = ConnectionConfig(host: '10.0.0.5', port: 1234, token: 'sk e/t');
      expect(c.baseUrl, 'http://10.0.0.5:1234');
      expect(c.eventsUrl(), 'http://10.0.0.5:1234/events');
      expect(c.authHeaders()['Authorization'], 'Bearer sk e/t');
    });

    test('events URL carries the device id, never the token', () {
      const c = ConnectionConfig(host: 'h', port: 5, token: 'secret');
      expect(
          c.eventsUrl(deviceId: 'dev 1'), 'http://h:5/events?deviceId=dev+1');
      expect(c.eventsUrl(deviceId: ''), 'http://h:5/events');
    });

    test('media URLs never carry the token', () {
      const c = ConnectionConfig(host: 'h', port: 5, token: 'secret');
      expect(c.mediaUrl('/media?id=1'), 'http://h:5/media?id=1');
      expect(c.mediaUrl('/media?id=1'), isNot(contains('secret')));
    });

    test('loopback detection + no token => no auth header', () {
      const c = ConnectionConfig();
      expect(c.isLoopback, isTrue);
      expect(c.eventsUrl(), 'http://127.0.0.1:19880/events');
      expect(c.authHeaders().containsKey('Authorization'), isFalse);
    });

    test('round-trips through json', () {
      const c = ConnectionConfig(
        host: 'host',
        port: 42,
        token: 't',
        tls: true,
        manageLocalDaemon: false,
        localAutoDiscover: true,
        launchCommand: 'talon',
        launchArgs: ['start'],
      );
      final back = ConnectionConfig.fromJson(c.toJson());
      expect(back.host, 'host');
      expect(back.port, 42);
      expect(back.token, 't');
      expect(back.tls, isTrue);
      expect(back.manageLocalDaemon, isFalse);
      expect(back.localAutoDiscover, isTrue);
    });

    test('tls flips scheme on base + events URLs', () {
      const c = ConnectionConfig(host: 'h', port: 8443, tls: true);
      expect(c.baseUrl, 'https://h:8443');
      expect(c.eventsUrl(), 'https://h:8443/events');
    });

    test('legacy json without tls defaults to plaintext', () {
      final c = ConnectionConfig.fromJson({'host': 'h', 'port': 5});
      expect(c.tls, isFalse);
      expect(c.baseUrl, 'http://h:5');
    });

    test('fingerprint round-trips through json, normalized', () {
      final fp = 'ab' * 32;
      final c = ConnectionConfig(host: 'h', tls: true, fingerprint: fp);
      expect(ConnectionConfig.fromJson(c.toJson()).fingerprint, fp);

      final display = ConnectionConfig.fromJson({
        'host': 'h',
        'port': 5,
        'fingerprint': ('AB:' * 32).substring(0, 95), // AA:BB display form
      });
      expect(display.fingerprint, 'ab' * 32);
    });

    test('normalizeFingerprint rejects everything but a sha-256 digest', () {
      expect(ConnectionConfig.normalizeFingerprint(null), isNull);
      expect(ConnectionConfig.normalizeFingerprint('not hex'), isNull);
      expect(ConnectionConfig.normalizeFingerprint('abcd'), isNull);
      expect(
        ConnectionConfig.normalizeFingerprint(('AB:' * 32).substring(0, 95)),
        'ab' * 32,
      );
    });

    test('copyWith carries, replaces, and clears the fingerprint', () {
      final fp = 'cd' * 32;
      final pinned = const ConnectionConfig(tls: true)
          .copyWith(fingerprint: fp);
      expect(pinned.fingerprint, fp);
      expect(pinned.copyWith(host: 'other').fingerprint, fp);
      expect(pinned.copyWith(clearFingerprint: true).fingerprint, isNull);
    });
  });

  group('default ports', () {
    test('https implies 443, http implies 80', () {
      expect(ConnectionConfig.defaultPortFor(true), 443);
      expect(ConnectionConfig.defaultPortFor(false), 80);
    });

    test('baseUrl omits the port when it is the scheme default', () {
      const tls = ConnectionConfig(host: 'mesh.example.org', port: 443, tls: true);
      expect(tls.baseUrl, 'https://mesh.example.org');
      expect(tls.usesDefaultPort, isTrue);

      const plain = ConnectionConfig(host: 'mesh.example.org', port: 80);
      expect(plain.baseUrl, 'http://mesh.example.org');
    });

    test('baseUrl keeps a non-default port', () {
      const c = ConnectionConfig(host: 'gw.ts.net', port: 19880, tls: true);
      expect(c.baseUrl, 'https://gw.ts.net:19880');
      expect(c.usesDefaultPort, isFalse);
    });

    test('event and media URLs follow the same shape', () {
      const c = ConnectionConfig(
        host: 'mesh.example.org',
        port: 443,
        tls: true,
      );
      expect(c.mediaUrl('/media?id=1'), startsWith('https://mesh.example.org/media'));
      expect(c.eventsUrl(), startsWith('https://mesh.example.org/events'));
    });
  });

  group('ConnectionConfig.parseHostInput', () {
    test('bare host is untouched', () {
      final r = ConnectionConfig.parseHostInput('192.168.1.20');
      expect(r.host, '192.168.1.20');
      expect(r.port, isNull);
      expect(r.tls, isNull);
    });

    test('strips https:// scheme and infers tls + path', () {
      final r = ConnectionConfig.parseHostInput('https://talon.example.com/');
      expect(r.host, 'talon.example.com');
      expect(r.tls, isTrue);
      expect(r.port, isNull);
    });

    test('http:// scheme infers plaintext', () {
      final r = ConnectionConfig.parseHostInput('http://host');
      expect(r.host, 'host');
      expect(r.tls, isFalse);
    });

    test('extracts embedded port', () {
      final r = ConnectionConfig.parseHostInput('host:19880');
      expect(r.host, 'host');
      expect(r.port, 19880);
    });

    test('full URL with scheme, port and path', () {
      final r = ConnectionConfig.parseHostInput(
        'https://gw.ts.net:19880/x?y=1',
      );
      expect(r.host, 'gw.ts.net');
      expect(r.port, 19880);
      expect(r.tls, isTrue);
    });

    test('IPv6 literal in brackets with port', () {
      final r = ConnectionConfig.parseHostInput('[::1]:1234');
      expect(r.host, '::1');
      expect(r.port, 1234);
    });

    test('bare IPv6 is not mistaken for host:port', () {
      final r = ConnectionConfig.parseHostInput('fe80::1');
      expect(r.host, 'fe80::1');
      expect(r.port, isNull);
    });

    test('trims surrounding whitespace', () {
      final r = ConnectionConfig.parseHostInput('  host  ');
      expect(r.host, 'host');
    });
  });

  group('wire model parsing', () {
    test('ClientMessage roles + buttons', () {
      final m = ClientMessage.fromJson({
        'id': 7,
        'chatId': 'd_1',
        'role': 'assistant',
        'text': 'hi',
        'ts': 1000,
        'buttons': [
          [
            {'text': 'Docs', 'url': 'https://x'},
          ],
        ],
        'reactions': ['👍'],
      });
      expect(m.id, '7');
      expect(m.role, Role.assistant);
      expect(m.buttons.first.first.text, 'Docs');
      expect(m.reactions, ['👍']);
    });

    test('defaults are tolerant of missing fields', () {
      final m = ClientMessage.fromJson({'id': 'x', 'role': 'user'});
      expect(m.role, Role.user);
      expect(m.text, '');
      expect(m.buttons, isEmpty);
    });

    test('defaults are tolerant of wrong-typed fields', () {
      final m = ClientMessage.fromJson({
        'id': null,
        'chatId': 123,
        'role': ['assistant'],
        'text': {'bad': true},
        'ts': '42',
        'buttons': [
          [
            {'text': 99, 'url': false},
            'bad button',
          ],
          'bad row',
        ],
        'reactions': 'bad',
      });
      expect(m.id, '');
      expect(m.chatId, '123');
      expect(m.role, Role.user);
      expect(m.text, '{bad: true}');
      expect(m.ts, 42);
      expect(m.buttons.first.first.text, '99');
      expect(m.reactions, isEmpty);

      final chat = ClientChat.fromJson({
        'id': 1,
        'title': 2,
        'createdAt': '3',
        'lastActive': 4.8,
        'preview': {'x': true},
      });
      expect(chat.id, '1');
      expect(chat.title, '2');
      expect(chat.createdAt, 3);
      expect(chat.lastActive, 4);
      expect(chat.preview, '{x: true}');

      final cfg = ConfigSnapshot.fromJson({
        'pulse': 'bad',
        'pulseIntervalMs': '100',
        'health': {'healthy': 'bad', 'sessions': '2'},
      });
      expect(cfg.pulse, isFalse);
      expect(cfg.pulseIntervalMs, 100);
      expect(cfg.healthy, isFalse);
      expect(cfg.sessions, 2);
    });

    test('ClientChat + ConfigSnapshot', () {
      final chat = ClientChat.fromJson({
        'id': 'd_1',
        'title': 'General',
        'createdAt': 1,
        'lastActive': 2,
        'preview': 'hey',
        // Carried by the daemon for the group-chat frontends; this client
        // ignores it rather than modelling it.
        'pulse': true,
      });
      expect(chat.title, 'General');

      final cfg = ConfigSnapshot.fromJson({
        'backend': 'claude',
        'model': 'default',
        'modelDisplay': 'Opus',
        'botDisplayName': 'Talon',
        'pulse': true,
        'pulseIntervalMs': 300000,
        'heartbeat': false,
        'heartbeatIntervalMinutes': 60,
        'dream': true,
        'editable': ['model'],
        'health': {'healthy': true, 'sessions': 3, 'memoryMb': 120},
      });
      expect(cfg.modelDisplay, 'Opus');
      expect(cfg.sessions, 3);
      expect(cfg.healthy, isTrue);
      expect(cfg.editable, contains('model'));
    });
  });
}
