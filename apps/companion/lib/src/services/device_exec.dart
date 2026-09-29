import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'log.dart';

/// On-device shell + filesystem executor — the device half of Talon's
/// "teleport". The daemon pushes `exec`/`read_file`/`write_file`/`list_dir`/
/// `stat`/`delete`/`mkdir`/`move` commands over the mesh; this runs them here
/// and returns a structured payload.
///
/// Three privilege tiers, each tried in turn and each degrading into the next:
///   - root (Android, best): uid 0 via the `talon/root` channel — a `su`
///     binary (Magisk/KernelSU/APatch), a process that already runs as root,
///     or the adb-root agent for a `userdebug` device whose `su` refuses app
///     uids. Also reached when Shizuku itself was started as root (`adb root`
///     before Shizuku's start script), in which case the Shizuku path below
///     already IS root and is reported as such.
///   - Shizuku (optional, Android): when Shizuku is installed, running, and
///     has granted permission, commands run at shell (ADB) privilege via the
///     `talon/shizuku` platform channel — enough to reach far more of the
///     system without root. Falls back to app-UID whenever Shizuku is absent
///     or denied.
///   - app-UID (default, always available): commands run as the app's own
///     user via the platform shell (see [DeviceExec.shellInvocation]), and
///     file IO uses dart:io. This can reach shared storage (Downloads, DCIM,
///     …) when the app holds All-files access (MANAGE_EXTERNAL_STORAGE), but
///     not other apps' private data.
///
/// A platform-signed system build (uid 1000) is a fourth tier that needs no
/// wrapper — plain `sh -c` already runs at uid 1000 there — so it uses the
/// app-UID path and is only *reported* differently. See docs/companion-root.md.
class DeviceExec {
  DeviceExec({
    MethodChannel? shizukuChannel,
    MethodChannel? rootChannel,
    bool Function()? isAndroid,
  })  : _shizuku = shizukuChannel ?? const MethodChannel('talon/shizuku'),
        _root = rootChannel ?? const MethodChannel('talon/root'),
        _isAndroid = isAndroid ?? (() => !kIsWeb && Platform.isAndroid);

  final MethodChannel _shizuku;
  final MethodChannel _root;
  final bool Function() _isAndroid;

  /// Whether this executor may use (or ask for) root or Shizuku at all.
  /// The mesh points this at the user's elevated-access setting (see
  /// `Prefs.meshElevated`, default on); while it answers false, commands run
  /// as the app and no root/Shizuku grant dialog is ever raised on their
  /// behalf. The settings screen and the app's own updater keep the default,
  /// since the user is driving those directly.
  bool Function() allowElevation = _always;
  static bool _always() => true;
  Future<bool>? _pendingShizukuPermission;

  /// Last Shizuku state string reported by the native bridge ("ready",
  /// "permission-needed", "not-running", "unavailable", …). Captured on every
  /// readiness probe so an app-UID fallback can say *why* Shizuku wasn't used,
  /// in the command result that travels back over the mesh — no adb needed.
  String? _lastShizukuState;

  /// Last root-tier snapshot from the `talon/root` bridge, and when it was
  /// taken. Probing costs a `su` spawn (and, the first time, a grant dialog),
  /// so the answer is reused for [_rootProbeTtl] rather than re-derived on
  /// every mesh command.
  Map<String, dynamic>? _lastRoot;
  DateTime? _rootProbedAt;
  Future<Map<String, dynamic>?>? _pendingRootProbe;

  /// Why the root path was last abandoned mid-command, and when. Held apart
  /// from [_lastRoot] because the bridge's own snapshot is refreshed on every
  /// status read and would otherwise wipe the demotion the moment anything
  /// asked for the tier — leaving the executor retrying a path it has already
  /// watched fail.
  String? _rootFailure;
  DateTime? _rootFailedAt;

  /// Commands this executor can answer — merged into the device's advertised
  /// mesh capabilities so the daemon gates cleanly.
  static const List<String> capabilities = [
    'exec',
    'read_file',
    'write_file',
    'list_dir',
    'stat',
    'delete',
    'mkdir',
    'move',
    // Silent self-update: install a pushed APK at an elevated tier (root or
    // Shizuku). Advertised everywhere device control is on; answers with a
    // clear "only on Android / needs elevation" when it can't actually run.
    'install_apk',
  ];

  /// The shell invocation (executable + args) used for app-UID exec on [os]
  /// (a `Platform.operatingSystem` value; defaults to the current platform).
  ///
  /// Desktop commands should behave like the user's real terminal, not a
  /// stripped launchd/service environment:
  ///   - Windows: `cmd /c` — matches a stock Command Prompt.
  ///   - macOS: `/bin/zsh -l -c` — a login shell, so `~/.zprofile` runs and
  ///     the user's PATH additions (Homebrew, user bins, toolchains) are
  ///     visible, matching what the same command does in Terminal.app. A bare
  ///     `sh -c` here inherits launchd's minimal PATH and "command not found"s
  ///     anything user-installed.
  ///   - everywhere else (Android, Linux): `sh -c` — the portable baseline
  ///     (Android has no zsh/bash).
  @visibleForTesting
  static List<String> shellInvocation(String cmd, {String? os}) {
    final platform = os ?? Platform.operatingSystem;
    switch (platform) {
      case 'windows':
        return ['cmd', '/c', cmd];
      case 'macos':
        return ['/bin/zsh', '-l', '-c', cmd];
      default:
        return ['sh', '-c', cmd];
    }
  }

  static const int _maxChunkBytes = 256 * 1024;

  /// Default for the largest file a mesh write (write_file chunks,
  /// download_file) may produce on this device — the same 4 GiB as
  /// talon-node. The mesh points [writeLimit] at the user's setting.
  static const int maxWriteBytes = 4 * 1024 * 1024 * 1024;

  /// The per-file mesh write cap in force (see [maxWriteBytes]).
  int Function() writeLimit = _defaultWriteLimit;
  static int _defaultWriteLimit() => maxWriteBytes;
  static const Duration _shizukuPermissionWait = Duration(seconds: 12);

  /// How long a root probe's answer is trusted before asking the bridge again.
  /// Short enough that starting the adb agent (or granting su) takes effect
  /// without restarting the app, long enough that a stock phone with no root
  /// isn't re-probed on every single command.
  static const Duration _rootProbeTtl = Duration(seconds: 30);

  /// How long to wait for stdout/stderr to close after the shell itself has
  /// exited. A backgrounded child holding the inherited pipes must not pin
  /// the exec call open past this.
  static const Duration _pipeDrainGrace = Duration(seconds: 2);
  /// Per-stream cap on exec output shipped back over the mesh. Head + tail
  /// (not head-only): the daemon's teleport wrapper prints its cwd marker at
  /// the very END of stdout, and losing it would break cwd tracking.
  static const int _execOutputHeadBytes = 192 * 1024;
  static const int _execOutputTailBytes = 64 * 1024;

  /// The root bridge's view of this device: tier, how root was reached (or
  /// why it wasn't), the adb-agent one-liner, and the build's own properties.
  /// `null` off Android.
  ///
  /// [probe] `false` (the default) never spawns `su`, so it can't raise a
  /// grant dialog — that's the mode status payloads and the settings screen
  /// use. [probe] `true` actually tries to acquire root.
  Future<Map<String, dynamic>?> rootStatus({bool probe = false}) async {
    if (!_isAndroid()) return null;
    try {
      final status = await _root.invokeMapMethod<String, dynamic>(
        'getStatus',
        {'probe': probe},
      );
      if (status != null) {
        _lastRoot = status;
        AppLog.info(
          'root',
          'getStatus tier=${status['tier']} method=${status['method']} '
              'uid=${status['uid']}',
        );
      }
      return status;
    } catch (e) {
      // No bridge at all (older build, non-Android engine): not an error, just
      // the absence of the root tier.
      _lastRoot = {'tier': 'app', 'method': 'none', 'state': 'unavailable: $e'};
      return _lastRoot;
    }
  }

  /// Write the adb-root agent script to disk and return the one-liner that
  /// starts it. Android only; `null` elsewhere.
  Future<Map<String, dynamic>?> installRootAgent() async {
    if (!_isAndroid()) return null;
    try {
      return await _root.invokeMapMethod<String, dynamic>('installAgent');
    } catch (e) {
      AppLog.warn('root', 'installAgent failed', e);
      return null;
    }
  }

  /// True when a root path is available now, acquiring one if needed. The
  /// answer is cached for [_rootProbeTtl] and concurrent callers share one
  /// probe, so a burst of mesh commands can't stack up `su` spawns (or grant
  /// dialogs) on top of each other.
  Future<bool> ensureRootReady() async {
    if (!_isAndroid()) return false;
    if (!allowElevation()) return false;
    if (_rootDemoted) return false;
    final cached = _lastRoot;
    final probedAt = _rootProbedAt;
    if (cached != null &&
        probedAt != null &&
        DateTime.now().difference(probedAt) < _rootProbeTtl) {
      return cached['tier'] == 'root';
    }
    final probe = _pendingRootProbe ??=
        rootStatus(probe: true).whenComplete(() {
      _pendingRootProbe = null;
      _rootProbedAt = DateTime.now();
    });
    final status = await probe;
    return status?['tier'] == 'root';
  }

  /// Stop trusting the cached "root is available" answer after the root path
  /// itself failed, so the next command falls straight through to Shizuku
  /// instead of paying for a doomed elevation attempt each time.
  void _demoteRoot(String why) {
    _rootFailure = why;
    _rootFailedAt = DateTime.now();
  }

  /// Whether a recent root failure still stands. Expires with the same TTL as
  /// a probe, so genuinely transient breakage (an agent restarted, a revoked
  /// grant re-granted) heals without an app restart.
  bool get _rootDemoted {
    final at = _rootFailedAt;
    if (at == null) return false;
    if (DateTime.now().difference(at) < _rootProbeTtl) return true;
    _rootFailure = null;
    _rootFailedAt = null;
    return false;
  }

  /// True when Shizuku is available AND has granted permission right now.
  Future<bool> shizukuReady() async {
    if (!_isAndroid()) return false;
    try {
      final status =
          await _shizuku.invokeMapMethod<String, dynamic>('getStatus');
      final state = status?['state'];
      if (state is String) _lastShizukuState = state;
      final ready = status?['ready'] == true;
      AppLog.info('shizuku', 'getStatus ready=$ready state=$_lastShizukuState');
      return ready;
    } catch (e) {
      _lastShizukuState = 'error: $e';
      AppLog.warn('shizuku', 'getStatus failed', e);
      return false;
    }
  }

  /// Ask Shizuku for permission once. Concurrent commands share a single
  /// system prompt instead of replacing one another's result callback.
  Future<bool> requestShizuku() async {
    if (!_isAndroid()) return false;
    return _pendingShizukuPermission ??= _requestShizuku().whenComplete(() {
      _pendingShizukuPermission = null;
    });
  }

  Future<bool> _requestShizuku() async {
    try {
      final granted = await _shizuku
          .invokeMethod<bool>('requestPermission')
          .timeout(_shizukuPermissionWait);
      // The permission callback is advisory; re-check the binder before
      // claiming elevated execution is actually available.
      return granted == true && await shizukuReady();
    } on TimeoutException {
      // Dart has stopped waiting, so release the Android-side MethodChannel
      // result too. A late approval still applies to the next command.
      unawaited(_cancelShizukuPermissionRequest());
      return false;
    } catch (_) {
      return false;
    }
  }

  Future<void> _cancelShizukuPermissionRequest() async {
    try {
      await _shizuku.invokeMethod<void>('cancelPermissionRequest');
    } catch (_) {
      // The bridge may have gone away with the activity; the next status check
      // will report it as unavailable.
    }
  }

  /// Prefer elevated Android execution, but never hang the command forever
  /// waiting for a permission dialog that may be ignored.
  Future<bool> ensureShizukuReady() async {
    if (!allowElevation()) return false;
    if (await shizukuReady()) return true;
    if (!_isAndroid()) return false;
    return requestShizuku();
  }

  /// The tier this device would execute at right now, for the mesh `status`
  /// payload and the settings screen. Never prompts: it reports what is
  /// already available rather than trying to acquire anything.
  Future<Map<String, String>> privilegeStatus() async {
    // Desktop platforms run commands as the logged-in OS user; the
    // root/shizuku/app distinction is Android-only.
    if (!_isAndroid()) return const {'execPrivilege': 'user'};
    if (!allowElevation()) {
      return const {
        'execPrivilege': 'app',
        'execVia': 'none',
        'elevation': 'off (enable elevated access in the companion settings)',
      };
    }
    Map<String, dynamic>? shizuku;
    try {
      shizuku = await _shizuku.invokeMapMethod<String, dynamic>('getStatus');
    } catch (_) {
      shizuku = null;
    }
    final root = await rootStatus();
    final shizukuReady = shizuku?['ready'] == true;
    // A Shizuku server started while adbd was root runs at uid 0, so this
    // "shell" path is really root. Report the privilege the commands actually
    // get, not the mechanism that carries them.
    final shizukuUid = (shizuku?['uid'] as num?)?.toInt();
    final shizukuIsRoot = shizukuReady && shizukuUid == 0;
    final rootMethod = root?['method'];
    // A root path that failed mid-command is not the tier this device runs at,
    // however healthy the bridge's own snapshot looks.
    final rootTier = _rootDemoted ? 'app' : root?['tier'];
    final (privilege, method) = switch ((rootTier, shizukuIsRoot)) {
      ('root', _) => ('root', rootMethod is String ? rootMethod : 'root'),
      (_, true) => ('root', 'shizuku'),
      _ when shizukuReady => ('shizuku', 'shizuku'),
      ('system', _) => ('system', 'system-uid'),
      _ => ('app', 'none'),
    };
    return {
      'execPrivilege': privilege,
      'execVia': method,
      'shizuku': shizuku?['state'] is String
          ? '${shizuku!['state']}${shizukuIsRoot ? ' (uid 0)' : ''}'
          : 'unavailable',
      if (_rootStateLabel() != null) 'root': _rootStateLabel()!,
    };
  }

  /// Human description of the root tier for status payloads and the settings
  /// row — the bridge's own words, or the failure that overrode them.
  String? _rootStateLabel() {
    final failure = _rootDemoted ? _rootFailure : null;
    final state = _lastRoot?['state'];
    if (failure != null) {
      return state is String ? '$state, then $failure' : failure;
    }
    return state is String ? state : null;
  }

  /// Dispatch a mesh command by name; returns `null` for names this executor
  /// does not own (so the caller can try other handlers).
  Future<CommandOutcome?> handle(
    String name,
    Map<String, dynamic> params,
  ) async {
    switch (name) {
      case 'exec':
        return exec(
          _str(params['cmd']) ?? '',
          cwd: _str(params['cwd']),
          timeoutMs: _int(params['timeoutMs']),
        );
      case 'read_file':
        return readFile(
          _str(params['path']) ?? '',
          offset: _int(params['offset']) ?? 0,
          len: _int(params['len']) ?? _maxChunkBytes,
        );
      case 'write_file':
        return writeFile(
          _str(params['path']) ?? '',
          _str(params['base64']) ?? '',
          offset: _int(params['offset']) ?? 0,
          truncate: params['truncate'] == true,
        );
      case 'list_dir':
        return listDir(_str(params['path']) ?? '');
      case 'stat':
        return statPath(_str(params['path']) ?? '');
      case 'delete':
        return deletePath(_str(params['path']) ?? '');
      case 'mkdir':
        return mkdir(_str(params['path']) ?? '');
      case 'move':
        return move(_str(params['from']) ?? '', _str(params['to']) ?? '');
      case 'install_apk':
        return installApk(
          _str(params['path']) ?? '',
          sha256: _str(params['sha256']),
          delayMs: _int(params['delayMs']),
          allowDowngrade: params['allow_downgrade'] == true,
        );
      default:
        return null;
    }
  }

  // ── exec ──────────────────────────────────────────────────────────────────

  Future<CommandOutcome> exec(
    String cmd, {
    String? cwd,
    int? timeoutMs,
  }) async {
    if (cmd.trim().isEmpty) {
      return CommandOutcome.fail('No command given.');
    }
    final budget =
        Duration(milliseconds: (timeoutMs ?? 60000).clamp(1000, 300000));
    // Root first — it is the only tier that reaches other apps' data, /data,
    // and the whole system, so anything the daemon asks for lands where the
    // operator expects rather than inside a scoped-storage view.
    if (await ensureRootReady()) {
      try {
        final res = await _root.invokeMapMethod<String, dynamic>('exec', {
          'cmd': cmd,
          if (cwd != null) 'cwd': cwd,
          'timeoutMs': budget.inMilliseconds,
        });
        if (res != null) return _nativeOutcome(res, 'root');
      } catch (e) {
        AppLog.warn('exec', 'root exec failed, falling back', e);
        _demoteRoot('exec failed: $e');
      }
    }
    // Then Shizuku (shell UID). If it is installed but permission has not
    // been granted yet, ask once; otherwise a remote filesystem command can
    // silently run as the app UID and return a misleading scoped-storage view.
    if (await ensureShizukuReady()) {
      try {
        final res = await _shizuku.invokeMapMethod<String, dynamic>('exec', {
          'cmd': cmd,
          if (cwd != null) 'cwd': cwd,
          'timeoutMs': budget.inMilliseconds,
        });
        if (res != null) return _nativeOutcome(res, 'shizuku');
      } catch (e) {
        AppLog.warn('exec', 'shizuku exec failed, falling back', e);
        return _execAppUid(
          cmd,
          cwd: cwd,
          budget: budget,
          privilegeWarning: 'Shizuku exec failed ($e); ran as app UID.',
        );
      }
    }
    return _execAppUid(
      cmd,
      cwd: cwd,
      budget: budget,
      privilegeWarning: _isAndroid() && !allowElevation()
          ? 'Elevated access is off in the companion settings; ran as app UID.'
          : _isAndroid()
          ? 'Elevation not used (root=${_rootStateLabel() ?? 'unknown'}, '
              'shizuku=${_lastShizukuState ?? 'unknown'}); ran as app UID.'
          : null,
    );
  }

  /// One elevated result (root or Shizuku bridge) as a [CommandOutcome].
  /// `via` names the tier; `rootMethod` (su / agent / uid0) is carried through
  /// so a mesh reply says *how* root was reached, not merely that it was.
  CommandOutcome _nativeOutcome(Map<String, dynamic> res, String via) {
    final exit = (res['exitCode'] as num?)?.toInt();
    return CommandOutcome(
      ok: exit == 0,
      data: {
        'stdout': _CappedOutput.clamp('${res['stdout'] ?? ''}'),
        'stderr': _CappedOutput.clamp('${res['stderr'] ?? ''}'),
        'exitCode': exit ?? -1,
        'via': via,
        if (via == 'root' && res['via'] is String) 'rootMethod': res['via'],
      },
    );
  }

  Future<CommandOutcome> _execAppUid(
    String cmd, {
    String? cwd,
    required Duration budget,
    String? privilegeWarning,
  }) async {
    final invocation = shellInvocation(cmd);
    try {
      final proc = await Process.start(
        invocation.first,
        invocation.sublist(1),
        workingDirectory: (cwd != null && cwd.isNotEmpty) ? cwd : null,
      );
      // Bounded collection: a chatty command must not balloon app memory or
      // the mesh result payload — the stream keeps draining, extra bytes are
      // counted and elided.
      final out = _CappedOutput();
      final err = _CappedOutput();
      final outF = proc.stdout.transform(utf8.decoder).forEach(out.add);
      final errF = proc.stderr.transform(utf8.decoder).forEach(err.add);
      var timedOut = false;
      final timer = Timer(budget, () {
        timedOut = true;
        proc.kill(ProcessSignal.sigkill);
      });
      final code = await proc.exitCode;
      timer.cancel();
      // The shell has exited, but a backgrounded child (`long-running &`)
      // inherits the stdout/stderr pipes and can hold them open long after —
      // awaiting pipe closure unconditionally here used to hang the whole
      // exec (and thus the mesh call) until the transport gave up. Give
      // lingering writers a short grace to flush, then answer with whatever
      // arrived: redirect-to-file is the supported channel for persistent
      // streams (`cmd > /tmp/log 2>&1 &`, then read the file).
      await Future.wait([outF, errF])
          .timeout(_pipeDrainGrace, onTimeout: () => const []);
      final stdout = out.value();
      final stderr = err.value();
      return CommandOutcome(
        ok: !timedOut && code == 0,
        data: {
          'stdout': stdout,
          'stderr': [
            if (privilegeWarning != null) privilegeWarning,
            if (stderr.isNotEmpty) stderr,
            if (timedOut) '[killed: timeout]',
          ].join('\n'),
          'exitCode': code,
          // Only Android has a degraded app-UID mode worth flagging; desktop
          // shells already run as the OS user.
          if (_isAndroid()) 'via': 'app',
          if (privilegeWarning != null) 'privilegeWarning': privilegeWarning,
        },
        message: timedOut ? 'Command timed out.' : null,
      );
    } catch (e) {
      return CommandOutcome.fail('Failed to run command: $e');
    }
  }

  // ── self-update ─────────────────────────────────────────────────────────--

  /// Install a (already-pushed) APK to silently update the companion itself —
  /// the device half of Talon's remote self-update.
  ///
  /// The connection-survival trick: this is paired with the mesh foreground
  /// service's `autoRunOnMyPackageReplaced` flag. `pm install -r` kills the
  /// app to replace it, then Android broadcasts MY_PACKAGE_REPLACED and the
  /// service (hence the whole mesh loop) auto-restarts and reconnects — so a
  /// remote update drops the link only for the couple of seconds the process
  /// is being swapped, with no manual reopen.
  ///
  /// Three things make it robust:
  ///   1. It requires an elevated tier — root, or Shizuku's shell/ADB UID. The
  ///      app UID cannot install a package without a user tapping through
  ///      PackageInstaller, which a headless mesh command can't do.
  ///   2. The APK is RE-STAGED under /data/local/tmp before `pm install`. The
  ///      daemon pushes to app storage (/sdcard/Download), which the shell can
  ///      read but the system installer cannot — `pm install` straight off an
  ///      app-FUSE path dies with "Failed transaction" (seen live on the
  ///      Pixel 10, 2026-07-10). The copy goes into a fresh `mktemp -d`
  ///      directory (0700, random name), and the integrity hash is checked on
  ///      that copy — and checked again by the install worker immediately
  ///      before `pm install` reads it.
  ///   3. The actual `pm install` runs DETACHED (setsid) after a short delay,
  ///      so this command can post its "staged" ack over the mesh BEFORE pm
  ///      tears the app down, and the install still completes even though the
  ///      app process dies mid-way (its parent is the Shizuku server, not us).
  ///
  /// `pm install -r` also refuses a differently-signed APK, so a wrong or
  /// tampered file can't hijack the app — it just fails the reinstall — and,
  /// by default, refuses a lower versionCode, so an older signed build can't
  /// be rolled back onto the device by accident. [allowDowngrade] (the
  /// command's `allow_downgrade: true`) adds `-d` for a deliberate rollback;
  /// Android itself may still refuse it for a non-debuggable package.
  Future<CommandOutcome> installApk(
    String path, {
    String? sha256,
    int? delayMs,
    bool allowDowngrade = false,
  }) async {
    if (!_isAndroid()) {
      return CommandOutcome.fail('install_apk is only supported on Android.');
    }
    if (path.isEmpty) return CommandOutcome.fail('No APK path given.');
    final elevated = await ensureRootReady() || await ensureShizukuReady();
    if (!elevated) {
      return CommandOutcome.fail(
        'Silent install needs root or Shizuku '
        '(root=${_rootStateLabel() ?? 'unavailable'}, '
        'shizuku=${_lastShizukuState ?? 'unavailable'}). '
        'Grant root, or install Shizuku and grant Talon permission, then retry.',
      );
    }
    final expected = (sha256 ?? '').trim().toLowerCase();
    if (expected.isNotEmpty && !RegExp(r'^[0-9a-f]{64}$').hasMatch(expected)) {
      return CommandOutcome.fail(
        'APK integrity check failed: "$sha256" is not a SHA-256 digest. '
        'Aborting install.',
      );
    }
    // Stage, verify and report in ONE elevated shell: existence is probed
    // there (the app UID often cannot even stat shell-owned paths), the copy
    // goes into a fresh mktemp directory only root/shell can enter (not a
    // fixed, guessable file name), and the hash is taken of that private
    // copy — the file pm will actually read.
    final String stagedDir;
    try {
      final res = await _elevatedExec(stageApkScript(path, expected), 120000);
      final code = (res?['exitCode'] as num?)?.toInt() ?? 1;
      final out = '${res?['stdout'] ?? ''}'.trim();
      final err = '${res?['stderr'] ?? ''}'.trim();
      switch (code) {
        case 0:
          stagedDir = out.split('\n').last.trim();
        case 3:
          return CommandOutcome.fail('No such APK on device: $path');
        case 6:
          return CommandOutcome.fail(
            'APK integrity check failed: expected $expected, got $err. '
            'Aborting install.',
          );
        default:
          return CommandOutcome.fail(
            'Failed to stage the APK into $_apkStageRoot: $err',
          );
      }
    } catch (e) {
      return CommandOutcome.fail('Failed to stage the APK: $e');
    }
    if (!stagedDir.startsWith('$_apkStageRoot/talon-update.')) {
      return CommandOutcome.fail(
        'Failed to stage the APK: unexpected staging path "$stagedDir".',
      );
    }
    final staged = '$stagedDir/update.apk';
    final logPath = '$stagedDir/install.log';
    final delay = (delayMs ?? 3000).clamp(0, 30000);
    final sleepSecs = (delay / 1000).ceil();
    try {
      await _elevatedExec(
        'setsid sh -c ${_shQuote(installApkWorker(stagedDir, expected, sleepSecs, allowDowngrade: allowDowngrade))} '
        '>/dev/null 2>&1 &',
        5000,
      );
    } catch (e) {
      return CommandOutcome.fail('Failed to stage the install: $e');
    }
    return CommandOutcome(
      ok: true,
      message: 'Update staged — installing in ${sleepSecs}s, then the app '
          'restarts and the mesh reconnects automatically.',
      data: {
        'staged': true,
        'stagedPath': staged,
        'delayMs': delay,
        'allowDowngrade': allowDowngrade,
        'log': logPath,
        'via': (!_rootDemoted && _lastRoot?['tier'] == 'root')
            ? 'root'
            : 'shizuku',
      },
    );
  }

  /// Where elevated installs stage their private copy: shell-owned and
  /// readable by `pm`, unlike the app-FUSE path the daemon pushes to.
  static const _apkStageRoot = '/data/local/tmp';

  /// Elevated staging step for [installApk]. Exit codes: 0 = staged (prints
  /// the private directory), 3 = no such source, 4/5 = staging failed,
  /// 6 = hash mismatch (prints the actual digest on stderr).
  @visibleForTesting
  static String stageApkScript(
    String source,
    String expected, {
    String root = _apkStageRoot,
  }) {
    final src = _shQuote(source);
    final want = _shQuote(expected);
    return [
      '[ -f $src ] || exit 3',
      'd=\$(mktemp -d -p ${_shQuote(root)} talon-update.XXXXXXXXXX) || exit 4',
      'chmod 700 "\$d" && cp -f $src "\$d/update.apk" || '
          '{ rm -rf "\$d"; exit 5; }',
      'if [ -n $want ]; then '
          'got=\$(sha256sum "\$d/update.apk" | cut -d" " -f1); '
          'if [ "\$got" != $want ]; then rm -rf "\$d"; echo "\$got" >&2; '
          'exit 6; fi; fi',
      'echo "\$d"',
    ].join('\n');
  }

  /// The detached install worker: wait (so the mesh ack flushes before pm
  /// tears the app down), re-check the digest right before handing the file
  /// to pm, then `pm install -r` — keep data, same-or-newer only unless
  /// [allowDowngrade] adds `-d` for an explicit rollback. The staged APK is
  /// removed afterwards; the log stays beside it.
  @visibleForTesting
  static String installApkWorker(
    String dir,
    String expected,
    int sleepSecs, {
    bool allowDowngrade = false,
  }) {
    final apk = _shQuote('$dir/update.apk');
    final log = _shQuote('$dir/install.log');
    final want = _shQuote(expected);
    final flags = allowDowngrade ? '-r -d' : '-r';
    return 'sleep $sleepSecs; '
        'if [ -z $want ] || '
        '[ "\$(sha256sum $apk | cut -d" " -f1)" = $want ]; then '
        'pm install $flags $apk > $log 2>&1; echo "exit=\$?" >> $log; '
        'else echo "integrity check failed before install" > $log; fi; '
        'rm -f $apk';
  }

  /// Run one command at the highest tier available, for the install pipeline's
  /// own staging steps. Root when we have it, Shizuku otherwise — the caller
  /// has already established that one of the two is available.
  Future<Map<String, dynamic>?> _elevatedExec(String cmd, int timeoutMs) async {
    if (await ensureRootReady()) {
      try {
        return await _root.invokeMapMethod<String, dynamic>('exec', {
          'cmd': cmd,
          'timeoutMs': timeoutMs,
        });
      } catch (e) {
        AppLog.warn('exec', 'root exec failed, falling back', e);
        _demoteRoot('exec failed: $e');
      }
    }
    return _shizuku.invokeMapMethod<String, dynamic>('exec', {
      'cmd': cmd,
      'timeoutMs': timeoutMs,
    });
  }

  /// POSIX single-quote a string for safe interpolation into a shell command.
  static String _shQuote(String s) => "'${s.replaceAll("'", "'\\''")}'";

  // ── filesystem ────────────────────────────────────────────────────────────

  Future<CommandOutcome> readFile(String path,
      {required int offset, required int len}) async {
    if (path.isEmpty) return CommandOutcome.fail('No path.');
    try {
      final file = File(path);
      if (!await file.exists()) {
        return CommandOutcome.fail('No such file: $path');
      }
      final size = await file.length();
      final raf = await file.open();
      try {
        await raf.setPosition(offset);
        final want = len.clamp(0, _maxChunkBytes);
        final bytes = await raf.read(want);
        final eof = offset + bytes.length >= size;
        return CommandOutcome.okData({
          'base64': base64Encode(bytes),
          'size': size,
          'eof': eof,
        });
      } finally {
        await raf.close();
      }
    } catch (e) {
      return CommandOutcome.fail('read_file failed: $e');
    }
  }

  Future<CommandOutcome> writeFile(
    String path,
    String b64, {
    required int offset,
    required bool truncate,
  }) async {
    if (path.isEmpty) return CommandOutcome.fail('No path.');
    try {
      final file = File(path);
      await file.parent.create(recursive: true);
      final bytes = base64Decode(b64);
      // Capped per file: a mesh write never grows a file past writeLimit.
      // Below that, writes proceed until a real limit fails them (disk full,
      // permissions), and that exception is surfaced verbatim below.
      final cap = writeLimit();
      if ((truncate ? 0 : offset) + bytes.length > cap) {
        return CommandOutcome.fail(
          'write_file refused: the file would exceed the '
          '$cap-byte limit for mesh writes (Settings → Mesh).',
        );
      }
      // Write at the offset the daemon asked for — never blind-append. The
      // transfer protocol is truncate-first + sequential offsets, so a chunk
      // whose offset doesn't match the current size is out of order (or a
      // duplicate retry) and appending it would silently corrupt the file.
      final raf = await file.open(
        mode: truncate ? FileMode.write : FileMode.append,
      );
      try {
        if (!truncate) {
          final current = await raf.length();
          if (offset != current) {
            return CommandOutcome.fail(
              'write_file chunk offset $offset does not match current size '
              '$current for $path (out-of-order or duplicate chunk).',
            );
          }
        }
        await raf.setPosition(truncate ? 0 : offset);
        await raf.writeFrom(bytes);
        if (truncate) await raf.truncate(bytes.length);
        await raf.flush();
      } finally {
        await raf.close();
      }
      return CommandOutcome.okData({'bytesWritten': bytes.length});
    } catch (e) {
      return CommandOutcome.fail('write_file failed: $e');
    }
  }

  Future<CommandOutcome> listDir(String path) async {
    if (path.isEmpty) return CommandOutcome.fail('No path.');
    try {
      final dir = Directory(path);
      if (!await dir.exists()) {
        return CommandOutcome.fail('No such directory: $path');
      }
      final entries = <Map<String, dynamic>>[];
      await for (final e in dir.list(followLinks: false)) {
        final stat = await e.stat();
        entries.add({
          'name': e.uri.pathSegments.where((s) => s.isNotEmpty).last,
          'type': stat.type == FileSystemEntityType.directory ? 'dir' : 'file',
          'size': stat.size,
          'mtime': stat.modified.millisecondsSinceEpoch,
        });
      }
      entries
          .sort((a, b) => (a['name'] as String).compareTo(b['name'] as String));
      return CommandOutcome.okData({'entries': entries});
    } catch (e) {
      return CommandOutcome.fail('list_dir failed: $e');
    }
  }

  Future<CommandOutcome> statPath(String path) async {
    if (path.isEmpty) return CommandOutcome.fail('No path.');
    try {
      final stat = await FileStat.stat(path);
      if (stat.type == FileSystemEntityType.notFound) {
        return CommandOutcome.fail('No such path: $path');
      }
      return CommandOutcome.okData({
        'type': stat.type.toString().split('.').last,
        'size': stat.size,
        'mtime': stat.modified.millisecondsSinceEpoch,
        'mode': stat.modeString(),
      });
    } catch (e) {
      return CommandOutcome.fail('stat failed: $e');
    }
  }

  Future<CommandOutcome> deletePath(String path) async {
    if (path.isEmpty) return CommandOutcome.fail('No path.');
    try {
      final type = await FileSystemEntity.type(path);
      if (type == FileSystemEntityType.directory) {
        await Directory(path).delete(recursive: true);
      } else if (type == FileSystemEntityType.notFound) {
        return CommandOutcome.fail('No such path: $path');
      } else {
        await File(path).delete();
      }
      return CommandOutcome(ok: true, message: 'Deleted $path');
    } catch (e) {
      return CommandOutcome.fail('delete failed: $e');
    }
  }

  Future<CommandOutcome> mkdir(String path) async {
    if (path.isEmpty) return CommandOutcome.fail('No path.');
    try {
      await Directory(path).create(recursive: true);
      return CommandOutcome(ok: true, message: 'Created $path');
    } catch (e) {
      return CommandOutcome.fail('mkdir failed: $e');
    }
  }

  Future<CommandOutcome> move(String from, String to) async {
    if (from.isEmpty || to.isEmpty) {
      return CommandOutcome.fail('from/to required.');
    }
    try {
      final type = await FileSystemEntity.type(from);
      if (type == FileSystemEntityType.directory) {
        await Directory(from).rename(to);
      } else {
        await File(from).rename(to);
      }
      return CommandOutcome(ok: true, message: 'Moved $from → $to');
    } catch (e) {
      // rename fails across filesystems — fall back to copy+delete for files.
      try {
        await File(from).copy(to);
        await File(from).delete();
        return CommandOutcome(ok: true, message: 'Moved $from → $to (copied)');
      } catch (e2) {
        return CommandOutcome.fail('move failed: $e2');
      }
    }
  }

  static String? _str(dynamic v) => v is String && v.isNotEmpty ? v : null;
  static int? _int(dynamic v) =>
      v is num ? v.toInt() : (v is String ? int.tryParse(v) : null);
}

/// Structured result of an on-device command.
class CommandOutcome {
  const CommandOutcome({required this.ok, this.message, this.data});

  final bool ok;
  final String? message;
  final Map<String, dynamic>? data;

  factory CommandOutcome.fail(String message) =>
      CommandOutcome(ok: false, message: message);
  factory CommandOutcome.okData(Map<String, dynamic> data) =>
      CommandOutcome(ok: true, data: data);
}

/// Bounded exec-output collector: keeps the head and a rolling tail, counts
/// what it elides. The tail is load-bearing — the daemon's teleport wrapper
/// emits its cwd marker as the LAST bytes of stdout.
class _CappedOutput {
  final StringBuffer _head = StringBuffer();
  String _tail = '';
  int _dropped = 0;

  void add(String chunk) {
    var rest = chunk;
    final room = DeviceExec._execOutputHeadBytes - _head.length;
    if (room > 0) {
      if (rest.length <= room) {
        _head.write(rest);
        return;
      }
      _head.write(rest.substring(0, room));
      rest = rest.substring(room);
    }
    _tail = _tail + rest;
    if (_tail.length > DeviceExec._execOutputTailBytes) {
      _dropped += _tail.length - DeviceExec._execOutputTailBytes;
      _tail = _tail.substring(_tail.length - DeviceExec._execOutputTailBytes);
    }
  }

  String value() {
    if (_tail.isEmpty) return _head.toString();
    final note = _dropped > 0 ? '\n…[$_dropped chars truncated]…\n' : '';
    return '$_head$note$_tail';
  }

  /// One-shot clamp for output that already arrived as a single string
  /// (the Shizuku channel hands the whole result over at once).
  static String clamp(String s) {
    final out = _CappedOutput()..add(s);
    return out.value();
  }
}
