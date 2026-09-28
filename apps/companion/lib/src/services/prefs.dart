import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

import '../models/connection.dart';
import 'log.dart';
import 'private_store.dart';

/// Thin wrapper over [SharedPreferences] for everything we persist locally:
/// the connection profile, per-chat read markers (unread badges), and a
/// bounded chat/message snapshot for instant offline cold-start.
class Prefs {
  static const _kConnection = 'connection.v1';
  static const _kOnboarded = 'onboarded.v1';
  static const _kLastRead = 'lastRead.v1';
  static const _kSnapshot = 'snapshot.v1';
  static const _kMeshDeviceId = 'mesh.deviceId.v1';
  static const _kMeshSharing = 'mesh.sharing.v1';
  static const _kMeshPeriodic = 'mesh.periodic.v1';
  static const _kMeshInterval = 'mesh.intervalSeconds.v1';
  static const _kMeshDeviceControl = 'mesh.deviceControl.v1';
  static const _kMeshElevated = 'mesh.elevated.v1';
  static const _kMeshControlBridge = 'mesh.controlBridge.v1';
  static const _kMeshGrantsMigrated = 'mesh.grantsMigrated.v1';
  static const _kMeshBgAliveAt = 'mesh.bg.alive_at.v1';
  static const _kMeshBgStartedAt = 'mesh.bg.started_at.v1';

  final SharedPreferences _sp;
  late final Map<String, int> _lastRead = _decodeLastRead();

  /// Where the offline snapshot lives, or null to keep it in
  /// SharedPreferences (no app-support directory, e.g. unit tests).
  final File? _snapshotFile;

  Prefs(this._sp, {File? snapshotFile}) : _snapshotFile = snapshotFile;

  /// [fileSnapshot]: keep the offline snapshot in its own file (the app
  /// and the background mesh isolate). Opt-in so that code which only needs
  /// settings — and widget tests, where a platform-channel reply never
  /// arrives inside fake async — never waits on path_provider.
  static Future<Prefs> load({bool fileSnapshot = false}) async {
    final prefs = Prefs(
      await SharedPreferences.getInstance(),
      snapshotFile: fileSnapshot ? await _resolveSnapshotFile() : null,
    );
    await prefs._migrateMeshGrants();
    if (prefs.meshDeviceId == null || prefs.meshDeviceId!.isEmpty) {
      await prefs.setMeshDeviceId(const Uuid().v4());
    }
    return prefs;
  }

  static Future<File?> _resolveSnapshotFile() async {
    try {
      final dir = await getApplicationSupportDirectory();
      return File(
        '${dir.path}${Platform.pathSeparator}${PrivateStore.snapshotFileName}',
      );
    } catch (_) {
      return null; // no platform implementation (tests) — prefs fallback
    }
  }

  /// Device control used to default to on, for every bridge. It is now an
  /// explicit, per-bridge grant (see [meshDeviceControl]); an install that
  /// was already set up keeps what it had — bound to the bridge it is
  /// connected to today — while a fresh install starts with it off.
  /// Idempotent, so the UI and background isolates can both run it.
  Future<void> _migrateMeshGrants() async {
    if (_sp.getBool(_kMeshGrantsMigrated) ?? false) return;
    if (onboarded) {
      final legacy = _sp.getBool(_kMeshDeviceControl) ?? true;
      await _sp.setBool(_kMeshDeviceControl, legacy);
      // Before this, device control always climbed to root/Shizuku when it
      // could; keep that for the bridge that already had it.
      await _sp.setBool(_kMeshElevated, legacy);
      if (legacy) {
        await _sp.setString(_kMeshControlBridge, connection.bridgeKey);
      }
    }
    await _sp.setBool(_kMeshGrantsMigrated, true);
  }

  /// Re-read the backing store from disk. SharedPreferences caches per
  /// isolate, so the background mesh isolate must reload after the UI isolate
  /// writes (mesh toggles, a new connection profile) to observe the change.
  Future<void> reload() => _sp.reload();

  ConnectionConfig get connection {
    final raw = _sp.getString(_kConnection);
    if (raw == null) return ConnectionConfig.defaults();
    try {
      return ConnectionConfig.fromJson(
        (jsonDecode(raw) as Map).cast<String, dynamic>(),
      );
    } catch (_) {
      return ConnectionConfig.defaults();
    }
  }

  Future<void> setConnection(ConnectionConfig c) async {
    await _sp.setString(_kConnection, jsonEncode(c.toJson()));
    // The profile carries the bridge token: make sure the file it lands in
    // is this user's alone (a first write may have just created it).
    await privateStore?.harden();
  }

  /// Restricts the on-disk settings store to the current OS user (Linux).
  /// Set once by the UI isolate at startup; null in tests and on platforms
  /// where the store already has per-user permissions.
  static PrivateStore? privateStore;

  bool get onboarded => _sp.getBool(_kOnboarded) ?? false;
  Future<void> setOnboarded(bool v) => _sp.setBool(_kOnboarded, v);

  // ── Appearance ────────────────────────────────────────────────────────────

  static const _kThemeMode = 'themeMode.v1';
  static const _kAccentSeed = 'accentSeed.v1';
  static const _kAccentDynamic = 'accentDynamic.v1';
  static const _kTextScale = 'textScale.v1';
  static const _kHaptics = 'haptics.v1';
  static const _kReduceEffects = 'reduceEffects.v1';

  /// Persisted theme selection: 'system' (default), 'light', or 'dark'.
  String get themeMode => _sp.getString(_kThemeMode) ?? 'system';
  Future<void> setThemeMode(String v) => _sp.setString(_kThemeMode, v);

  /// Custom accent seed as ARGB, or null for the default Talon indigo.
  int? get accentSeed => _sp.getInt(_kAccentSeed);
  Future<void> setAccentSeed(int? argb) => argb == null
      ? _sp.remove(_kAccentSeed).then((_) {})
      : _sp.setInt(_kAccentSeed, argb);

  /// Follow the platform's own colour (Android 12+ wallpaper palette, or the
  /// desktop accent colour) instead of a fixed seed. The resolved colour is
  /// still written to [accentSeed] so a cold start paints the right accent
  /// before the async system read lands. Default off.
  bool get accentDynamic => _sp.getBool(_kAccentDynamic) ?? false;
  Future<void> setAccentDynamic(bool v) => _sp.setBool(_kAccentDynamic, v);

  /// Global UI text scale (0.85–1.3, default 1.0).
  double get textScale => (_sp.getDouble(_kTextScale) ?? 1.0).clamp(0.85, 1.3);
  Future<void> setTextScale(double v) =>
      _sp.setDouble(_kTextScale, v.clamp(0.85, 1.3));

  /// "Reduce effects": a static backdrop and no live blur. Unset means the
  /// platform default — on for Windows and Linux, where continuous blur over
  /// an animated backdrop costs the most (#1058), off elsewhere.
  bool get reduceEffects =>
      _sp.getBool(_kReduceEffects) ??
      (defaultTargetPlatform == TargetPlatform.windows ||
          defaultTargetPlatform == TargetPlatform.linux);
  Future<void> setReduceEffects(bool v) => _sp.setBool(_kReduceEffects, v);

  /// UI haptic feedback (mobile). Default on.
  bool get haptics => _sp.getBool(_kHaptics) ?? true;
  Future<void> setHaptics(bool v) => _sp.setBool(_kHaptics, v);

  // ── Updates ───────────────────────────────────────────────────────────────

  static const _kUpdateAuto = 'update.autoCheck.v1';
  static const _kUpdateLastCheck = 'update.lastCheckAt.v1';
  static const _kUpdateSkipped = 'update.skippedVersion.v1';

  /// Look for a newer release on launch and every few hours. Default on —
  /// checking is a ~2 KB request; nothing is downloaded without a tap.
  bool get autoUpdateCheck => _sp.getBool(_kUpdateAuto) ?? true;
  Future<void> setAutoUpdateCheck(bool v) => _sp.setBool(_kUpdateAuto, v);

  /// When the release feed was last read, so a relaunch doesn't re-check.
  DateTime? get updateLastCheckedAt {
    final ms = _sp.getInt(_kUpdateLastCheck);
    return ms == null ? null : DateTime.fromMillisecondsSinceEpoch(ms);
  }

  Future<void> setUpdateLastCheckedAt(DateTime t) =>
      _sp.setInt(_kUpdateLastCheck, t.millisecondsSinceEpoch);

  /// A version the user chose to skip; it stays unoffered until a newer one
  /// lands (or they press Check now, which ignores the skip).
  String? get skippedUpdateVersion => _sp.getString(_kUpdateSkipped);
  Future<void> setSkippedUpdateVersion(String? v) => v == null
      ? _sp.remove(_kUpdateSkipped).then((_) {})
      : _sp.setString(_kUpdateSkipped, v);

  // ── Voice mode ────────────────────────────────────────────────────────────

  static const _kVoiceCaptions = 'voice.captions.v1';
  static const _kVoiceHandsFree = 'voice.handsFree.v1';
  static const _kVoiceRate = 'voice.rate.v1';
  static const _kVoiceName = 'voice.name.v1';
  static const _kVoicePitch = 'voice.pitch.v1';

  /// Show live captions in voice mode. Default on.
  bool get voiceCaptions => _sp.getBool(_kVoiceCaptions) ?? true;
  Future<void> setVoiceCaptions(bool v) => _sp.setBool(_kVoiceCaptions, v);

  /// Hands-free conversation loop: re-arm the mic after each spoken reply.
  bool get voiceHandsFree => _sp.getBool(_kVoiceHandsFree) ?? true;
  Future<void> setVoiceHandsFree(bool v) => _sp.setBool(_kVoiceHandsFree, v);

  /// Text-to-speech rate (0.6–1.6, default 1.0).
  double get voiceRate => (_sp.getDouble(_kVoiceRate) ?? 1.0).clamp(0.6, 1.6);
  Future<void> setVoiceRate(double v) =>
      _sp.setDouble(_kVoiceRate, v.clamp(0.6, 1.6));

  /// Text-to-speech pitch (0.8–1.2, default 1.0). Small range on purpose:
  /// past roughly ±20% the engine's formants smear and it sounds synthetic.
  double get voicePitch => (_sp.getDouble(_kVoicePitch) ?? 1.0).clamp(0.8, 1.2);
  Future<void> setVoicePitch(double v) =>
      _sp.setDouble(_kVoicePitch, v.clamp(0.8, 1.2));

  /// Stable Android TTS voice name, or null to let the engine's best-quality
  /// voice for the device locale be picked automatically.
  String? get voiceName => _sp.getString(_kVoiceName);
  Future<void> setVoiceName(String? name) => name == null
      ? _sp.remove(_kVoiceName).then((_) {})
      : _sp.setString(_kVoiceName, name);

  // ── Device mesh ──────────────────────────────────────────────────────────

  String? get meshDeviceId => _sp.getString(_kMeshDeviceId);
  Future<void> setMeshDeviceId(String id) => _sp.setString(_kMeshDeviceId, id);

  bool get meshSharing => _sp.getBool(_kMeshSharing) ?? true;
  Future<void> setMeshSharing(bool v) => _sp.setBool(_kMeshSharing, v);

  bool get meshPeriodic => _sp.getBool(_kMeshPeriodic) ?? false;
  Future<void> setMeshPeriodic(bool v) => _sp.setBool(_kMeshPeriodic, v);

  int get meshIntervalSeconds => _sp.getInt(_kMeshInterval) ?? 300;
  Future<void> setMeshIntervalSeconds(int v) =>
      _sp.setInt(_kMeshInterval, v.clamp(60, 3600));

  /// Whether this device answers remote shell/filesystem commands (the
  /// "teleport" substrate) for the bridge it is connected to now.
  ///
  /// Off by default, and granted per bridge: turning it on records which
  /// bridge it was turned on for, and a profile pointed at any other bridge
  /// (a new pairing, a different host) reads it as off until the user turns
  /// it on again there.
  bool get meshDeviceControl =>
      (_sp.getBool(_kMeshDeviceControl) ?? false) &&
      _sp.getString(_kMeshControlBridge) == connection.bridgeKey;

  Future<void> setMeshDeviceControl(bool v) async {
    await _sp.setBool(_kMeshDeviceControl, v);
    if (v) {
      await _sp.setString(_kMeshControlBridge, connection.bridgeKey);
    } else {
      await _sp.setBool(_kMeshElevated, false);
    }
  }

  /// Whether device control may climb to an elevated tier (root, or
  /// Shizuku's shell UID) on Android. Off by default and never on without
  /// [meshDeviceControl] for the same bridge; while off, commands run as the
  /// app itself and nothing asks the root manager or Shizuku for a grant.
  bool get meshElevated =>
      meshDeviceControl && (_sp.getBool(_kMeshElevated) ?? false);

  Future<void> setMeshElevated(bool v) => _sp.setBool(_kMeshElevated, v);

  /// Withdraw device control and elevation — done whenever a pairing link
  /// points the app at a bridge, so a newly paired bridge always starts with
  /// neither, whatever the previous one had.
  Future<void> revokeMeshGrants() async {
    await _sp.setBool(_kMeshDeviceControl, false);
    await _sp.setBool(_kMeshElevated, false);
    await _sp.remove(_kMeshControlBridge);
  }

  int? get meshBgAliveAt => _sp.getInt(_kMeshBgAliveAt);
  Future<void> setMeshBgAliveAt(int epochMs) =>
      _sp.setInt(_kMeshBgAliveAt, epochMs);

  int? get meshBgStartedAt => _sp.getInt(_kMeshBgStartedAt);
  Future<void> setMeshBgStartedAt(int epochMs) =>
      _sp.setInt(_kMeshBgStartedAt, epochMs);

  // ── Notifications ─────────────────────────────────────────────────────────

  static const _kMessageNotifications = 'notify.messages.v1';
  static const _kUiForeground = 'ui.foreground.v1';

  /// Post a system notification when an assistant reply lands while the app is
  /// backgrounded. Default **off**: it needs the runtime POST_NOTIFICATIONS
  /// grant and it is the kind of thing a user should opt into, not discover.
  bool get messageNotifications => _sp.getBool(_kMessageNotifications) ?? false;
  Future<void> setMessageNotifications(bool v) =>
      _sp.setBool(_kMessageNotifications, v);

  /// Whether the UI isolate currently has the app in front of the user.
  ///
  /// Written by the UI on every [AppLifecycleState] change and read by the
  /// background mesh isolate, which has no other way to know: the two isolates
  /// share no memory, so SharedPreferences is the cheap cross-isolate flag.
  /// Without it you get a notification for a reply you are actively watching
  /// stream in.
  bool get uiForeground => _sp.getBool(_kUiForeground) ?? false;
  Future<void> setUiForeground(bool v) => _sp.setBool(_kUiForeground, v);

  // ── Read markers ──────────────────────────────────────────────────────────

  Map<String, int> _decodeLastRead() {
    try {
      final raw = _sp.getString(_kLastRead);
      if (raw == null) return {};
      return (jsonDecode(raw) as Map).map(
        (k, v) => MapEntry(k.toString(), v is num ? v.toInt() : 0),
      );
    } catch (_) {
      return {};
    }
  }

  /// Epoch-ms of the newest activity the user has seen in a chat (0 = never).
  int lastReadOf(String chatId) => _lastRead[chatId] ?? 0;

  Future<void> setLastRead(String chatId, int ts) {
    if ((_lastRead[chatId] ?? 0) >= ts) return Future.value();
    _lastRead[chatId] = ts;
    return _sp.setString(_kLastRead, jsonEncode(_lastRead));
  }

  Future<void> clearLastRead(String chatId) {
    _lastRead.remove(chatId);
    return _sp.setString(_kLastRead, jsonEncode(_lastRead));
  }

  // ── Offline snapshot ──────────────────────────────────────────────────────
  //
  // The snapshot (every chat + recent messages) used to be one string inside
  // SharedPreferences. Those backends rewrite the WHOLE store on every set —
  // one XML file on Android, one JSON file on Windows — so each read-marker
  // tick, foreground flag or mesh heartbeat rewrote the snapshot too, and the
  // snapshot itself was encoded on the UI isolate (#1059/#1060/#1063). It now
  // has a file of its own, encoded and written in a background isolate.

  /// Last-known chats + recent messages, decoded; null when absent/corrupt.
  /// Falls back to (and migrates from) the legacy SharedPreferences entry.
  ///
  /// Always null while the app lock is on: the snapshot then lives only in
  /// the sealed store and reaches the UI after unlock (AppLockController).
  Map<String, dynamic>? get snapshot {
    if (appLockEnabled) return null;
    try {
      final file = _snapshotFile;
      String? raw;
      if (file != null && file.existsSync()) raw = file.readAsStringSync();
      raw ??= _sp.getString(_kSnapshot);
      if (raw == null) return null;
      final decoded = jsonDecode(raw);
      return decoded is Map ? decoded.cast<String, dynamic>() : null;
    } catch (_) {
      return null;
    }
  }

  Future<void> saveSnapshot(Map<String, dynamic> snapshot) async {
    if (appLockEnabled) {
      // Encrypted at rest by the app lock; never written in the clear.
      await sealedSnapshotSink?.call(snapshot);
      return;
    }
    final file = _snapshotFile;
    if (file == null) {
      await _sp.setString(_kSnapshot, jsonEncode(snapshot));
      return;
    }
    try {
      final write = _writeSnapshotInBackground(file.path, snapshot);
      _plainWrite = write;
      await write;
    } catch (_) {
      return; // best-effort cache; the next save retries
    }
    // One-time migration: drop the legacy copy so the prefs store (rewritten
    // on every set) shrinks back to a few hundred bytes.
    if (_sp.containsKey(_kSnapshot)) await _sp.remove(_kSnapshot);
  }

  /// The plaintext snapshot write in flight, if any — awaited before the
  /// plaintext is cleared, so a write that started just before the app lock
  /// was turned on can't land after the clear.
  Future<void>? _plainWrite;

  /// Remove the plaintext snapshot — its file and the legacy
  /// SharedPreferences entry (app lock turned on: it now lives sealed).
  Future<void> clearPlainSnapshot() async {
    final pending = _plainWrite;
    if (pending != null) {
      try {
        await pending;
      } catch (_) {
        // A failed write left nothing (or only its temp file) behind.
      }
    }
    final file = _snapshotFile;
    if (file != null) {
      for (final f in [file, File('${file.path}.tmp')]) {
        try {
          if (f.existsSync()) await f.delete();
        } catch (e) {
          AppLog.warn('prefs', 'could not remove the plaintext snapshot', e);
        }
      }
    }
    await _sp.remove(_kSnapshot);
  }

  /// Static so the isolate closure captures only [path] and [snapshot].
  static Future<void> _writeSnapshotInBackground(
    String path,
    Map<String, dynamic> snapshot,
  ) =>
      Isolate.run(() => writeSnapshotFile(path, snapshot),
          debugName: 'snapshot-write');

  /// Where snapshots go while the app lock is on — set by the UI isolate's
  /// AppLockController, which seals them (AES-256-GCM) and writes them
  /// through [PrivateStore.writeFileSync] off the UI isolate, like the
  /// plaintext file above. Null elsewhere (the background isolate never
  /// saves one), and then a locked snapshot is simply dropped.
  static Future<void> Function(Map<String, dynamic> snapshot)?
      sealedSnapshotSink;

  // ── App lock (#1051) ──────────────────────────────────────────────────────
  //
  // The lock itself (verifier, wrapped keys, settings) lives in the platform
  // secure store. These are plain mirrors for readers that can't reach it:
  // the first frame (cover the UI before the async read lands) and the
  // Android background isolate (redact notifications, gate device commands).

  static const _kAppLockEnabled = 'applock.enabled.v1';
  static const _kAppLockElevatedGate = 'applock.elevatedGate.v1';

  bool get appLockEnabled => _sp.getBool(_kAppLockEnabled) ?? false;
  Future<void> setAppLockEnabled(bool v) => _sp.setBool(_kAppLockEnabled, v);

  /// "Require unlock for elevated commands" — only meaningful with the lock on.
  bool get appLockElevatedGate =>
      appLockEnabled && (_sp.getBool(_kAppLockElevatedGate) ?? false);
  Future<void> setAppLockElevatedGate(bool v) =>
      _sp.setBool(_kAppLockElevatedGate, v);
}

/// Encode [snapshot] and replace the file at [path] atomically (temp file +
/// rename), so a crash mid-write never leaves a truncated snapshot behind.
///
/// The snapshot holds recent chats, so like the settings store it is this
/// OS user's alone ([PrivateStore]): on Linux the temp file is narrowed to
/// 0600 before any content is written, and the rename carries that mode
/// over to the snapshot itself.
void writeSnapshotFile(String path, Map<String, dynamic> snapshot) =>
    PrivateStore.writeFileSync(path, jsonEncode(snapshot));
