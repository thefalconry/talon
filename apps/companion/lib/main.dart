import 'dart:async';
import 'dart:io' show ProcessSignal, exit;
import 'dart:ui' show AppExitResponse;

import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import 'src/security/app_lock/app_lock_controller.dart';
import 'src/services/bridge_trust.dart';
import 'src/services/connection_vault.dart';
import 'src/services/dynamic_accent.dart';
import 'src/services/haptics.dart';
import 'src/services/linux_theme.dart';
import 'src/services/log.dart';
import 'src/services/mesh_background.dart';
import 'src/services/message_notifications.dart';
import 'src/services/prefs.dart';
import 'src/services/private_store.dart';
import 'src/services/voice.dart';
import 'src/services/windows_tray.dart';
import 'src/state/app_state.dart';
import 'src/theme.dart';
import 'src/ui/app_lock/app_lock_gate.dart';
import 'src/ui/effects.dart';
import 'src/ui/image_bounds.dart';
import 'src/ui/root_view.dart';
import 'src/ui/voice_mode_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Desktop windows live for days (close hides to the tray): keep the decoded
  // image cache on a tighter budget than Flutter's 100 MB default.
  const desktop = {
    TargetPlatform.windows,
    TargetPlatform.linux,
    TargetPlatform.macOS,
  };
  if (desktop.contains(defaultTargetPlatform)) {
    PaintingBinding.instance.imageCache.maximumSizeBytes =
        kDesktopImageCacheBytes;
  }
  // Certificate pinning for every implicitly-created HttpClient
  // (Image.network) — BridgeClient carries its own pinned client.
  BridgeTrust.install();
  // UI ↔ foreground-service isolate messaging (mesh reconfigure pokes).
  if (MeshForegroundController.isSupported) {
    FlutterForegroundTask.initCommunicationPort();
  }
  // Windows: tray residency — close hides to the system tray, mesh keeps
  // running (macOS gets the same from native code in macos/Runner).
  await WindowsTray.instance.init();
  // The bridge token and client certificate live in the OS keystore; the
  // first load after an update moves them out of the settings file.
  Prefs.vault = PlatformConnectionVault();
  final prefs = await Prefs.load(fileSnapshot: true);
  // Linux: the settings file holds the bridge token when no Secret Service
  // is running (the keystore fallback), and the chat snapshot
  // file recent chats; keep them (and their directory) readable by this
  // user only.
  final privateStore = PrivateStore();
  Prefs.privateStore = privateStore;
  unawaited(privateStore.harden());
  TalonTheme.mode.value = switch (prefs.themeMode) {
    'light' => ThemeMode.light,
    'dark' => ThemeMode.dark,
    _ => ThemeMode.system,
  };
  final seed = prefs.accentSeed;
  TalonTheme.accentSeed.value = seed == null ? null : Color(seed);
  TalonTheme.textScale.value = prefs.textScale;
  Haptics.enabled = prefs.haptics;
  TalonEffects.reduce.value = prefs.reduceEffects;
  if (defaultTargetPlatform == TargetPlatform.linux) {
    LinuxThemeService.initSync();
  }
  TalonTheme.apply(
    LinuxThemeService.currentBrightness ??
        WidgetsBinding.instance.platformDispatcher.platformBrightness,
  );
  TalonTheme.syncSystemChrome();
  // App lock (#1051). Built before AppState so the sealed-snapshot sink is in
  // place before anything saves; its record loads in the background — the
  // prefs mirror already tells the first frame whether to cover the UI, and
  // the connection never waits for it.
  final appLock = AppLockController.platform(prefs);
  final state = AppState(prefs);
  appLock.onSnapshotUnsealed = state.restoreSnapshot;
  appLock.onWipe = state.forgetConnection;
  state.commandApprover = appLock.approveCommand;
  unawaited(appLock.load());
  runApp(TalonApp(state: state, appLock: appLock));
}

class TalonApp extends StatefulWidget {
  final AppState state;

  /// The optional app lock; null in tests that don't exercise it.
  final AppLockController? appLock;
  const TalonApp({super.key, required this.state, this.appLock});

  @override
  State<TalonApp> createState() => _TalonAppState();
}

class _TalonAppState extends State<TalonApp> with WidgetsBindingObserver {
  /// Root navigator — the assist-gesture handler pushes voice mode through
  /// it without needing a BuildContext below the MaterialApp.
  final _navigatorKey = GlobalKey<NavigatorState>();
  StreamSubscription<void>? _assistSub;

  /// The app-lock state last handed to the background isolate.
  bool? _pushedAppLock;

  StreamSubscription<ProcessSignal>? _sigtermSub;
  StreamSubscription<ProcessSignal>? _sighupSub;
  StreamSubscription<ProcessSignal>? _sigintSub;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (!kIsWeb &&
        (defaultTargetPlatform == TargetPlatform.linux ||
            defaultTargetPlatform == TargetPlatform.macOS)) {
      _setupTerminationSignals();
    }
    // The background isolate redacts reply notifications while the lock is
    // on; tell it as soon as the lock is turned on or off.
    widget.appLock?.addListener(_onAppLockChanged);
    // Decorative motion (ambient backdrop, pulses) only runs while the app is
    // resumed and someone is using it — see TalonEffects.
    TalonEffects.setLifecycle(WidgetsBinding.instance.lifecycleState);
    HardwareKeyboard.instance.addHandler(_onKey);
    // The background mesh isolate reads this flag to decide whether a reply
    // needs a notification. We are on screen right now by definition.
    unawaited(widget.state.prefs.setUiForeground(true));
    _pushUiState(foreground: true);
    unawaited(
      MessageNotifications.ensureInitialized(onSelect: _openChatFromTap),
    );
    // Theme-mode / accent changes (Settings) re-resolve the palette and
    // rebuild; text-scale changes rebuild to re-apply the root TextScaler.
    TalonTheme.mode.addListener(_onThemeChanged);
    TalonTheme.accentSeed.addListener(_onThemeChanged);
    TalonTheme.textScale.addListener(_onThemeChanged);
    // Connect on launch using the saved profile (or platform default), and
    // let the updater notice a new release in the background — it only ever
    // reads the release feed here; downloading and installing stay a tap in
    // Settings.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!widget.state.prefs.onboarded) return;
      widget.state.start();
      unawaited(widget.state.updates.start());
    });
    // Material You: the wallpaper palette can change while the app is away,
    // so re-read it now and on every resume.
    WidgetsBinding.instance
        .addPostFrameCallback((_) => _refreshDynamicAccent());
    if (defaultTargetPlatform == TargetPlatform.linux) {
      LinuxThemeService.startMonitoring(onChanged: () {
        if (!mounted) return;
        _onThemeChanged();
        unawaited(_refreshDynamicAccent());
      });
    }
    if (VoiceService.supported) {
      // Warm assist launches (gesture while the app runs) arrive as events;
      // a cold start straight from the gesture leaves a flag to consume once
      // the first frame is up.
      _assistSub =
          VoiceService.instance.onAssistLaunch.listen((_) => _openVoiceMode());
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        if (await VoiceService.instance.consumeAssistLaunch()) {
          _openVoiceMode();
        }
      });
    }
  }

  void _setupTerminationSignals() {
    void onSignal(ProcessSignal signal) async {
      AppLog.info('lifecycle',
          'Received ${signal.name}, flushing snapshot and terminating cleanly');
      try {
        if (defaultTargetPlatform == TargetPlatform.linux) {
          LinuxThemeService.stopMonitoring();
        }
        await widget.state
            .flushSnapshot()
            .timeout(const Duration(milliseconds: 1500));
      } catch (e) {
        AppLog.warn('lifecycle', 'error during clean exit flush', e);
      } finally {
        exit(0);
      }
    }

    try {
      _sigtermSub = ProcessSignal.sigterm.watch().listen(onSignal);
    } catch (e) {
      AppLog.warn('lifecycle', 'failed to watch SIGTERM', e);
    }
    try {
      _sighupSub = ProcessSignal.sighup.watch().listen(onSignal);
    } catch (e) {
      AppLog.warn('lifecycle', 'failed to watch SIGHUP', e);
    }
    try {
      _sigintSub = ProcessSignal.sigint.watch().listen(onSignal);
    } catch (e) {
      AppLog.warn('lifecycle', 'failed to watch SIGINT', e);
    }
  }

  @override
  Future<AppExitResponse> didRequestAppExit() async {
    AppLog.info('lifecycle', 'System requested application exit');
    try {
      if (defaultTargetPlatform == TargetPlatform.linux) {
        LinuxThemeService.stopMonitoring();
      }
      await widget.state
          .flushSnapshot()
          .timeout(const Duration(milliseconds: 1500));
    } catch (_) {}
    return AppExitResponse.exit;
  }

  /// Jump into full-screen voice mode (assist gesture). Ensures a chat is
  /// selected first so AppShell settles its conversation route BENEATH the
  /// voice screen, then pushes the orb on top.
  Future<void> _openVoiceMode() async {
    final state = widget.state;
    if (!state.prefs.onboarded) return;
    if (VoiceModeScreen.open.value) return; // already in a session
    // The assist gesture must not open a live microphone behind the lock.
    final lock = widget.appLock;
    if (lock != null) {
      await lock.whenUnlocked();
      if (!mounted) return;
    }
    // Clear the native pending flag so this launch is handled exactly once.
    await VoiceService.instance.consumeAssistLaunch();
    if (state.selectedChatId == null && state.chats.isNotEmpty) {
      await state.selectChat(state.chats.first.id);
      // Let AppShell's post-frame route sync push the conversation first.
      await Future<void>.delayed(const Duration(milliseconds: 80));
    }
    if (!mounted || VoiceModeScreen.open.value) return;
    _navigatorKey.currentState?.push(VoiceModeScreen.route(state));
  }

  /// Tapped a message notification: open that conversation.
  Future<void> _openChatFromTap(String chatId) async {
    final state = widget.state;
    if (!state.prefs.onboarded) return;
    await state.selectChat(chatId);
    await MessageNotifications.clearChat(chatId);
  }

  /// Resume mirrors foreground state into prefs for the background isolate
  /// (which shares no memory with us and would otherwise notify for replies
  /// the user is watching stream in), reopens an event stream that went
  /// quiet while we were away, and re-reads the platform accent in case the
  /// wallpaper changed meanwhile.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Desktop reports `inactive` for an unfocused window and `hidden` for a
    // minimised/tray-hidden one: both stop the decorative animations.
    TalonEffects.setLifecycle(state);
    final foreground = state == AppLifecycleState.resumed;
    // Leaving the foreground is the moment to persist the offline snapshot
    // (it's no longer written on a timer during activity).
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      widget.state.persistSnapshot();
      if (!kIsWeb &&
          defaultTargetPlatform == TargetPlatform.android &&
          MeshForegroundController.isSupported &&
          widget.state.prefs.meshSharing) {
        widget.state.pauseUiStream();
      }
    }
    unawaited(widget.state.prefs.setUiForeground(foreground));
    _pushUiState(foreground: foreground);
    if (foreground) {
      if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
        widget.state.resumeUiStream();
      }
      // A stream that stayed "connected" while the app was frozen (laptop
      // lid, iOS suspension, a network switch meanwhile) may be half-open:
      // if it has been quiet past a keep-alive or two, reopen it now.
      widget.state.reconnectIfStale();
      final chatId = widget.state.selectedChatId;
      // Anything waiting in the shade for the chat now on screen is read.
      if (chatId != null) unawaited(MessageNotifications.clearChat(chatId));
      if (defaultTargetPlatform == TargetPlatform.linux) {
        unawaited(LinuxThemeService.refresh());
      }
      unawaited(_refreshDynamicAccent());
    }
  }

  /// Hand the background mesh service the two flags it checks before
  /// posting a reply notification, so it doesn't reload (re-parse) the whole
  /// prefs store for every assistant message (#1060). Prefs stay the
  /// fallback for a service that starts before the UI has spoken.
  void _pushUiState({required bool foreground}) {
    final lock = widget.state.prefs.appLockEnabled;
    _pushedAppLock = lock;
    MeshForegroundController.pushUiState(
      uiForeground: foreground,
      messageNotifications: widget.state.prefs.messageNotifications,
      appLockEnabled: lock,
    );
  }

  void _onAppLockChanged() {
    final lock = widget.state.prefs.appLockEnabled;
    if (lock == _pushedAppLock) return;
    _pushedAppLock = lock;
    MeshForegroundController.pushUiState(appLockEnabled: lock);
  }

  /// Pull the platform accent into the palette while "Wallpaper" is the
  /// selected accent. A wallpaper change happens outside the app, so resume is
  /// the honest moment to notice it. The resolved colour is persisted as the
  /// seed too, so the next cold start is already correct before this async
  /// read returns.
  Future<void> _refreshDynamicAccent() async {
    if (!widget.state.prefs.accentDynamic) return;
    final seed = await DynamicAccent.seed();
    if (seed == null || !mounted) return;
    if (TalonTheme.accentSeed.value?.toARGB32() == seed.toARGB32()) return;
    TalonTheme.accentSeed.value = seed; // listener re-applies the palette
    await widget.state.prefs.setAccentSeed(seed.toARGB32());
  }

  /// Typing counts as activity for the idle check. Never consumes the event.
  bool _onKey(KeyEvent event) {
    TalonEffects.markActivity();
    return false;
  }

  /// The OS flipped light/dark — matters in auto mode.
  @override
  void didChangePlatformBrightness() => _onThemeChanged();

  void _onThemeChanged() {
    setState(() {
      TalonTheme.apply(
        LinuxThemeService.currentBrightness ??
            WidgetsBinding.instance.platformDispatcher.platformBrightness,
      );
    });
    TalonTheme.syncSystemChrome();
  }

  @override
  void dispose() {
    if (defaultTargetPlatform == TargetPlatform.linux) {
      LinuxThemeService.stopMonitoring();
    }
    _sigtermSub?.cancel();
    _sighupSub?.cancel();
    _sigintSub?.cancel();
    _assistSub?.cancel();
    widget.appLock?.removeListener(_onAppLockChanged);
    HardwareKeyboard.instance.removeHandler(_onKey);
    TalonTheme.mode.removeListener(_onThemeChanged);
    TalonTheme.accentSeed.removeListener(_onThemeChanged);
    TalonTheme.textScale.removeListener(_onThemeChanged);
    WidgetsBinding.instance.removeObserver(this);
    widget.state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Talon',
      navigatorKey: _navigatorKey,
      debugShowCheckedModeBanner: false,
      theme: buildTalonTheme(),
      // Apply the user's text-size preference on top of whatever scaling the
      // OS already requests, for every route in one place.
      builder: (context, child) {
        final mq = MediaQuery.of(context);
        final osFactor = mq.textScaler.scale(1.0);
        final navigator = child ?? const SizedBox.shrink();
        final lock = widget.appLock;
        return ActivityListener(
          child: MediaQuery(
            data: mq.copyWith(
              textScaler:
                  TextScaler.linear(osFactor * TalonTheme.textScale.value),
            ),
            // Above the navigator, so no route or dialog can sit over the
            // lock.
            child: lock == null
                ? navigator
                : AppLockGate(controller: lock, child: navigator),
          ),
        );
      },
      home: RootView(state: widget.state),
    );
  }
}
