/// Shared plumbing for the golden renders in this directory: real fonts, a
/// deterministic app shell, phone/desktop viewports, a fake image server and
/// a seeded [AppState]. See README.md next to this file for how to run it.
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';

/// Goldens only run when asked for: they are review renders, not a CI gate
/// (font rasterisation differs between macOS and the Linux runners, so a
/// committed PNG would never match on both).
final bool goldensEnabled = Platform.environment['TALON_GOLDENS'] == '1';

/// Phone: an iPhone-15-class 390×844 logical viewport with real insets.
const Size phoneSize = Size(390, 844);

/// Desktop: a modest laptop window.
const Size desktopSize = Size(1100, 760);

Future<void> loadRealFonts() async {
  Future<ByteData> asset(String file) async {
    final bytes = await File('assets/fonts/$file').readAsBytes();
    return ByteData.view(bytes.buffer);
  }

  final inter = FontLoader('Inter')
    ..addFont(asset('Inter-Regular.ttf'))
    ..addFont(asset('Inter-Medium.ttf'))
    ..addFont(asset('Inter-SemiBold.ttf'))
    ..addFont(asset('Inter-Bold.ttf'));
  await inter.load();
  final mono = FontLoader('JetBrains Mono')
    ..addFont(asset('JetBrainsMono-Regular.ttf'))
    ..addFont(asset('JetBrainsMono-Medium.ttf'))
    ..addFont(asset('JetBrainsMono-Bold.ttf'));
  await mono.load();

  final root = Platform.environment['FLUTTER_ROOT'] ??
      _flutterRootFromExecutable();
  if (root != null) {
    final dir = '$root/bin/cache/artifacts/material_fonts';
    Future<ByteData> sdk(String file) async {
      final bytes = await File('$dir/$file').readAsBytes();
      return ByteData.view(bytes.buffer);
    }

    if (File('$dir/MaterialIcons-Regular.otf').existsSync()) {
      final icons = FontLoader('MaterialIcons')
        ..addFont(sdk('MaterialIcons-Regular.otf'));
      await icons.load();
    }
    if (File('$dir/Roboto-Regular.ttf').existsSync()) {
      final roboto = FontLoader('Roboto')
        ..addFont(sdk('Roboto-Regular.ttf'))
        ..addFont(sdk('Roboto-Medium.ttf'))
        ..addFont(sdk('Roboto-Bold.ttf'));
      await roboto.load();
    }
  }

  // Emoji: no emoji face in the SDK cache; borrow the system's when present.
  for (final path in const [
    '/System/Library/Fonts/Apple Color Emoji.ttc',
    '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
    '/usr/share/fonts/google-noto-emoji/NotoColorEmoji.ttf',
  ]) {
    final f = File(path);
    if (!f.existsSync()) continue;
    final bytes = await f.readAsBytes();
    final emoji = FontLoader('Noto Color Emoji')
      ..addFont(Future.value(ByteData.view(bytes.buffer)));
    await emoji.load();
    break;
  }
}

/// `flutter test` runs from a Dart VM whose executable lives in the SDK's
/// cache; walk up from it when FLUTTER_ROOT isn't exported.
String? _flutterRootFromExecutable() {
  var dir = File(Platform.resolvedExecutable).parent;
  for (var i = 0; i < 8; i++) {
    if (Directory('${dir.path}/bin/cache/artifacts').existsSync()) {
      return dir.path;
    }
    dir = dir.parent;
  }
  return null;
}

/// Noon today: keeps day buckets ("Today") stable whatever hour the renders
/// are made.
DateTime get anchor {
  final n = DateTime.now();
  return DateTime(n.year, n.month, n.day, 12);
}

int tsAt({int minutes = 0, int seconds = 0}) => anchor
    .subtract(Duration(minutes: minutes, seconds: seconds))
    .millisecondsSinceEpoch;

class _PrefsBacking {
  static SharedPreferences? instance;
}

Future<void> goldenSetUpAll() async {
  SharedPreferences.setMockInitialValues({'onboarded.v1': true});
  _PrefsBacking.instance = await SharedPreferences.getInstance();
  await loadRealFonts();
  HttpOverrides.global = _FakeImageHttp();
}

void goldenSetUp({Brightness brightness = Brightness.dark}) {
  TalonDensity.overrideTouch = null;
  TalonTheme.mode.value =
      brightness == Brightness.dark ? ThemeMode.dark : ThemeMode.light;
  TalonTheme.accentSeed.value = null;
  TalonTheme.apply(brightness);
}

AppState seededState({
  required bool narrow,
  required List<ClientChat> chats,
  required Map<String, List<ClientMessage>> messages,
  String? select,
  ConnState conn = ConnState.connected,
}) {
  final state = AppState(Prefs(_PrefsBacking.instance!), narrowLayout: narrow);
  state.debugSeed(
    chats: chats,
    messages: messages,
    select: select,
    connState: conn,
    bridgeStatus: BridgeStatus.fromJson(const {
      'protocol': 1,
      'botName': 'Talon',
      'backend': 'claude',
      'model': 'opus',
      'activeChats': 3,
      'startedAt': '',
      'capabilities': ['mesh', 'mesh-commands', 'plugins-skills'],
    }),
  );
  return state;
}

Widget goldenApp(Widget home) {
  final base = buildTalonTheme();
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: base.copyWith(
      textTheme: base.textTheme.apply(
        fontFamilyFallback: const ['Noto Color Emoji'],
      ),
    ),
    // Freeze ambient/looping animations so frames are deterministic.
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context).copyWith(disableAnimations: true),
      child: child!,
    ),
    home: home,
  );
}

/// Phone viewport. [height] lets a scroll-heavy screen (settings) render
/// top to bottom in one PNG.
void usePhone(WidgetTester tester, {double height = 844}) {
  const dpr = 2.0;
  tester.view.physicalSize = Size(phoneSize.width * dpr, height * dpr);
  tester.view.devicePixelRatio = dpr;
  // Status bar + home indicator, in physical pixels.
  tester.view.padding = const FakeViewPadding(top: 47 * dpr, bottom: 34 * dpr);
  tester.view.viewPadding =
      const FakeViewPadding(top: 47 * dpr, bottom: 34 * dpr);
  TalonDensity.overrideTouch = true;
  addTearDown(tester.view.reset);
}

void useDesktop(WidgetTester tester, {double height = 760}) {
  tester.view.physicalSize = Size(desktopSize.width, height);
  tester.view.devicePixelRatio = 1.0;
  TalonDensity.overrideTouch = false;
  addTearDown(tester.view.reset);
}

/// Settle, capture, then drain AppState's debounced timers.
Future<void> shoot(WidgetTester tester, String name) async {
  // Network images resolve on the real event loop.
  await tester.runAsync(() => Future<void>.delayed(
        const Duration(milliseconds: 150),
      ));
  for (var i = 0; i < 4; i++) {
    await tester.pump(const Duration(milliseconds: 300));
  }
  await tester.runAsync(() => Future<void>.delayed(
        const Duration(milliseconds: 150),
      ));
  await tester.pump(const Duration(milliseconds: 300));
  await expectLater(
    find.byType(MaterialApp),
    matchesGoldenFile('goldens/$name.png'),
  );
  await tester.pump(const Duration(seconds: 3));
}

// ── Fake image server ──────────────────────────────────────────────────────
//
// Every HTTP GET made by NetworkImage returns the bundled app icon, so photo
// attachments render as a real picture rather than a loading/error box.

class _FakeImageHttp extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) => _FakeClient();
}

class _FakeClient implements HttpClient {
  @override
  bool autoUncompress = true;

  @override
  Future<HttpClientRequest> getUrl(Uri url) async => _FakeRequest();

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) async =>
      _FakeRequest();

  @override
  void close({bool force = false}) {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeRequest implements HttpClientRequest {
  @override
  final HttpHeaders headers = _FakeHeaders();

  @override
  Future<HttpClientResponse> close() async => _FakeResponse(
      File('assets/icon/talon_icon.png').readAsBytesSync());

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeHeaders implements HttpHeaders {
  @override
  void add(String name, Object value, {bool preserveHeaderCase = false}) {}

  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) {}

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _FakeResponse extends Stream<List<int>> implements HttpClientResponse {
  final List<int> bytes;
  _FakeResponse(this.bytes);

  @override
  int get statusCode => 200;

  @override
  int get contentLength => bytes.length;

  @override
  HttpClientResponseCompressionState get compressionState =>
      HttpClientResponseCompressionState.notCompressed;

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) =>
      Stream<List<int>>.value(bytes).listen(onData,
          onError: onError, onDone: onDone, cancelOnError: cancelOnError);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
