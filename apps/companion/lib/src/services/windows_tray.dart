import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

import 'log.dart';

/// Windows system tray residency.
///
/// Parity with the macOS menu bar item (macos/Runner): closing the window
/// hides it to the tray instead of exiting, so the UI-isolate MeshService
/// keeps answering locate/exec/teleport/file-transfer with the window gone.
/// The tray menu mirrors the macOS status item: a live status row, Open
/// Talon, and Quit Talon. Left-click on the tray icon reopens the window.
///
/// macOS uses native AppKit for this (no plugin needed there); this class is
/// a no-op everywhere but Windows.
class WindowsTray with TrayListener, WindowListener {
  WindowsTray._();

  static final WindowsTray instance = WindowsTray._();

  static bool get isSupported => !kIsWeb && Platform.isWindows;

  bool _initialized = false;
  String _status = 'Starting…';

  /// Must run after WidgetsFlutterBinding.ensureInitialized() and before
  /// runApp (window_manager requirement).
  Future<void> init() async {
    if (!isSupported || _initialized) return;
    _initialized = true;
    try {
      await windowManager.ensureInitialized();
      // Intercept close so onWindowClose can hide instead of exit.
      await windowManager.setPreventClose(true);
      windowManager.addListener(this);

      trayManager.addListener(this);
      await trayManager.setIcon('assets/icon/talon_icon.ico');
      await _syncTray();
    } catch (e) {
      AppLog.warn('windows_tray', 'tray init failed', e);
    }
  }

  /// Update the live status row ("Connected · mesh active"). Deduplicated.
  Future<void> setStatus(String text) async {
    if (!_initialized || text == _status) return;
    _status = text;
    try {
      await _syncTray();
    } catch (e) {
      AppLog.warn('windows_tray', 'tray status update failed', e);
    }
  }

  Future<void> _syncTray() async {
    await trayManager.setToolTip('Talon — $_status');
    await trayManager.setContextMenu(
      Menu(
        items: [
          MenuItem(key: 'status', label: _status, disabled: true),
          MenuItem.separator(),
          MenuItem(key: 'open', label: 'Open Talon'),
          MenuItem.separator(),
          MenuItem(key: 'quit', label: 'Quit Talon'),
        ],
      ),
    );
  }

  Future<void> _showWindow() async {
    await windowManager.show();
    await windowManager.focus();
  }

  // ── TrayListener ──────────────────────────────────────────────────────────

  @override
  void onTrayIconMouseDown() {
    _showWindow();
  }

  @override
  void onTrayIconRightMouseDown() {
    trayManager.popUpContextMenu();
  }

  @override
  void onTrayMenuItemClick(MenuItem menuItem) {
    switch (menuItem.key) {
      case 'open':
        _showWindow();
      case 'quit':
        _quit();
    }
  }

  /// Tear down tray and window manager cleanly before process exit.
  Future<void> destroy() => _quit();

  Future<void> _quit() async {
    try {
      await trayManager.destroy();
      await windowManager.setPreventClose(false);
    } catch (e) {
      AppLog.warn('windows_tray', 'quit teardown failed', e);
    }
    await windowManager.destroy();
  }

  // ── WindowListener ────────────────────────────────────────────────────────

  @override
  void onWindowClose() async {
    // Red X / Alt-F4: hide to the tray; the app (and mesh) keep running.
    // Quit for real via the tray menu.
    try {
      if (await windowManager.isPreventClose()) {
        await windowManager.hide();
      }
    } catch (e) {
      AppLog.warn('windows_tray', 'hide on close failed', e);
    }
  }
}
