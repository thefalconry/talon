import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/services/bridge_client.dart';
import 'package:talon_companion/src/services/log.dart';
import 'package:talon_companion/src/services/secure_window.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('redactSecrets', () {
    test('strips the token from a quoted request URL', () {
      const raw = 'ClientException: Connection refused, '
          'uri=https://10.0.0.2:19880/events?token=s3cr3t-T0ken&deviceId=abc';
      final out = redactSecrets(raw);
      expect(out, isNot(contains('s3cr3t-T0ken')));
      expect(out, contains('token=…'));
      // Non-secret parameters survive, so the message stays useful.
      expect(out, contains('deviceId=abc'));
    });

    test('covers media URLs, pairing links, grants and bearer headers', () {
      for (final raw in [
        'GET /media?id=1&token=abc123 failed',
        'talon://pair?u=https%3A%2F%2Fh&t=abc123&f=00',
        '/node/binary?provision=abc123',
        'Authorization: Bearer abc123',
      ]) {
        expect(redactSecrets(raw), isNot(contains('abc123')), reason: raw);
      }
    });

    test('keeps a per-device credential id but drops its secret', () {
      const sample = 'Qm9ndXMtZml4dHVyZS1zZWNyZXQtbm90LWEtcmVhbC1';
      final out = redactSecrets(
        'upgrade reply {"token":"tdc1.0123456789abcdef.$sample"}',
      );
      expect(out, isNot(contains(sample)));
      expect(out, contains('tdc1.0123456789abcdef.…'));
    });

    test('leaves ordinary text alone', () {
      const text = 'Unauthorized — check your token (at=5, format=json)';
      expect(redactSecrets(text), text);
    });
  });

  test('BridgeException never stores the token', () {
    final e = BridgeException(
      'Could not open the event stream: uri=https://h/events?token=abc123',
    );
    expect(e.message, isNot(contains('abc123')));
    expect(e.toString(), isNot(contains('abc123')));
  });

  test('the in-app log ring is redacted', () {
    AppLog.warn('bridge', 'connect failed: https://h/events?token=abc123');
    expect(AppLog.recent.last, isNot(contains('abc123')));
    expect(AppLog.recent.last, contains('token=…'));
  });

  group('SecureWindow', () {
    const channel = MethodChannel('talon/secure-test');
    final calls = <Object?>[];

    setUp(() {
      calls.clear();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
        calls.add(call.arguments);
        return null;
      });
      SecureWindow.debugOverride(channel: channel, supported: true);
    });
    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
      SecureWindow.debugOverride(supported: false);
    });

    test('stays secure until the last holder releases', () async {
      SecureWindow.acquire(); // settings
      SecureWindow.acquire(); // connect, pushed from settings
      SecureWindow.release(); // connect popped
      await Future<void>.delayed(Duration.zero);
      expect(calls, [true]);
      SecureWindow.release(); // settings closed
      await Future<void>.delayed(Duration.zero);
      expect(calls, [true, false]);
      expect(SecureWindow.holders, 0);
    });

    test('the screenshot setting blocks app-wide; the lock holds regardless',
        () async {
      SecureWindow.setBlockScreenshots(true);
      await Future<void>.delayed(Duration.zero);
      expect(calls, [true]);
      SecureWindow.acquire(); // locked
      SecureWindow.setBlockScreenshots(false); // setting off while locked
      await Future<void>.delayed(Duration.zero);
      expect(calls, [true], reason: 'still locked, still secure');
      SecureWindow.release(); // unlocked
      await Future<void>.delayed(Duration.zero);
      expect(calls, [true, false]);
    });

    test('an extra release is harmless', () async {
      SecureWindow.release();
      await Future<void>.delayed(Duration.zero);
      expect(calls, isEmpty);
    });
  });
}
