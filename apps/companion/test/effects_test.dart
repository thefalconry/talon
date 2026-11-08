import 'dart:io' show Platform;

import 'package:flutter/foundation.dart'
    show debugDefaultTargetPlatformOverride;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/ui/effects.dart';
import 'package:talon_companion/src/ui/glass.dart';

/// #1058: the decorative layer must go quiet when nobody is looking, and
/// "Reduce effects" must remove the live blur entirely.
bool _blurOn(WidgetTester tester) =>
    tester.widget<BackdropFilter>(find.byType(BackdropFilter)).enabled;

Widget _host(Widget child) => MediaQuery(
      // Animations explicitly allowed: these tests are about *our* gating,
      // not the platform reduce-motion switch.
      data: const MediaQueryData(size: Size(800, 600)),
      child: Directionality(textDirection: TextDirection.ltr, child: child),
    );

/// A little past one full ambient sweep, so its end-of-sweep check runs.
const _pastSweep = Duration(seconds: 20, milliseconds: 200);

void main() {
  setUp(TalonEffects.resetForTest);
  tearDown(TalonEffects.resetForTest);

  group('Glass', () {
    testWidgets('uses a live BackdropFilter by default', (tester) async {
      await tester.pumpWidget(_host(const Glass(child: SizedBox(height: 40))));
      expect(_blurOn(tester), isTrue);
    });

    testWidgets('paints a static fill under Reduce effects', (tester) async {
      TalonEffects.reduce.value = true;
      await tester.pumpWidget(_host(const Glass(child: SizedBox(height: 40))));
      expect(_blurOn(tester), isFalse);
    });

    testWidgets('toggling Reduce effects restyles without remounting',
        (tester) async {
      await tester.pumpWidget(_host(const Glass(child: _Probe())));
      final probe = tester.state(find.byType(_Probe));
      expect(_blurOn(tester), isTrue);
      TalonEffects.reduce.value = true;
      await tester.pump();
      expect(_blurOn(tester), isFalse);
      TalonEffects.reduce.value = false;
      await tester.pump();
      expect(_blurOn(tester), isTrue);
      // Same State object throughout: the panel's contents never remounted.
      expect(tester.state(find.byType(_Probe)), same(probe));
    });
  });

  group('AmbientGlow', () {
    test('sweep constant matches the test helper', () {
      expect(_pastSweep > AmbientGlow.sweep, isTrue);
    });

    testWidgets('animates while focused and active', (tester) async {
      await tester.pumpWidget(_host(const TalonBackdrop(child: SizedBox())));
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.binding.hasScheduledFrame, isTrue);
    });

    testWidgets('schedules no frames under Reduce effects', (tester) async {
      TalonEffects.reduce.value = true;
      await tester.pumpWidget(_host(const TalonBackdrop(child: SizedBox())));
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.binding.hasScheduledFrame, isFalse);
    });

    testWidgets('stops when the window loses focus and resumes on return',
        (tester) async {
      await tester.pumpWidget(_host(const TalonBackdrop(child: SizedBox())));
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.binding.hasScheduledFrame, isTrue);

      TalonEffects.setLifecycle(AppLifecycleState.inactive);
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.binding.hasScheduledFrame, isFalse);

      TalonEffects.setLifecycle(AppLifecycleState.hidden);
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.binding.hasScheduledFrame, isFalse);

      TalonEffects.setLifecycle(AppLifecycleState.resumed);
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.binding.hasScheduledFrame, isTrue);
    });

    testWidgets('settles after the user goes idle, wakes on input',
        (tester) async {
      var now = DateTime(2026);
      TalonEffects.clock = () => now;
      TalonEffects.markActivity();

      await tester.pumpWidget(_host(const ActivityListener(
        child: TalonBackdrop(child: SizedBox.expand()),
      )));
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.binding.hasScheduledFrame, isTrue);

      // Still active at the end of the first sweep → keeps going.
      now = now.add(const Duration(seconds: 5));
      await tester.pump(_pastSweep);
      await tester.pump(const Duration(milliseconds: 100));
      expect(TalonEffects.idle.value, isFalse);
      expect(tester.binding.hasScheduledFrame, isTrue);

      // No input past the idle threshold → the next sweep end settles it.
      now = now.add(TalonEffects.idleAfter);
      await tester.pump(_pastSweep);
      await tester.pump(const Duration(milliseconds: 100));
      expect(TalonEffects.idle.value, isTrue);
      expect(tester.binding.hasScheduledFrame, isFalse);

      // Any input over the window wakes it.
      await tester.tapAt(const Offset(10, 10));
      await tester.pump();
      expect(TalonEffects.idle.value, isFalse);
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.binding.hasScheduledFrame, isTrue);
    });
  });

  testWidgets('AmbientMotion mutes looping tickers while unfocused',
      (tester) async {
    late BuildContext inner;
    await tester.pumpWidget(_host(AmbientMotion(
      child: Builder(builder: (context) {
        inner = context;
        return const SizedBox();
      }),
    )));
    expect(TickerMode.valuesOf(inner).enabled, isTrue);
    TalonEffects.setLifecycle(AppLifecycleState.inactive);
    await tester.pump();
    expect(TickerMode.valuesOf(inner).enabled, isFalse);
    TalonEffects.setLifecycle(AppLifecycleState.resumed);
    await tester.pump();
    expect(TickerMode.valuesOf(inner).enabled, isTrue);
  });

  testWidgets('software GL forces blur and ambient motion off',
      (tester) async {
    TalonEffects.softwareRendering = true;
    await tester.pumpWidget(_host(const TalonBackdrop(
      child: Glass(child: SizedBox(height: 40)),
    )));
    await tester.pump(const Duration(milliseconds: 100));
    expect(_blurOn(tester), isFalse);
    expect(tester.binding.hasScheduledFrame, isFalse);
  });

  test('isSoftwareGl reads the Mesa overrides (Linux only)', () {
    final linux = Platform.isLinux;
    expect(TalonEffects.isSoftwareGl(const {}), isFalse);
    expect(TalonEffects.isSoftwareGl(const {'LIBGL_ALWAYS_SOFTWARE': '1'}),
        linux);
    expect(TalonEffects.isSoftwareGl(const {'LIBGL_ALWAYS_SOFTWARE': 'true'}),
        linux);
    expect(
        TalonEffects.isSoftwareGl(const {'LIBGL_ALWAYS_SOFTWARE': '0'}), isFalse);
    expect(TalonEffects.isSoftwareGl(const {'GALLIUM_DRIVER': 'llvmpipe'}),
        linux);
    expect(
        TalonEffects.isSoftwareGl(const {'GALLIUM_DRIVER': 'iris'}), isFalse);
  });

  group('Prefs.reduceEffects', () {
    test('defaults on for Windows and Linux, off elsewhere', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      try {
        for (final p in TargetPlatform.values) {
          debugDefaultTargetPlatformOverride = p;
          expect(prefs.reduceEffects, TalonEffects.defaultReduceFor(p),
              reason: '$p');
        }
        debugDefaultTargetPlatformOverride = TargetPlatform.windows;
        expect(prefs.reduceEffects, isTrue);
        debugDefaultTargetPlatformOverride = TargetPlatform.android;
        expect(prefs.reduceEffects, isFalse);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });

    test('an explicit choice wins over the platform default', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await Prefs.load();
      try {
        debugDefaultTargetPlatformOverride = TargetPlatform.linux;
        await prefs.setReduceEffects(false);
        expect(prefs.reduceEffects, isFalse);
        debugDefaultTargetPlatformOverride = TargetPlatform.android;
        await prefs.setReduceEffects(true);
        expect(prefs.reduceEffects, isTrue);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });
  });
}

class _Probe extends StatefulWidget {
  const _Probe();

  @override
  State<_Probe> createState() => _ProbeState();
}

class _ProbeState extends State<_Probe> {
  @override
  Widget build(BuildContext context) => const SizedBox(height: 40);
}
