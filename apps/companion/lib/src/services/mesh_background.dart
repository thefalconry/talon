import 'dart:async';
import 'dart:io' show Platform;

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import '../security/app_lock/approval_relay.dart';
import 'bridge_client.dart';
import 'connection_vault.dart';
import 'endpoint.dart';
import 'log.dart';
import 'mesh_liveness.dart';
import 'mesh_service.dart';
import 'message_notifications.dart';
import 'network_watch.dart';
import 'prefs.dart';

/// Android background mesh: the foreground service owns the ENTIRE mesh loop.
///
/// Historically the foreground service only existed to keep the process alive
/// (its task handler was empty) while the real mesh — the SSE subscription,
/// registration heartbeat, and command handling — ran in the UI isolate. That
/// meant the mesh only worked as long as the activity's Flutter engine lived:
/// swipe the app away (or let the OS reclaim the activity under memory
/// pressure / Doze) and the notification stayed up while teleport, exec,
/// locate, and file transfer silently died.
///
/// Now the roles are inverted. The foreground service's own isolate runs a
/// full [MeshService] with its own [BridgeClient] (SSE + reconnect/backoff),
/// so device commands keep answering with the UI long gone — after a task
/// swipe, a UI engine death, a crash-restart (the plugin's START_STICKY +
/// restart alarm), or a reboot (autoRunOnBoot). The UI isolate no longer runs
/// a mesh loop on Android at all (see AppState) — one isolate, one mesh, no
/// duplicated command execution.
///
/// The UI isolate talks to this isolate with [MeshForegroundController]:
/// start/stop the service to mirror the mesh-sharing pref, and poke
/// [MeshForegroundController.msgReconfigure] through `sendDataToTask` whenever
/// prefs or the connection profile change, so the runner re-reads
/// SharedPreferences (each isolate has its own cache) and reconnects.

/// Entry point executed inside the foreground service's Flutter engine.
@pragma('vm:entry-point')
void startMeshForegroundCallback() {
  FlutterForegroundTask.setTaskHandler(MeshTaskHandler());
}

/// Task handler: delegates to a [MeshBackgroundRunner] for the whole service
/// lifetime. The 90s repeat event doubles as a connection watchdog.
class MeshTaskHandler extends TaskHandler {
  MeshBackgroundRunner? _runner;

  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {
    AppLog.info('mesh_bg', 'foreground mesh starting (${starter.name})');
    // Statics are per isolate: this one reads the bridge token from the
    // same keystore the UI isolate wrote it to (see Prefs.vault).
    Prefs.vault ??= PlatformConnectionVault();
    final runner = MeshBackgroundRunner();
    _runner = runner;
    await runner.start();
  }

  @override
  void onRepeatEvent(DateTime timestamp) {
    _runner?.watchdog();
  }

  @override
  void onReceiveData(Object data) {
    if (data == MeshForegroundController.msgReconfigure) {
      unawaited(_runner?.reconfigure());
      return;
    }
    if (data is Map) _runner?.applyUiState(data);
    // The UI's answer to an app-lock approval request (#1051).
    _runner?.approvals.handle(data);
  }

  @override
  Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {
    AppLog.info('mesh_bg', 'foreground mesh stopping (timeout=$isTimeout)');
    await _runner?.dispose();
    _runner = null;
    if (isTimeout) await MeshForegroundController.noteServiceTimedOut();
  }
}

/// Owns the background isolate's bridge connection and mesh loop:
/// prefs → BridgeClient → MeshService, plus SSE reconnection with backoff
/// (the same duty AppState performs for the UI's own connection).
/// True when an open event stream has been silent longer than [idle]. The
/// daemon pings every 25 s, so a live stream never is; null [lastRx] (no
/// stream opened yet) is not "dead", just not connected.
bool streamLooksDead(DateTime? lastRx, DateTime now, Duration idle) =>
    lastRx != null && now.difference(lastRx) > idle;

/// What the background mesh should stamp as its "last alive" moment after a
/// successful registration: when the event stream last delivered anything,
/// or null (don't stamp) while no stream is up. A registration alone proves
/// only that an HTTP POST got through, not that commands can arrive.
int? meshAliveStamp({
  required DateTime? streamLastRx,
  required bool connected,
  required int nowMs,
}) {
  if (!connected || streamLastRx == null) return null;
  final rx = streamLastRx.millisecondsSinceEpoch;
  return rx > nowMs ? nowMs : rx;
}

class MeshBackgroundRunner {
  Prefs? _prefs;
  BridgeClient? _client;
  MeshService? _mesh;
  StreamSubscription<Map<String, dynamic>>? _drops;
  StreamSubscription<List<ConnectivityResult>>? _networkWatch;
  Timer? _retry;
  bool _connecting = false;
  bool _connected = false;
  bool _disposed = false;
  int _backoffMs = _initialBackoffMs;
  int? _lastRegisteredAtMs;

  /// The last connectivity reading ([networkKey]), so an interface change
  /// can be told from a repeat of the same state.
  String? _lastNetwork;

  static const int _initialBackoffMs = 2000;
  static const int _maxBackoffMs = 60000;

  /// Device-control commands that need an on-device approval (app lock) ask
  /// the UI isolate through this; with no UI in front they are refused.
  final BackgroundCommandApprover approvals = BackgroundCommandApprover(
    send: FlutterForegroundTask.sendDataToMain,
  );

  /// Stream events only a chat UI cares about.
  static const Set<String> _uiOnlyKinds = {
    'delta',
    'reasoning',
    'tool',
    'typing',
    'turn_start',
    'status',
  };

  /// MeshService re-registers every 60 s; the watchdog only registers when
  /// that heartbeat has gone quiet for this long, so there is one
  /// registration a minute instead of redundant heartbeats.
  static const Duration _heartbeatQuiet = Duration(seconds: 75);

  /// UI state pushed over the task channel (see
  /// MeshForegroundController.pushUiState); null until the UI has spoken,
  /// in which case prefs are the fallback.
  bool? _uiForeground;
  bool? _notificationsEnabled;
  bool? _appLockEnabled;

  void applyUiState(Map<dynamic, dynamic> data) {
    final fg = data[MeshForegroundController.keyUiForeground];
    if (fg is bool) _uiForeground = fg;
    final notify = data[MeshForegroundController.keyNotifications];
    if (notify is bool) _notificationsEnabled = notify;
    final lock = data[MeshForegroundController.keyAppLock];
    if (lock is bool) _appLockEnabled = lock;
  }

  Future<void> start() async {
    final prefs = await Prefs.load();
    _prefs = prefs;
    // This isolate never renders a reply, so it skips decoding the token
    // firehose the UI isolate is already decoding (#1060).
    final client = BridgeClient(prefs.connection, skipKinds: _uiOnlyKinds);
    _client = client;
    _mesh = MeshService(
      prefs,
      client,
      onRegistered: _stampAlive,
      approver: (command) => approvals.approve(prefs, command),
    );
    _seedChatTitles(prefs);
    // BridgeClient surfaces stream drops as errors on [events]; the mesh's
    // own subscription only consumes *device command* events, so this one
    // watches errors (reconnect) and the chat events the mesh ignores.
    _drops = client.events.listen(
      _onEvent,
      onError: (Object e) {
        if (_disposed) return;
        _connected = false;
        _scheduleReconnect();
      },
    );
    try {
      if (!connectivityWatchAvailable) throw UnsupportedError('no plugin');
      final connectivity = Connectivity();
      unawaited(_seedNetwork(connectivity));
      _networkWatch = connectivity.onConnectivityChanged.listen(
        (results) {
          if (_disposed) return;
          final key = networkKey(results);
          final changed = _lastNetwork != null && key != _lastNetwork;
          _lastNetwork = key;
          if (results.every((r) => r == ConnectivityResult.none)) return;
          if (_connecting) return;
          if (!_connected || changed) {
            // A stream opened on the old interface is bound to it: after a
            // Wi-Fi ↔ cellular switch it goes half-open and never errors, so
            // reopen it now rather than wait out the idle deadline.
            AppLog.info(
              'mesh_bg',
              _connected
                  ? 'network changed ($key); reconnecting now'
                  : 'network restored; reconnecting now',
            );
            _retry?.cancel();
            _connected = false;
            _backoffMs = _initialBackoffMs;
            unawaited(_connect());
          }
        },
        onError: (Object e) =>
            AppLog.debug('mesh_bg', 'network watch unavailable', e),
      );
    } catch (e) {
      AppLog.debug('mesh_bg', 'network watch setup failed', e);
    }
    await _startMesh();
    await _connect();
  }

  /// Seed [_lastNetwork] so the first real change is recognised as one.
  Future<void> _seedNetwork(Connectivity connectivity) async {
    try {
      _lastNetwork ??= networkKey(await connectivity.checkConnectivity());
    } catch (e) {
      AppLog.debug('mesh_bg', 'connectivity check unavailable', e);
    }
  }

  /// Chat id → title, so a notification can be headed by the conversation's
  /// name instead of an opaque id. Seeded from the UI's offline snapshot and
  /// kept current from the event stream.
  final Map<String, String> _chatTitles = {};

  void _seedChatTitles(Prefs prefs) {
    try {
      final chats = prefs.snapshot?['chats'];
      if (chats is! List) return;
      for (final c in chats) {
        if (c is! Map) continue;
        final id = c['id'];
        final title = c['title'];
        if (id is String && title is String) _chatTitles[id] = title;
      }
    } catch (e) {
      AppLog.warn('mesh_bg', 'chat title seed failed', e);
    }
  }

  /// Chat events ride the *same* SSE stream as device commands (the daemon
  /// broadcasts them to every client, device-claiming or not) but MeshService
  /// only routes `device_command`. Without this handler an assistant reply
  /// arrives on the device with the UI dead and is dropped on the floor.
  void _onEvent(Map<String, dynamic> e) {
    final kind = e['kind'];
    switch (kind) {
      case 'hello':
        final chats = e['chats'];
        if (chats is List) {
          for (final c in chats) {
            if (c is Map && c['id'] is String && c['title'] is String) {
              _chatTitles[c['id'] as String] = c['title'] as String;
            }
          }
        }
        return;
      case 'chat_created':
      case 'chat_updated':
        final chat = e['chat'];
        if (chat is Map && chat['id'] is String && chat['title'] is String) {
          _chatTitles[chat['id'] as String] = chat['title'] as String;
        }
        return;
      case 'chat_deleted':
        final id = e['chatId'];
        if (id is String) _chatTitles.remove(id);
        return;
      case 'message':
        unawaited(_maybeNotify(e));
        return;
      default:
        return;
    }
  }

  /// Notify on the canonical assistant `message` — not on `delta` (a firehose)
  /// and not on `turn_end` (which carries stats, no text). One message event is
  /// emitted per finished assistant reply, which is exactly the granularity a
  /// notification wants.
  Future<void> _maybeNotify(Map<String, dynamic> e) async {
    if (_disposed || !MessageNotifications.supported) return;
    final chatId = e['chatId'];
    final msg = e['message'];
    if (chatId is! String || msg is! Map) return;
    if (msg['role'] != 'assistant') return;
    final text = msg['text'];
    if (text is! String || text.trim().isEmpty) return;

    final prefs = _prefs;
    if (prefs == null) return;
    var enabled = _notificationsEnabled;
    var foreground = _uiForeground;
    if (enabled == null || foreground == null) {
      // The UI hasn't pushed its state to this run of the service yet. Both
      // flags are written by the UI isolate, which has its own
      // SharedPreferences cache — reload or we read a stale snapshot of a
      // setting the user just changed (or a foreground state from minutes
      // ago). Once pushed, no per-message reload (re-parse of the prefs
      // file) is needed at all.
      try {
        await prefs.reload();
      } catch (_) {
        // A failed reload just means slightly stale flags.
      }
      enabled ??= prefs.messageNotifications;
      foreground ??= prefs.uiForeground;
    }
    if (!enabled) return;
    // Don't notify for a reply the user is watching arrive.
    if (foreground) return;

    // With the app lock on, the shade must not become a way around it:
    // say that a reply arrived, not which chat or what it says.
    // Pushed by the UI whenever the lock is turned on or off; this isolate's
    // prefs cache is only reloaded until the UI has spoken, so it could be
    // stale here.
    final redact = _appLockEnabled ?? prefs.appLockEnabled;
    await MessageNotifications.showMessage(
      chatId: chatId,
      title: redact ? 'Talon' : (_chatTitles[chatId] ?? 'Talon'),
      body: redact ? MessageNotifications.lockedBody : text,
    );
  }

  /// (Re)start the mesh loop: registers with the daemon and (re)subscribes to
  /// command events. Registration is plain HTTP — tolerate an unreachable
  /// bridge; MeshService's 60s heartbeat and our reconnect loop both retry.
  Future<void> _startMesh() async {
    try {
      await _mesh?.start();
    } catch (e) {
      AppLog.warn('mesh_bg', 'mesh start failed (will retry)', e);
    }
  }

  /// Open the SSE stream (commands arrive over it) and refresh registration
  /// so the daemon flips this device online immediately.
  Future<void> _connect() async {
    if (_disposed || _connecting) return;
    final prefs = _prefs;
    final client = _client;
    if (prefs == null || client == null || !prefs.meshSharing) return;
    _connecting = true;
    try {
      // The local address when it answers, the main one otherwise — picked
      // afresh on every (re)connect, so a phone leaving home re-routes on
      // its next retry.
      // Re-read the profile: the UI isolate may have swapped the shared
      // token for this device's own credential (or rotated it) since the
      // last connect, and a revoked old token only heals by picking it up.
      try {
        await prefs.reload();
      } catch (_) {
        // Stale cache at worst; the reconfigure poke still delivers it.
      }
      client.config = await resolveEndpoint(prefs.connection);
      await client.connect();
      _connected = true;
      _backoffMs = _initialBackoffMs;
      await _registerHealthy();
      AppLog.info('mesh_bg', 'bridge connected, mesh registered');
    } catch (e) {
      AppLog.warn('mesh_bg', 'bridge connect failed', e);
      _connected = false;
      _scheduleReconnect();
    } finally {
      _connecting = false;
    }
  }

  void _scheduleReconnect() {
    if (_disposed) return;
    _retry?.cancel();
    final delay = _backoffMs;
    _backoffMs =
        (_backoffMs * 1.7).clamp(_initialBackoffMs, _maxBackoffMs).toInt();
    AppLog.info('mesh_bg', 'reconnect in ${delay}ms');
    _retry = Timer(Duration(milliseconds: delay), () => unawaited(_connect()));
  }

  Future<void> _registerHealthy() async {
    await _mesh?.register();
    _lastRegisteredAtMs = DateTime.now().millisecondsSinceEpoch;
    await _stampAlive();
  }

  Future<void> _stampAlive() async {
    final prefs = _prefs;
    if (prefs == null || !prefs.meshSharing) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    // Every successful registration lands here (MeshService's heartbeat
    // included), so the watchdog can tell whether one is due.
    _lastRegisteredAtMs = now;
    // A registration is a fresh HTTP request on its own socket: it succeeds
    // even while the event stream — the socket commands actually arrive on —
    // sits half-open. So "alive" is when the stream last delivered something
    // (a `: ping` every 25 s), not when the POST went through.
    final aliveAt = meshAliveStamp(
      streamLastRx: _client?.lastRx,
      connected: _connected,
      nowMs: now,
    );
    if (aliveAt == null) return;
    // Its own tiny file, not a SharedPreferences write (#1060).
    await MeshLiveness.stamp(prefs, aliveAt);
  }

  /// 90s watchdog (the foreground task's repeat event): keep registration
  /// fresh and reconnect with backoff when either SSE or registration stalls.
  void watchdog() {
    if (_disposed || _connecting) return;
    if (_connected &&
        streamLooksDead(
          _client?.lastRx,
          DateTime.now(),
          BridgeClient.eventStreamIdleTimeout,
        )) {
      // Belt and braces for the client's own idle deadline: a stream that
      // has delivered nothing (not even a ping) for that long is dead.
      AppLog.warn('mesh_bg', 'event stream silent; reconnecting');
      _connected = false;
    }
    if (_connected) {
      unawaited(_watchdogRegister());
      return;
    }
    _retry?.cancel();
    unawaited(_connect());
  }

  Future<void> _watchdogRegister() async {
    final lastBeat = _lastRegisteredAtMs;
    final quiet = lastBeat == null
        ? null
        : DateTime.now().millisecondsSinceEpoch - lastBeat;
    if (quiet != null && quiet < _heartbeatQuiet.inMilliseconds) {
      return; // MeshService's own heartbeat is keeping registration fresh
    }
    try {
      await _registerHealthy();
    } catch (e) {
      AppLog.warn('mesh_bg', 'watchdog registration failed', e);
      _connected = false;
      _scheduleReconnect();
      return;
    }
    final last = _lastRegisteredAtMs;
    if (last == null) return;
    final ageMs = DateTime.now().millisecondsSinceEpoch - last;
    if (ageMs > MeshForegroundController.staleAliveAfter.inMilliseconds) {
      AppLog.warn('mesh_bg', 'registration watchdog stale (${ageMs}ms)');
      _connected = false;
      _scheduleReconnect();
    }
  }

  /// The UI isolate changed mesh prefs or the connection profile. Re-read
  /// SharedPreferences from disk (this isolate has its own stale cache),
  /// apply the (possibly new) endpoint, and restart the loop.
  Future<void> reconfigure() async {
    if (_disposed) return;
    final prefs = _prefs;
    if (prefs == null) return;
    await prefs.reload();
    _client?.config = prefs.connection;
    _retry?.cancel();
    _connected = false;
    _backoffMs = _initialBackoffMs;
    await _startMesh(); // re-advertises capabilities; idles if sharing is off
    await _connect();
  }

  Future<void> dispose() async {
    _disposed = true;
    _retry?.cancel();
    _retry = null;
    await _networkWatch?.cancel();
    _networkWatch = null;
    await _mesh?.stop();
    await _drops?.cancel();
    _client?.dispose();
  }
}

enum MeshForegroundHealthKind { off, unsupported, starting, healthy, stale }

class MeshForegroundHealth {
  final MeshForegroundHealthKind kind;
  final int? aliveAgeMs;
  final int? startedAgeMs;

  const MeshForegroundHealth({
    required this.kind,
    this.aliveAgeMs,
    this.startedAgeMs,
  });

  bool get shouldBounce => kind == MeshForegroundHealthKind.stale;

  String get label {
    switch (kind) {
      case MeshForegroundHealthKind.off:
        return 'background mesh off';
      case MeshForegroundHealthKind.unsupported:
        return 'background service unavailable';
      case MeshForegroundHealthKind.starting:
        return 'background mesh starting';
      case MeshForegroundHealthKind.healthy:
        final age = aliveAgeMs;
        return age == null
            ? 'background mesh healthy'
            : 'background mesh healthy, last alive ${_formatAge(age)} ago';
      case MeshForegroundHealthKind.stale:
        final age = aliveAgeMs;
        return age == null
            ? 'background mesh stale - restarting'
            : 'background mesh stale - last alive ${_formatAge(age)} ago';
    }
  }

  static String _formatAge(int ageMs) {
    final seconds = (ageMs / 1000).round();
    if (seconds < 60) return '${seconds}s';
    final minutes = (seconds / 60).round();
    if (minutes < 60) return '${minutes}m';
    return '${(minutes / 60).round()}h';
  }
}

MeshForegroundHealth evaluateMeshForegroundHealth({
  required bool supported,
  required bool sharingEnabled,
  required bool serviceRunning,
  required int nowMs,
  required int? aliveAtMs,
  required int? startedAtMs,
  Duration staleAfter = MeshForegroundController.staleAliveAfter,
  Duration startGrace = MeshForegroundController.startGrace,
}) {
  if (!supported) {
    return const MeshForegroundHealth(
      kind: MeshForegroundHealthKind.unsupported,
    );
  }
  if (!sharingEnabled || !serviceRunning) {
    return const MeshForegroundHealth(kind: MeshForegroundHealthKind.off);
  }
  final startedAge = startedAtMs == null ? null : nowMs - startedAtMs;
  if (startedAge != null &&
      startedAge >= 0 &&
      startedAge < startGrace.inMilliseconds) {
    return MeshForegroundHealth(
      kind: MeshForegroundHealthKind.starting,
      aliveAgeMs: aliveAtMs == null ? null : nowMs - aliveAtMs,
      startedAgeMs: startedAge,
    );
  }
  if (aliveAtMs == null) {
    return MeshForegroundHealth(
      kind: MeshForegroundHealthKind.stale,
      startedAgeMs: startedAge,
    );
  }
  final aliveAge = nowMs - aliveAtMs;
  if (aliveAge < 0 || aliveAge <= staleAfter.inMilliseconds) {
    return MeshForegroundHealth(
      kind: MeshForegroundHealthKind.healthy,
      aliveAgeMs: aliveAge.clamp(0, staleAfter.inMilliseconds),
      startedAgeMs: startedAge,
    );
  }
  return MeshForegroundHealth(
    kind: MeshForegroundHealthKind.stale,
    aliveAgeMs: aliveAge,
    startedAgeMs: startedAge,
  );
}

/// UI-isolate façade for the Android foreground mesh service. All methods are
/// safe no-ops off Android.
class MeshForegroundController {
  MeshForegroundController._();

  /// Data message poking the task isolate to reload prefs and reconnect.
  static const String msgReconfigure = 'mesh.reconfigure.v1';
  static const Duration staleAliveAfter = Duration(seconds: 120);

  /// Keys of the UI-state map pushed to the task with [pushUiState].
  static const String keyUiForeground = 'ui.foreground';
  static const String keyNotifications = 'ui.messageNotifications';
  static const String keyAppLock = 'ui.appLock';
  static const Duration startGrace = Duration(seconds: 20);

  static bool get isSupported => !kIsWeb && Platform.isAndroid;

  /// macOS/Windows: there is no separate background *service*, but the app
  /// itself is resident — closing the window hides it to the menu bar
  /// (macos/Runner) or system tray (WindowsTray) and the UI-isolate
  /// MeshService keeps running. Health is therefore evaluated against the
  /// in-app mesh, not reported "unavailable".
  static bool get isResidentDesktop =>
      !kIsWeb && (Platform.isMacOS || Platform.isWindows);

  /// Mirror the mesh-sharing pref: service running iff sharing is on. When
  /// already running, forwards a reconfigure poke instead so the runner picks
  /// up pref/connection changes without a service bounce.
  static Future<bool> syncFromPrefs(Prefs prefs) async {
    if (!isSupported) return false;
    await prefs.reload();
    if (!prefs.meshSharing) {
      await stop();
      return false;
    }
    if (await FlutterForegroundTask.isRunningService) {
      final health = evaluateMeshForegroundHealth(
        supported: true,
        sharingEnabled: prefs.meshSharing,
        serviceRunning: true,
        nowMs: DateTime.now().millisecondsSinceEpoch,
        aliveAtMs: await MeshLiveness.read(prefs),
        startedAtMs: prefs.meshBgStartedAt,
      );
      if (health.shouldBounce) {
        AppLog.warn('mesh_bg', '${health.label}; bouncing service');
        final stopped = await _stopRunning();
        if (!stopped) return false;
        return _start();
      }
      notifyReconfigure();
      return true;
    }
    return _start();
  }

  static Future<bool> _start() async {
    final notificationPermission =
        await FlutterForegroundTask.checkNotificationPermission();
    if (notificationPermission != NotificationPermission.granted) {
      await FlutterForegroundTask.requestNotificationPermission();
    }
    // Doze/App-Standby aggressively defer network for "optimized" apps —
    // exactly the state where a mesh command would time out. Ask once for
    // the exemption; the system remembers the answer.
    if (!await FlutterForegroundTask.isIgnoringBatteryOptimizations) {
      await FlutterForegroundTask.requestIgnoreBatteryOptimization();
    }
    FlutterForegroundTask.init(
      androidNotificationOptions: AndroidNotificationOptions(
        channelId: 'talon_mesh',
        channelName: 'Talon mesh',
        channelDescription:
            'Keeps the Talon mesh connected for locate, teleport, and '
            'file transfer.',
        channelImportance: NotificationChannelImportance.LOW,
        priority: NotificationPriority.LOW,
        onlyAlertOnce: true,
      ),
      iosNotificationOptions: const IOSNotificationOptions(),
      foregroundTaskOptions: ForegroundTaskOptions(
        // Drives MeshTaskHandler.onRepeatEvent — the connection watchdog.
        eventAction: ForegroundTaskEventAction.repeat(90000),
        autoRunOnBoot: true,
        autoRunOnMyPackageReplaced: true,
        // No lifetime wake/Wi-Fi locks (#1060): they kept the SoC and radio
        // awake 24/7 while mesh sharing was on. An open socket in a
        // foreground service still wakes the CPU for incoming frames;
        // commands take short, timed locks while they run (CommandWakeLock).
        allowWakeLock: false,
        allowWifiLock: false,
      ),
    );
    final prefs = await Prefs.load();
    await prefs.setMeshBgStartedAt(DateTime.now().millisecondsSinceEpoch);
    final result = await FlutterForegroundTask.startService(
      // dataSync: the long-lived SSE stream + exec/file-transfer traffic.
      // location: on-demand locate fixes while backgrounded.
      serviceTypes: const [
        ForegroundServiceTypes.dataSync,
        ForegroundServiceTypes.location,
      ],
      notificationTitle: 'Talon mesh active',
      notificationText: 'Connected for locate, teleport, and file transfer.',
      callback: startMeshForegroundCallback,
    );
    switch (result) {
      case ServiceRequestSuccess():
        // Running again: any "paused by Android" notice is now stale.
        unawaited(
          MessageNotifications.clearNotice(MessageNotifications.meshPausedId),
        );
        return true;
      case ServiceRequestFailure(:final error):
        AppLog.warn('mesh_bg', 'foreground service start failed', error);
        return false;
    }
  }

  /// Android 15+ caps a `dataSync` foreground service at 6 hours per 24 and
  /// then stops it (Service.onTimeout; the plugin stops the service and
  /// reports `isTimeout`). It may not be restarted from the background until
  /// the app next comes to the foreground — where [syncFromPrefs] restarts
  /// it on the next connect. Until then the mesh is down, so say so rather
  /// than leave a silently dead device: one notice, tapping it opens the app
  /// (which restarts the service and withdraws the notice).
  static Future<void> noteServiceTimedOut() async {
    AppLog.warn(
      'mesh_bg',
      'Android stopped the mesh service at its background time limit; '
          'it resumes when Talon is next opened',
    );
    await MessageNotifications.showNotice(
      id: MessageNotifications.meshPausedId,
      title: 'Talon mesh paused',
      body: "Android paused Talon's background connection after its daily "
          'time limit. Open Talon to reconnect this device.',
    );
  }

  static Future<bool> stop() async {
    if (!isSupported) return false;
    if (await FlutterForegroundTask.isRunningService) {
      return _stopRunning();
    }
    return true;
  }

  static Future<bool> _stopRunning() async {
    final result = await FlutterForegroundTask.stopService();
    switch (result) {
      case ServiceRequestSuccess():
        return true;
      case ServiceRequestFailure(:final error):
        AppLog.warn('mesh_bg', 'foreground service stop failed', error);
        return false;
    }
  }

  /// [residentMeshRunning] only matters on resident-desktop platforms
  /// (macOS): whether the UI isolate's MeshService is currently running.
  static Future<MeshForegroundHealth> healthFromPrefs(
    Prefs prefs, {
    bool residentMeshRunning = false,
  }) async {
    if (isResidentDesktop) {
      await prefs.reload();
      return evaluateMeshForegroundHealth(
        supported: true,
        sharingEnabled: prefs.meshSharing,
        serviceRunning: residentMeshRunning,
        nowMs: DateTime.now().millisecondsSinceEpoch,
        aliveAtMs: await MeshLiveness.read(prefs),
        startedAtMs: prefs.meshBgStartedAt,
      );
    }
    if (!isSupported) {
      return evaluateMeshForegroundHealth(
        supported: false,
        sharingEnabled: prefs.meshSharing,
        serviceRunning: false,
        nowMs: DateTime.now().millisecondsSinceEpoch,
        aliveAtMs: null,
        startedAtMs: null,
      );
    }
    await prefs.reload();
    final running = await FlutterForegroundTask.isRunningService;
    return evaluateMeshForegroundHealth(
      supported: true,
      sharingEnabled: prefs.meshSharing,
      serviceRunning: running,
      nowMs: DateTime.now().millisecondsSinceEpoch,
      aliveAtMs: await MeshLiveness.read(prefs),
      startedAtMs: prefs.meshBgStartedAt,
    );
  }

  /// Tell the running service whether the UI is in front and whether reply
  /// notifications are on, so it never has to reload prefs per message.
  /// Fire-and-forget; harmless when the service isn't up.
  static void pushUiState({
    bool? uiForeground,
    bool? messageNotifications,
    bool? appLockEnabled,
  }) {
    if (!isSupported) return;
    try {
      FlutterForegroundTask.sendDataToTask({
        if (uiForeground != null) keyUiForeground: uiForeground,
        if (messageNotifications != null)
          keyNotifications: messageNotifications,
        if (appLockEnabled != null) keyAppLock: appLockEnabled,
      });
    } catch (e) {
      AppLog.warn('mesh_bg', 'ui state push failed', e);
    }
  }

  /// Fire-and-forget poke; the runner re-reads prefs and reconnects. Silently
  /// harmless when the service isn't up (nothing is listening).
  static void notifyReconfigure() {
    if (!isSupported) return;
    try {
      FlutterForegroundTask.sendDataToTask(msgReconfigure);
    } catch (e) {
      AppLog.warn('mesh_bg', 'reconfigure poke failed', e);
    }
  }
}
