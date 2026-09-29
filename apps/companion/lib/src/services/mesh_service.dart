import 'dart:async';
import 'dart:collection';
import 'dart:io' show Directory, File, Platform;

import 'package:battery_plus/battery_plus.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:crypto/crypto.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:geolocator/geolocator.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:uuid/uuid.dart';

import 'bridge_client.dart';
import 'command_wake_lock.dart';
import 'device_exec.dart';
import 'log.dart';
import 'mesh_audit.dart';
import 'prefs.dart';
import 'sandbox.dart';

class MeshBattery {
  final int? percent;
  final bool? charging;
  const MeshBattery({this.percent, this.charging});
}

class MeshFix {
  final double lat;
  final double lon;
  final double? accuracyM;
  final double? altitudeM;
  final double? speedMps;
  final double? headingDeg;
  final int ts;
  final String provider;

  const MeshFix({
    required this.lat,
    required this.lon,
    required this.ts,
    this.accuracyM,
    this.altitudeM,
    this.speedMps,
    this.headingDeg,
    this.provider = 'geolocator',
  });
}

typedef MeshLocationProvider = Future<MeshFix?> Function();
typedef MeshBatteryProvider = Future<MeshBattery> Function();
typedef MeshNameProvider = Future<String> Function();
typedef MeshVersionProvider = Future<String> Function();
typedef ForegroundStarter = Future<void> Function();
typedef MeshRingHandler = Future<void> Function(String? message);
typedef MeshRegisteredCallback = Future<void> Function();

/// Extra device intelligence merged into the `status` command's payload
/// (hardware model, OS, locale, timezone, network, …).
typedef MeshSystemInfoProvider = Future<Map<String, String>> Function();

/// Local approval for a device-control command: resolves to null to allow
/// it, or to the refusal sent back to the daemon (app lock, #1051).
typedef CommandApprover = Future<String?> Function(String command);

class MeshService {
  /// Base commands every build can execute, advertised at registration so the
  /// daemon can refuse unsupported commands with a clear message instead of
  /// timing out. Exec/filesystem commands are appended when device control is
  /// enabled (see [capabilitiesFor]).
  static const List<String> capabilities = ['locate', 'ring', 'status'];

  /// Streamed file-transfer commands: ONE command round trip arranges the
  /// transfer, then the file body moves as a single raw HTTP request via
  /// BridgeClient.uploadFile/downloadFile — replacing the chunked command
  /// channel (a full mesh round trip per chunk) for file bodies.
  static const List<String> transferCapabilities = [
    'upload_file',
    'download_file',
  ];

  /// Whether device control (exec/fs + streamed transfers) is live: the
  /// user's switch, AND not a Flatpak build. Inside the sandbox those commands
  /// would only ever reach the sandbox itself — never the host the daemon
  /// thinks it is teleporting into — so the Flatpak build is client-only and
  /// never advertises or answers them. [sandboxed] overrides detection in
  /// tests.
  static bool deviceControlAllowed(Prefs prefs, {bool? sandboxed}) =>
      prefs.meshDeviceControl && !(sandboxed ?? isFlatpak);

  /// Advertised capabilities for the current prefs — adds the exec/fs surface
  /// (DeviceExec) and streamed transfers when device control is enabled (see
  /// [deviceControlAllowed]).
  static List<String> capabilitiesFor(Prefs prefs, {bool? sandboxed}) => [
    ...capabilities,
    if (deviceControlAllowed(prefs, sandboxed: sandboxed)) ...[
      ...DeviceExec.capabilities,
      ...transferCapabilities,
    ],
  ];

  bool get _deviceControl => deviceControlAllowed(prefs);

  /// Commands that run code or touch files/packages on this device — the
  /// exec-class surface the app lock's "require unlock for elevated commands"
  /// covers (root/Shizuku execution happens only through these).
  static bool needsApproval(String command) =>
      DeviceExec.capabilities.contains(command) ||
      transferCapabilities.contains(command);

  /// Fallback when nothing can prompt on this device: allow unless the user
  /// asked for local approval, in which case refuse — never run a gated
  /// command unapproved.
  static Future<String?> defaultApproval(Prefs prefs, String command) async =>
      prefs.appLockElevatedGate
          ? 'Denied on the device: it requires local approval for '
              'device-control commands, and none could be requested.'
          : null;

  final Prefs prefs;
  final BridgeClient client;
  final DeviceExec _exec;
  final Future<MeshFix?> Function({bool live}) _locationProvider;
  final MeshBatteryProvider _batteryProvider;
  final MeshNameProvider _nameProvider;
  final MeshVersionProvider _versionProvider;
  final ForegroundStarter _foregroundStarter;
  final MeshRingHandler _ringHandler;
  final MeshSystemInfoProvider _systemInfoProvider;
  final MeshRegisteredCallback? _onRegistered;
  final CommandApprover? _approver;
  final MeshAudit _audit;

  StreamSubscription<Map<String, dynamic>>? _events;
  Timer? _heartbeat;
  Timer? _periodic;
  bool _running = false;

  MeshService(
    this.prefs,
    this.client, {
    MeshLocationProvider? locationProvider,
    MeshBatteryProvider? batteryProvider,
    MeshNameProvider? nameProvider,
    MeshVersionProvider? versionProvider,
    ForegroundStarter? foregroundStarter,
    MeshRingHandler? ringHandler,
    MeshSystemInfoProvider? systemInfoProvider,
    DeviceExec? deviceExec,
    MeshRegisteredCallback? onRegistered,
    CommandApprover? approver,
    MeshAudit? audit,
  }) : _approver = approver,
       _audit = audit ?? MeshAudit(),
       _locationProvider = locationProvider != null
           ? ({bool live = false}) => locationProvider()
           : _defaultLocation,
       _batteryProvider = batteryProvider ?? _defaultBattery,
       _nameProvider = nameProvider ?? _defaultName,
       _versionProvider = versionProvider ?? _defaultVersion,
       _foregroundStarter = foregroundStarter ?? _noopForeground,
       _ringHandler = ringHandler ?? _defaultRing,
       _systemInfoProvider = systemInfoProvider ?? _defaultSystemInfo,
       _onRegistered = onRegistered,
       _exec = deviceExec ?? DeviceExec() {
    // Mesh commands climb to root/Shizuku unless the user turned elevated
    // access off; then they run as the app and nothing asks the root manager
    // or Shizuku for anything.
    _exec.allowElevation = () => elevationAllowed(prefs);
    _exec.writeLimit = () => maxWriteBytesFor(prefs);
  }

  /// Whether mesh commands may use root or Shizuku: device control is live
  /// ([deviceControlAllowed]) AND elevated access is on (the default).
  static bool elevationAllowed(Prefs prefs, {bool? sandboxed}) =>
      deviceControlAllowed(prefs, sandboxed: sandboxed) && prefs.meshElevated;

  bool get running => _running;

  Future<String> deviceId() => ensureDeviceId(prefs);

  /// This install's stable mesh id, minted (and persisted) on first use.
  /// Static so the connection owner can bind a per-device credential to the
  /// same id the mesh registers with.
  static Future<String> ensureDeviceId(Prefs prefs) async {
    final existing = prefs.meshDeviceId;
    if (existing != null && existing.isNotEmpty) return existing;
    final id = const Uuid().v4();
    await prefs.setMeshDeviceId(id);
    return id;
  }

  Future<void> start() async {
    await stop();
    _running = true;
    if (!prefs.meshSharing) return;
    // Tell the client who we are before anything opens a stream: the daemon
    // addresses device_command frames (transfer tokens, exec command lines,
    // file bodies) to the claiming client only, and checks transfer tokens
    // against the device they were minted for.
    client.meshDeviceId = await deviceId();
    // Warm the privilege ladder now rather than on the first command. On a
    // device that reboots constantly (a car head unit powering up with the
    // ignition) the root grant would otherwise be acquired mid-command, with
    // the root manager's dialog appearing while someone is driving and the
    // command blocked behind it. Fire-and-forget: nothing here gates the mesh.
    // Skipped only when the user turned elevated access off.
    if (elevationAllowed(prefs)) {
      unawaited(
        _exec.ensureRootReady().catchError(
          (Object e) {
            AppLog.debug('mesh', 'root warm-up failed', e);
            return false;
          },
        ),
      );
    }
    await _foregroundStarter();
    try {
      await register();
    } catch (e) {
      AppLog.warn('mesh', 'initial mesh registration failed', e);
    }
    _events = client.events.listen(
      (event) {
        // Each command holds the device awake only while it runs (#1060).
        if (event['kind'] == 'locate') {
          unawaited(CommandWakeLock.hold(() => _handleLocate(event)));
        }
        if (event['kind'] == 'device_command') _admitCommand(event);
      },
      // SSE drops surface as stream errors. Reconnection belongs to the
      // connection's owner (AppState / MeshBackgroundRunner); without this
      // handler every drop became an unhandled zone error in this
      // subscription.
      onError: (Object e) => AppLog.debug('mesh', 'event stream error', e),
    );
    _heartbeat = Timer.periodic(const Duration(seconds: 60), (_) {
      if (prefs.meshSharing) unawaited(register());
    });
    _configurePeriodic();
  }

  Future<void> stop() async {
    _running = false;
    await _events?.cancel();
    _events = null;
    _heartbeat?.cancel();
    _heartbeat = null;
    _periodic?.cancel();
    _periodic = null;
  }

  void reconfigure() {
    if (!_running) return;
    _configurePeriodic();
    if (prefs.meshSharing) unawaited(register());
  }

  Future<void> register() async {
    if (!prefs.meshSharing) return;
    final id = await deviceId();
    final battery = await _batteryProvider();
    await client.registerDevice({
      'id': id,
      'name': await _nameProvider(),
      'platform': _platform,
      'appVersion': await _versionProvider(),
      if (battery.percent != null) 'battery': battery.percent,
      if (battery.charging != null) 'charging': battery.charging,
      'capabilities': capabilitiesFor(prefs),
    });
    await _onRegistered?.call();
  }

  Future<void> sendOneFix({bool live = false}) async {
    if (!prefs.meshSharing) return;
    try {
      final fix = await _locationProvider(live: live);
      if (fix == null) return;
      final battery = await _batteryProvider();
      await client.postLocation({
        'deviceId': await deviceId(),
        'lat': fix.lat,
        'lon': fix.lon,
        if (fix.accuracyM != null) 'accuracyM': fix.accuracyM,
        if (fix.altitudeM != null) 'altitudeM': fix.altitudeM,
        if (fix.speedMps != null) 'speedMps': fix.speedMps,
        if (fix.headingDeg != null) 'headingDeg': fix.headingDeg,
        'ts': fix.ts,
        'provider': fix.provider,
        if (battery.percent != null) 'batteryPct': battery.percent,
      });
    } catch (e) {
      AppLog.warn('mesh', 'sendOneFix failed', e);
    }
  }

  Future<void> _handleLocate(Map<String, dynamic> event) async {
    final target = event['deviceId'];
    if (target is String && target.isNotEmpty && target != await deviceId()) {
      return;
    }
    try {
      await sendOneFix(live: true);
    } catch (e) {
      AppLog.warn('mesh', 'locate handling failed', e);
    }
  }

  /// Default for how many mesh commands run at once; up to
  /// [maxQueuedCommands] more wait for a slot, and anything beyond that is
  /// answered "busy" straight away. Bounds what a burst of frames (a buggy or
  /// compromised daemon) can pile onto the device. Both are overridable in
  /// Settings → Mesh (`Prefs.meshMaxConcurrent` / `meshMaxQueued`).
  static const int maxConcurrentCommands = 4;
  static const int maxQueuedCommands = 16;

  int get _maxConcurrent => prefs.meshMaxConcurrent ?? maxConcurrentCommands;
  int get _maxQueued => prefs.meshMaxQueued ?? maxQueuedCommands;

  static const int _gib = 1024 * 1024 * 1024;

  /// The per-file mesh write cap: the user's setting, or the default.
  static int maxWriteBytesFor(Prefs prefs) {
    final gib = prefs.meshMaxWriteGiB;
    return gib == null ? DeviceExec.maxWriteBytes : gib * _gib;
  }

  int _commandsInFlight = 0;
  final Queue<Map<String, dynamic>> _queuedCommands = Queue();

  void _admitCommand(Map<String, dynamic> event) {
    if (_commandsInFlight < _maxConcurrent) {
      _runCommand(event);
    } else if (_queuedCommands.length < _maxQueued) {
      _queuedCommands.add(event);
    } else {
      unawaited(_answerBusy(event));
    }
  }

  void _runCommand(Map<String, dynamic> event) {
    _commandsInFlight++;
    unawaited(
      // Held only while the command runs (#1060); a queued command is
      // covered by the ones ahead of it until it starts.
      CommandWakeLock.hold(() => _handleCommand(event)).whenComplete(() {
        _commandsInFlight--;
        if (_queuedCommands.isNotEmpty) {
          _runCommand(_queuedCommands.removeFirst());
        }
      }),
    );
  }

  Future<void> _answerBusy(Map<String, dynamic> event) async {
    final id = event['id'];
    if (id is! String || id.isEmpty) return;
    final myId = await deviceId();
    if (event['deviceId'] != myId) return;
    try {
      await client.postCommandResult({
        'commandId': id,
        'deviceId': myId,
        'ok': false,
        'message': 'Device is busy ($_maxConcurrent commands running, '
            '$_maxQueued queued) — try again shortly.',
      });
    } catch (e) {
      AppLog.warn('mesh', 'busy result post failed', e);
    }
  }

  /// Execute a `device_command` addressed to this device and answer over
  /// POST /devices/command-result with the command's correlation id. Every
  /// path answers — success, failure, or unsupported — so the daemon's
  /// pending tool call resolves instead of timing out.
  Future<void> _handleCommand(Map<String, dynamic> event) async {
    final id = event['id'];
    final target = event['deviceId'];
    if (id is! String || id.isEmpty) return;
    final myId = await deviceId();
    if (target is! String || target.isEmpty || target != myId) return;
    final name = event['name'] is String ? event['name'] as String : '';
    final params = event['params'] is Map
        ? (event['params'] as Map).cast<String, dynamic>()
        : <String, dynamic>{};
    final clock = Stopwatch()..start();

    var ok = false;
    String? message;
    Map<String, dynamic>? data;
    try {
      // Gated before anything runs, so a refusal can't half-execute.
      if (_deviceControl && needsApproval(name)) {
        final denial = await (_approver ?? _defaultApprover)(name);
        if (denial != null) throw _CommandDenied(denial);
      }
      switch (name) {
        case 'locate':
          await sendOneFix(live: true);
          ok = true;
          message = 'Fresh fix reported.';
          break;
        case 'ring':
          final note = params['message'];
          await _ringHandler(note is String && note.isNotEmpty ? note : null);
          ok = true;
          break;
        case 'status':
          data = await _statusPayload();
          ok = true;
          break;
        case 'upload_file': // streamed pull: device → daemon, one HTTP POST
          if (!_deviceControl) {
            message = 'Device control is disabled on this device.';
            break;
          }
          final upToken = params['token'];
          final upPath = params['path'];
          if (upToken is! String || upToken.isEmpty || upPath is! String) {
            message = 'upload_file needs token and path.';
            break;
          }
          final src = File(upPath);
          if (!await src.exists()) {
            message = 'No such file: $upPath';
            break;
          }
          // Hashed as it streams (no second read), so the daemon can check
          // what arrived against what was sent.
          final upDigest = _DigestSink();
          final upHash = sha256.startChunkedConversion(upDigest);
          final sent = await client.uploadFile(
            upToken,
            src.openRead().map((chunk) {
              upHash.add(chunk);
              return chunk;
            }),
            await src.length(),
          );
          upHash.close();
          ok = true;
          data = {'bytes': sent, 'sha256': upDigest.hex};
          break;
        case 'download_file': // streamed push: daemon → device, one HTTP GET
          if (!_deviceControl) {
            message = 'Device control is disabled on this device.';
            break;
          }
          final downToken = params['token'];
          final downPath = params['path'];
          if (downToken is! String ||
              downToken.isEmpty ||
              downPath is! String) {
            message = 'download_file needs token and path.';
            break;
          }
          final dest = File(downPath);
          await Directory(dest.parent.path).create(recursive: true);
          // Stream to a temp file and rename, so a dropped connection can't
          // leave a half-written destination. The bytes are hashed as they
          // are written; when the daemon sent the payload's sha256 (older
          // daemons don't), a mismatch deletes the temp file instead.
          final wantSha = params['sha256'] is String
              ? (params['sha256'] as String).trim().toLowerCase()
              : '';
          final part = File('$downPath.part');
          final sink = part.openWrite();
          final downDigest = _DigestSink();
          final downHash = sha256.startChunkedConversion(downDigest);
          var received = 0;
          int written;
          try {
            written = await client.downloadFile(downToken, (chunk) async {
              received += chunk.length;
              final cap = _exec.writeLimit();
              if (received > cap) {
                throw StateError(
                  'download exceeds the $cap-byte '
                  'write cap',
                );
              }
              downHash.add(chunk);
              sink.add(chunk);
            });
            await sink.flush();
            await sink.close();
            downHash.close();
            if (wantSha.isNotEmpty && wantSha != downDigest.hex) {
              throw StateError(
                'integrity check failed (expected sha256 $wantSha, got '
                '${downDigest.hex}) — the download was discarded',
              );
            }
            await part.rename(downPath);
          } catch (e) {
            await sink.close().catchError((_) {});
            await part.delete().catchError((_) => part);
            rethrow;
          }
          ok = true;
          data = {'bytesWritten': written, 'sha256': downDigest.hex};
          break;
        default:
          // Exec/filesystem commands (the teleport substrate) — only when the
          // user has device control enabled.
          if (_deviceControl) {
            final outcome = await _exec.handle(name, params);
            if (outcome != null) {
              ok = outcome.ok;
              message = outcome.message;
              data = outcome.data;
              break;
            }
          }
          message = _deviceControl
              ? 'This app version does not support "$name".'
              : 'Device control is disabled on this device.';
      }
    } on _CommandDenied catch (d) {
      ok = false;
      message = d.message;
      AppLog.info('mesh', 'device_command "$name" denied locally');
    } catch (e) {
      ok = false;
      message = 'Command failed on device: $e';
      AppLog.warn('mesh', 'device_command "$name" failed', e);
    }

    final elapsed = clock.elapsed;
    try {
      await client.postCommandResult({
        'commandId': id,
        'deviceId': myId,
        'ok': ok,
        if (message != null) 'message': message,
        if (data != null) 'data': data,
      });
    } catch (e) {
      AppLog.warn('mesh', 'command result post failed', e);
    }
    // After the answer is sent, and never awaited: the audit can neither
    // delay nor fail a command (record() swallows its own errors).
    unawaited(
      _audit.record(
        MeshAudit.entryFor(
          commandId: id,
          name: name,
          params: params,
          ok: ok,
          message: message,
          data: data,
          elapsed: elapsed,
          token: client.config.token,
        ),
      ),
    );
  }

  Future<String?> _defaultApprover(String command) =>
      defaultApproval(prefs, command);

  Future<Map<String, dynamic>> _statusPayload() async {
    final battery = await _batteryProvider();
    Map<String, String> extras;
    try {
      extras = await _systemInfoProvider();
    } catch (_) {
      extras = const {};
    }
    Map<String, String> privilege;
    try {
      privilege = await _exec.privilegeStatus();
    } catch (_) {
      privilege = const {};
    }
    return {
      'name': await _nameProvider(),
      'platform': _platform,
      'appVersion': await _versionProvider(),
      if (battery.percent != null) 'battery': '${battery.percent}%',
      if (battery.charging != null)
        'charging': battery.charging! ? 'yes' : 'no',
      ...extras,
      ...privilege,
      'meshSharing': prefs.meshSharing ? 'on' : 'off',
      'periodicReporting': prefs.meshPeriodic
          ? 'every ${prefs.meshIntervalSeconds}s'
          : 'off',
    };
  }

  void _configurePeriodic() {
    _periodic?.cancel();
    _periodic = null;
    if (!prefs.meshSharing || !prefs.meshPeriodic) return;
    _periodic = Timer.periodic(
      Duration(seconds: prefs.meshIntervalSeconds),
      (_) => unawaited(sendOneFix(live: false)),
    );
  }

  static String get _platform {
    if (kIsWeb) return 'linux';
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    if (Platform.isMacOS) return 'macos';
    if (Platform.isWindows) return 'windows';
    return 'linux';
  }

  static Future<MeshFix?> _defaultLocation({bool live = false}) async {
    if (kIsWeb || Platform.isLinux) return null;
    try {
      var serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) return null;
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        return null;
      }
      if (Platform.isAndroid || Platform.isIOS) {
        final bg = await Geolocator.checkPermission();
        if (bg == LocationPermission.whileInUse) {
          await Geolocator.requestPermission();
        }
      }

      // Check last known location first only for periodic/background fixes to
      // avoid spinning up GNSS radio unnecessarily. On-demand locate ("find my
      // phone") always requests a fresh live fix at high accuracy.
      if (!live) {
        try {
          final lastKnown = await Geolocator.getLastKnownPosition();
          if (lastKnown != null) {
            final ageMs = DateTime.now().millisecondsSinceEpoch -
                lastKnown.timestamp.millisecondsSinceEpoch;
            // Re-use last known fix if it is fresh (< 60s old)
            if (ageMs >= 0 && ageMs < 60000) {
              return MeshFix(
                lat: lastKnown.latitude,
                lon: lastKnown.longitude,
                accuracyM: lastKnown.accuracy,
                altitudeM: lastKnown.altitude,
                speedMps: lastKnown.speed,
                headingDeg: lastKnown.heading,
                ts: lastKnown.timestamp.millisecondsSinceEpoch,
              );
            }
          }
        } catch (_) {}
      }

      final pos = await Geolocator.getCurrentPosition(
        locationSettings: LocationSettings(
          accuracy: live ? LocationAccuracy.high : LocationAccuracy.medium,
          timeLimit: Duration(seconds: live ? 15 : 10),
        ),
      );
      return MeshFix(
        lat: pos.latitude,
        lon: pos.longitude,
        accuracyM: pos.accuracy,
        altitudeM: pos.altitude,
        speedMps: pos.speed,
        headingDeg: pos.heading,
        ts: pos.timestamp.millisecondsSinceEpoch,
      );
    } catch (e) {
      AppLog.warn('mesh', 'location check failed', e);
      return null;
    }
  }

  static final Battery _battery = Battery();

  static Future<MeshBattery> _defaultBattery() async {
    try {
      final level = await _battery.batteryLevel;
      final state = await _battery.batteryState;
      return MeshBattery(
        percent: level >= 0 ? level : null,
        charging: state == BatteryState.charging || state == BatteryState.full,
      );
    } catch (_) {
      return const MeshBattery();
    }
  }

  static String? _cachedName;

  static Future<String> _defaultName() async {
    if (_cachedName != null) return _cachedName!;
    try {
      final info = DeviceInfoPlugin();
      if (!kIsWeb && Platform.isAndroid) {
        final d = await info.androidInfo;
        final name = '${d.manufacturer} ${d.model}'.trim();
        _cachedName = name;
        return name;
      }
      if (!kIsWeb && Platform.isIOS) {
        final d = await info.iosInfo;
        final name = d.name;
        _cachedName = name;
        return name;
      }
      if (!kIsWeb && Platform.isMacOS) {
        final d = await info.macOsInfo;
        final name = d.computerName;
        _cachedName = name;
        return name;
      }
      if (!kIsWeb && Platform.isWindows) {
        final d = await info.windowsInfo;
        final name = d.computerName;
        _cachedName = name;
        return name;
      }
      if (!kIsWeb && Platform.isLinux) {
        final d = await info.linuxInfo;
        final host = Platform.localHostname.trim();
        final name = (host.isNotEmpty && host != 'localhost')
            ? '${d.prettyName} ($host)'
            : d.prettyName;
        _cachedName = name;
        return name;
      }
    } catch (_) {
      /* fall through */
    }
    return 'Talon companion';
  }

  static String? _cachedVersion;

  static Future<String> _defaultVersion() async {
    if (_cachedVersion != null) return _cachedVersion!;
    try {
      final info = await PackageInfo.fromPlatform();
      final ver = '${info.version}+${info.buildNumber}';
      _cachedVersion = ver;
      return ver;
    } catch (_) {
      return 'unknown';
    }
  }

  @visibleForTesting
  static void resetStaticCaches() {
    _cachedName = null;
    _cachedVersion = null;
  }

  /// Best-effort find-my-device with no extra plugins: a burst of system
  /// alert sounds + vibration. Injectable so platforms can swap in a real
  /// ringtone implementation later.
  static Future<void> _defaultRing(String? message) async {
    for (var i = 0; i < 8; i++) {
      try {
        await SystemSound.play(SystemSoundType.alert);
        await HapticFeedback.vibrate();
      } catch (_) {
        /* headless/desktop platforms may lack one of the channels */
      }
      await Future<void>.delayed(const Duration(milliseconds: 450));
    }
  }

  /// Device intelligence for the `status` command: hardware identity, OS
  /// version, locale, timezone, and network connectivity. Every field is
  /// best-effort — one unavailable platform channel must not empty the rest.
  static Future<Map<String, String>> _defaultSystemInfo() async {
    final info = <String, String>{};
    if (!kIsWeb) {
      info['os'] =
          '${Platform.operatingSystem} ${Platform.operatingSystemVersion}';
      info['locale'] = Platform.localeName;
    }
    final now = DateTime.now();
    final offset = now.timeZoneOffset;
    final sign = offset.isNegative ? '-' : '+';
    final hh = offset.inHours.abs().toString().padLeft(2, '0');
    final mm = (offset.inMinutes.abs() % 60).toString().padLeft(2, '0');
    info['timezone'] = '${now.timeZoneName} (UTC$sign$hh:$mm)';
    try {
      final device = DeviceInfoPlugin();
      if (!kIsWeb && Platform.isAndroid) {
        final d = await device.androidInfo;
        info['hardware'] = '${d.manufacturer} ${d.model}';
        info['osDetail'] =
            'Android ${d.version.release} (SDK ${d.version.sdkInt})';
      } else if (!kIsWeb && Platform.isIOS) {
        final d = await device.iosInfo;
        info['hardware'] = d.utsname.machine;
        info['osDetail'] = '${d.systemName} ${d.systemVersion}';
      } else if (!kIsWeb && Platform.isMacOS) {
        final d = await device.macOsInfo;
        info['hardware'] = d.model;
        info['osDetail'] = 'macOS ${d.osRelease}';
      } else if (!kIsWeb && Platform.isWindows) {
        final d = await device.windowsInfo;
        info['osDetail'] = d.displayVersion;
      } else if (!kIsWeb && Platform.isLinux) {
        final d = await device.linuxInfo;
        info['osDetail'] = d.prettyName;
      }
    } catch (_) {
      /* device_info channel unavailable — keep what we have */
    }
    try {
      final links = await Connectivity().checkConnectivity();
      final named = links
          .where((c) => c != ConnectivityResult.none)
          .map((c) => c.name)
          .toList();
      info['network'] = named.isEmpty ? 'offline' : named.join('+');
    } catch (_) {
      /* connectivity channel unavailable */
    }
    return info;
  }

  /// Default foreground starter: nothing. On Android the foreground service
  /// is owned by MeshForegroundController (mesh_background.dart) — the mesh
  /// loop runs INSIDE that service's isolate, so starting it from here would
  /// be circular. Desktop platforms need no service at all. The injection
  /// point stays for tests and future platforms.
  static Future<void> _noopForeground() async {}
}

/// A device-control command refused by local approval (see [CommandApprover]).
class _CommandDenied implements Exception {
  final String message;
  const _CommandDenied(this.message);
}

/// Receives the digest of a chunked SHA-256 conversion, so a transfer can
/// hash its bytes as they stream past instead of re-reading the file.
class _DigestSink implements Sink<Digest> {
  Digest? _value;

  /// Lowercase hex, once the conversion has been closed.
  String get hex => _value.toString();

  @override
  void add(Digest data) => _value = data;

  @override
  void close() {}
}
