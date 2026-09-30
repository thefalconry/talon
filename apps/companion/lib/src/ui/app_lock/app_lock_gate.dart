import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import '../../security/app_lock/app_lock_controller.dart';
import '../../security/app_lock/approval_relay.dart';
import '../../services/mesh_background.dart';
import '../../services/secure_window.dart';
import 'lock_screen.dart';

/// Makes the [AppLockController] reachable from anywhere under the app
/// (Settings' App lock card, RootView's pairing-link handler).
class AppLockScope extends InheritedNotifier<AppLockController> {
  const AppLockScope({
    super.key,
    required AppLockController controller,
    required super.child,
  }) : super(notifier: controller);

  /// Subscribes the caller to lock changes. Null when no lock is installed
  /// (tests, or a build without one).
  static AppLockController? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AppLockScope>()?.notifier;

  /// Look up without subscribing — safe from async callbacks.
  static AppLockController? peek(BuildContext context) =>
      context.getInheritedWidgetOfExactType<AppLockScope>()?.notifier;
}

/// Wraps the app's navigator (MaterialApp.builder) with the app lock:
///
///   * while locked, the navigator — every route, dialog and sheet — is
///     offstage with its tickers stopped and focus withdrawn, and the lock
///     screen is the only thing on screen;
///   * a pending device-command approval shows the same surface in approval
///     mode;
///   * while the lock is on, leaving the foreground covers the UI so the
///     app-switcher snapshot shows no content, and Android additionally gets
///     FLAG_SECURE while locked and no recents screenshot at all (API 33+);
///   * the "Block screenshots and screen recording" setting is applied
///     app-wide, live (Android FLAG_SECURE) — the locked state blocks
///     regardless of it;
///   * user input is recorded for the idle timeout (one integer store per
///     event — no per-frame work).
///
/// Nothing here holds back the connection: AppState connects and the mesh
/// runs while the lock screen is up.
class AppLockGate extends StatefulWidget {
  final AppLockController controller;
  final Widget child;

  /// Relay approval requests from the Android background mesh isolate.
  /// Defaults to on where that isolate exists.
  final bool? relayBackgroundApprovals;

  const AppLockGate({
    super.key,
    required this.controller,
    required this.child,
    this.relayBackgroundApprovals,
  });

  @override
  State<AppLockGate> createState() => _AppLockGateState();
}

class _AppLockGateState extends State<AppLockGate> with WidgetsBindingObserver {
  bool _obscured = false;
  bool _secureHeld = false;
  bool? _recentsHidden;
  UiApprovalResponder? _responder;

  AppLockController get _c => widget.controller;

  static bool get _mobile =>
      !kIsWeb && (Platform.isAndroid || Platform.isIOS);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    HardwareKeyboard.instance.addHandler(_onKey);
    _c.addListener(_onLockChanged);
    _syncWindow();
    if (widget.relayBackgroundApprovals ?? MeshForegroundController.isSupported) {
      final responder = UiApprovalResponder(
        _c,
        reply: FlutterForegroundTask.sendDataToTask,
      );
      _responder = responder;
      FlutterForegroundTask.addTaskDataCallback(responder.onTaskData);
    }
  }

  @override
  void dispose() {
    final responder = _responder;
    if (responder != null) {
      FlutterForegroundTask.removeTaskDataCallback(responder.onTaskData);
    }
    _c.removeListener(_onLockChanged);
    HardwareKeyboard.instance.removeHandler(_onKey);
    WidgetsBinding.instance.removeObserver(this);
    if (_secureHeld) SecureWindow.release();
    SecureWindow.setBlockScreenshots(false);
    super.dispose();
  }

  bool _onKey(KeyEvent event) {
    _c.noteActivity();
    return false; // observe only
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _c.onLifecycle(state);
    // Mobile snapshots the app for the switcher as it goes inactive; desktop
    // "inactive" is just an unfocused window, so only cover when hidden.
    final leaving = _mobile
        ? state != AppLifecycleState.resumed
        : state == AppLifecycleState.hidden ||
            state == AppLifecycleState.paused;
    final obscure = _c.enabled && leaving;
    if (obscure != _obscured && mounted) setState(() => _obscured = obscure);
  }

  void _onLockChanged() {
    _syncWindow();
    if (mounted) setState(() {});
  }

  void _syncWindow() {
    final locked = _c.locked;
    if (locked && !_secureHeld) {
      SecureWindow.acquire();
      _secureHeld = true;
    } else if (!locked && _secureHeld) {
      SecureWindow.release();
      _secureHeld = false;
    }
    SecureWindow.setBlockScreenshots(_c.blockScreenshots);
    final hideRecents = _c.enabled;
    if (_recentsHidden != hideRecents) {
      _recentsHidden = hideRecents;
      SecureWindow.setRecentsHidden(hideRecents);
    }
  }

  @override
  Widget build(BuildContext context) {
    final locked = _c.locked;
    final showLock = locked || _c.pendingApproval != null;
    return AppLockScope(
      controller: _c,
      child: Listener(
        behavior: HitTestBehavior.translucent,
        onPointerDown: (_) => _c.noteActivity(),
        child: Stack(
          fit: StackFit.expand,
          children: [
            ExcludeFocus(
              excluding: locked,
              child: TickerMode(
                enabled: !locked,
                child: Offstage(offstage: locked, child: widget.child),
              ),
            ),
            if (showLock) _LockLayer(controller: _c),
            if (_obscured && !showLock) const PrivacyCover(),
          ],
        ),
      ),
    );
  }
}

/// Hosts the lock screen in its own [Overlay]: it sits above the navigator,
/// so it can't borrow the navigator's overlay for text selection handles.
class _LockLayer extends StatefulWidget {
  final AppLockController controller;
  const _LockLayer({required this.controller});

  @override
  State<_LockLayer> createState() => _LockLayerState();
}

class _LockLayerState extends State<_LockLayer> {
  late final OverlayEntry _entry = OverlayEntry(
    builder: (_) => LockScreen(controller: widget.controller),
  );

  @override
  Widget build(BuildContext context) => Overlay(initialEntries: [_entry]);
}
