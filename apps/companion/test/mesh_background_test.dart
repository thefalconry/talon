import 'package:flutter_test/flutter_test.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:talon_companion/src/services/mesh_background.dart';
import 'package:talon_companion/src/services/network_watch.dart';

void main() {
  group('event-stream liveness', () {
    final t0 = DateTime(2026, 9, 30, 12);
    const idle = Duration(seconds: 70);

    test('a stream never opened is not "dead"', () {
      expect(streamLooksDead(null, t0, idle), isFalse);
    });

    test('a stream silent past the idle deadline is dead', () {
      expect(
        streamLooksDead(t0, t0.add(const Duration(seconds: 30)), idle),
        isFalse,
      );
      expect(
        streamLooksDead(t0, t0.add(const Duration(seconds: 71)), idle),
        isTrue,
      );
    });

    test('alive is stamped from the stream, not the registration', () {
      final now = t0.add(const Duration(seconds: 50)).millisecondsSinceEpoch;
      expect(
        meshAliveStamp(streamLastRx: t0, connected: true, nowMs: now),
        t0.millisecondsSinceEpoch,
      );
      // Registration succeeded but no stream is up: no stamp at all.
      expect(
        meshAliveStamp(streamLastRx: t0, connected: false, nowMs: now),
        isNull,
      );
      expect(
        meshAliveStamp(streamLastRx: null, connected: true, nowMs: now),
        isNull,
      );
    });
  });

  group('networkKey', () {
    test('is order-independent and distinguishes interfaces', () {
      expect(
        networkKey([ConnectivityResult.wifi, ConnectivityResult.mobile]),
        networkKey([ConnectivityResult.mobile, ConnectivityResult.wifi]),
      );
      expect(
        networkKey([ConnectivityResult.wifi]),
        isNot(networkKey([ConnectivityResult.mobile])),
      );
    });
  });

  group('evaluateMeshForegroundHealth', () {
    test('does not bounce during the fresh-start grace window', () {
      final health = evaluateMeshForegroundHealth(
        supported: true,
        sharingEnabled: true,
        serviceRunning: true,
        nowMs: 20 * 1000,
        aliveAtMs: null,
        startedAtMs: 10 * 1000,
      );

      expect(health.kind, MeshForegroundHealthKind.starting);
      expect(health.shouldBounce, isFalse);
    });

    test('bounces a running service with no alive stamp after grace', () {
      final health = evaluateMeshForegroundHealth(
        supported: true,
        sharingEnabled: true,
        serviceRunning: true,
        nowMs: 45 * 1000,
        aliveAtMs: null,
        startedAtMs: 10 * 1000,
      );

      expect(health.kind, MeshForegroundHealthKind.stale);
      expect(health.shouldBounce, isTrue);
    });

    test('keeps a recently alive running service', () {
      final health = evaluateMeshForegroundHealth(
        supported: true,
        sharingEnabled: true,
        serviceRunning: true,
        nowMs: 100 * 1000,
        aliveAtMs: 30 * 1000,
        startedAtMs: 0,
      );

      expect(health.kind, MeshForegroundHealthKind.healthy);
      expect(health.shouldBounce, isFalse);
    });

    test('bounces a running service with a stale alive stamp', () {
      final health = evaluateMeshForegroundHealth(
        supported: true,
        sharingEnabled: true,
        serviceRunning: true,
        nowMs: 200 * 1000,
        aliveAtMs: 30 * 1000,
        startedAtMs: 0,
      );

      expect(health.kind, MeshForegroundHealthKind.stale);
      expect(health.shouldBounce, isTrue);
    });

    test('does not bounce when sharing is disabled or service is stopped', () {
      final disabled = evaluateMeshForegroundHealth(
        supported: true,
        sharingEnabled: false,
        serviceRunning: true,
        nowMs: 200 * 1000,
        aliveAtMs: null,
        startedAtMs: 0,
      );
      final stopped = evaluateMeshForegroundHealth(
        supported: true,
        sharingEnabled: true,
        serviceRunning: false,
        nowMs: 200 * 1000,
        aliveAtMs: null,
        startedAtMs: 0,
      );

      expect(disabled.shouldBounce, isFalse);
      expect(stopped.shouldBounce, isFalse);
    });
  });
}
