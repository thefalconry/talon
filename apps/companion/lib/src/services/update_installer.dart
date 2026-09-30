import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'device_exec.dart';
import 'log.dart';
import 'updater.dart';
import 'windows_tray.dart';

/// What happened when a downloaded release was handed to the platform.
enum InstallKind {
  /// Staged: a helper script is waiting for this process to exit, then swaps
  /// the install in place and relaunches it. The user presses "Restart".
  restartPending,

  /// Someone else has it now — Android's package installer (needs a tap), or
  /// an elevated `pm install` that will restart the app on its own.
  handedOff,

  /// Nothing this app can do automatically: a read-only/managed install, or a
  /// platform with no self-update path. The message says what to do instead.
  manual,
  failed,
}

@immutable
class InstallOutcome {
  final InstallKind kind;
  final String message;
  const InstallOutcome(this.kind, this.message);

  const InstallOutcome.restartPending(String message)
      : this(InstallKind.restartPending, message);
  const InstallOutcome.handedOff(String message)
      : this(InstallKind.handedOff, message);
  const InstallOutcome.manual(String message)
      : this(InstallKind.manual, message);
  const InstallOutcome.failed(String message)
      : this(InstallKind.failed, message);
}

/// The platform half of [UpdateService]: where a download is staged, how it
/// gets installed, and how the app bows out so a swap can finish.
abstract class UpdateInstaller {
  /// The platform key used for asset selection ('android', 'windows',
  /// 'macos', 'linux', or 'unsupported' on web/anything else).
  static String get currentPlatform {
    if (kIsWeb) return 'unsupported';
    if (Platform.isAndroid) return 'android';
    if (Platform.isWindows) return 'windows';
    if (Platform.isMacOS) return 'macos';
    if (Platform.isLinux) return 'linux';
    return 'unsupported';
  }

  Future<Directory> stagingDir();
  Future<InstallOutcome> install(File artifact, UpdateRelease release);

  /// Exit so a staged swap can replace the files this process is running from.
  Future<void> quitForSwap();
}

/// Real installer: elevated (or user-tapped) `pm install` on Android, and a
/// detached swap script on the three desktops.
///
/// The desktop shape is the same everywhere and is the only shape that works:
/// a running binary cannot overwrite itself, so the update is unpacked
/// alongside the install, a small helper is launched *detached* from this
/// process, and it waits for our pid to die before copying the new files over
/// the old ones and relaunching. Nothing is touched until the user presses
/// Restart — and if the swap fails, the previous install is still the one on
/// disk, because the copy is the last thing that happens.
class PlatformUpdateInstaller implements UpdateInstaller {
  PlatformUpdateInstaller({
    MethodChannel? androidChannel,
    DeviceExec? exec,
    String? platform,
  })  : _channel = androidChannel ?? const MethodChannel('talon/update'),
        _exec = exec ?? DeviceExec(),
        _platform = platform ?? UpdateInstaller.currentPlatform;

  final MethodChannel _channel;
  final DeviceExec _exec;
  final String _platform;

  @override
  Future<Directory> stagingDir() async {
    if (_platform == 'android') {
      // App-external files dir: no permission needed, survives the install,
      // and — unlike /data/data — an elevated *shell* (Shizuku) can read it,
      // which the silent `pm install` path depends on.
      try {
        final path = await _channel.invokeMethod<String>('stageDir');
        if (path != null && path.isNotEmpty) return Directory(path);
      } catch (e) {
        AppLog.warn('update', 'no native staging dir, using temp', e);
      }
    }
    // A fresh, randomly named directory per download, never a fixed shared
    // path: `/tmp/talon-update` could be created in advance by another local
    // user, who would then own the directory the unpacked build and the swap
    // script sit in until Restart. Dart creates it 0777 & ~umask (other users
    // can list but not write it); narrow it to this user alone.
    final dir = await Directory.systemTemp.createTemp('talon-update-');
    if (!Platform.isWindows) {
      final chmod = await Process.run('chmod', ['700', dir.path]);
      if (chmod.exitCode != 0) {
        await dir.delete(recursive: true);
        throw FileSystemException(
          'could not make the update staging directory private',
          dir.path,
        );
      }
    }
    return dir;
  }

  @override
  Future<InstallOutcome> install(File artifact, UpdateRelease release) async {
    switch (_platform) {
      case 'android':
        return _installAndroid(artifact, release);
      case 'linux':
        return _installLinux(artifact);
      case 'windows':
        return _installWindows(artifact);
      case 'macos':
        return _installMacos(artifact);
      default:
        return const InstallOutcome.manual(
          'This build has no self-update path — grab the release from GitHub.',
        );
    }
  }

  @override
  Future<void> quitForSwap() async {
    // Give the UI one frame to paint "Restarting…" before the process dies.
    await Future<void>.delayed(const Duration(milliseconds: 150));
    if (!kIsWeb && Platform.isWindows) {
      try {
        await WindowsTray.instance.destroy();
      } catch (_) {}
    }
    exit(0);
  }

  // ── Android ───────────────────────────────────────────────────────────────

  /// Two paths, best first — both behind the signer check: the APK must be
  /// this package and carry this install's signing key, or nothing installs.
  ///
  /// With root or Shizuku the APK installs silently through the same pipeline
  /// the daemon's remote `update_device` uses — `pm install -r` keeps the data,
  /// refuses a differently-signed APK, and the mesh foreground service comes
  /// back on MY_PACKAGE_REPLACED, so the app restarts itself.
  ///
  /// Without elevation (the normal case) the file goes to Android's package
  /// installer, which needs "install unknown apps" for Talon and one tap on
  /// the system dialog. That permission is requested here rather than asked
  /// for up front, so an app that never self-updates never asks for it.
  Future<InstallOutcome> _installAndroid(
    File artifact,
    UpdateRelease release,
  ) async {
    final signer = await _checkApkSigner(artifact);
    if (signer != null) return signer;
    final silent = await _exec.installApk(
      artifact.path,
      sha256: release.sha256,
      delayMs: 2000,
    );
    if (silent.ok) {
      return const InstallOutcome.handedOff(
        'Installing now — Talon restarts itself in a few seconds.',
      );
    }
    AppLog.info('update', 'silent install unavailable: ${silent.message}');
    try {
      final allowed =
          await _channel.invokeMethod<bool>('canInstallPackages') ?? false;
      if (!allowed) {
        await _channel.invokeMethod<void>('requestInstallPermission');
        return const InstallOutcome.handedOff(
          'Allow Talon to install apps in the settings screen that just '
          'opened, then press Install update again.',
        );
      }
      final started = await _channel.invokeMethod<bool>('installApk', {
            'path': artifact.path,
          }) ??
          false;
      if (!started) {
        return const InstallOutcome.failed(
          "Android's package installer refused to open.",
        );
      }
      return const InstallOutcome.handedOff(
        'Tap Install on the system dialog to finish updating.',
      );
    } on MissingPluginException {
      return const InstallOutcome.manual(
        'This build cannot install updates itself — open the release page '
        'and install the APK.',
      );
    } catch (e) {
      return InstallOutcome.failed('Could not start the installer: $e');
    }
  }

  /// Self-update only: the downloaded APK must be this package, signed by the
  /// key this install runs under (UpdateBridge.checkSelfUpdateApk). Returns
  /// the refusal, or null to go ahead. The mesh's `install_apk` installs any
  /// app and deliberately does not go through this.
  Future<InstallOutcome?> _checkApkSigner(File artifact) async {
    try {
      final verdict = await _channel.invokeMapMethod<String, dynamic>(
        'checkSelfUpdateApk',
        {'path': artifact.path},
      );
      if (verdict?['ok'] == true) return null;
      return InstallOutcome.failed(
        '${verdict?['message'] ?? 'Could not check the update\'s signer.'} '
        'Nothing was installed.',
      );
    } on MissingPluginException {
      return const InstallOutcome.manual(
        'This build cannot install updates itself — open the release page '
        'and install the APK.',
      );
    } catch (e) {
      return InstallOutcome.failed(
        "Could not check the update's signer: $e. Nothing was installed.",
      );
    }
  }

  // ── Desktop ───────────────────────────────────────────────────────────────

  Future<InstallOutcome> _installLinux(File artifact) async {
    final installDir = Directory(File(Platform.resolvedExecutable).parent.path);
    final guard = await _writableOrManual(installDir);
    if (guard != null) return guard;
    final unpacked = await _freshDir(artifact.parent, 'new');
    final tar = await Process.run(
      'tar',
      ['-xzf', artifact.path, '-C', unpacked.path],
    );
    if (tar.exitCode != 0) {
      return InstallOutcome.failed(
        'Could not unpack the download: ${tar.stderr}'.trim(),
      );
    }
    final script = File('${artifact.parent.path}/talon-swap.sh');
    await script.writeAsString(
      unixSwapScript(
        pid: pid,
        sourceDir: unpacked.path,
        installDir: installDir.path,
        relaunch: Platform.resolvedExecutable,
        cleanupDir: artifact.parent.path,
      ),
    );
    await Process.start(
      '/bin/sh',
      [script.path],
      mode: ProcessStartMode.detached,
    );
    return const InstallOutcome.restartPending(
      'Update unpacked. Restart Talon to finish — it reopens on its own.',
    );
  }

  Future<InstallOutcome> _installWindows(File artifact) async {
    final installDir = Directory(File(Platform.resolvedExecutable).parent.path);
    final guard = await _writableOrManual(installDir);
    if (guard != null) return guard;
    final unpacked = await _freshDir(artifact.parent, 'new');
    var unpackedOk = false;
    try {
      final tar = await Process.run(
        'tar',
        ['-xf', artifact.path, '-C', unpacked.path],
      );
      if (tar.exitCode == 0) unpackedOk = true;
    } catch (_) {}

    if (!unpackedOk) {
      final expand = await Process.run('powershell', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        r"$ErrorActionPreference = 'Stop'; "
            "Expand-Archive -LiteralPath ${_psQuote(artifact.path)} "
            '-DestinationPath ${_psQuote(unpacked.path)} -Force',
      ]);
      if (expand.exitCode != 0) {
        return InstallOutcome.failed(
          'Could not unpack the download: ${expand.stderr}'.trim(),
        );
      }
    }
    final script = File('${artifact.parent.path}\\talon-swap.ps1');
    await script.writeAsString(
      windowsSwapScript(
        pid: pid,
        sourceDir: unpacked.path,
        installDir: installDir.path,
        relaunch: Platform.resolvedExecutable,
        cleanupDir: artifact.parent.path,
      ),
    );
    await Process.start(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        script.path,
      ],
      mode: ProcessStartMode.detached,
    );
    return const InstallOutcome.restartPending(
      'Update unpacked. Restart Talon to finish — it reopens on its own.',
    );
  }

  Future<InstallOutcome> _installMacos(File artifact) async {
    final bundle = macAppBundle(Platform.resolvedExecutable);
    if (bundle == null) {
      return const InstallOutcome.manual(
        'Talon is not running from an .app bundle, so it cannot replace '
        'itself — install the DMG by hand.',
      );
    }
    final guard = await _writableOrManual(Directory(bundle).parent);
    if (guard != null) return guard;
    final script = File('${artifact.parent.path}/talon-swap.sh');
    await script.writeAsString(
      macSwapScript(
        pid: pid,
        dmgPath: artifact.path,
        appBundle: bundle,
        cleanupDir: artifact.parent.path,
      ),
    );
    await Process.start(
      '/bin/sh',
      [script.path],
      mode: ProcessStartMode.detached,
    );
    return const InstallOutcome.restartPending(
      'Update ready. Restart Talon to finish — it reopens on its own.',
    );
  }

  /// A managed install (Homebrew, a .deb under /opt, Program Files without
  /// rights) must not be half-overwritten: say so instead, and leave the user
  /// with the release page.
  Future<InstallOutcome?> _writableOrManual(Directory dir) async {
    final probe = File(
      '${dir.path}${Platform.pathSeparator}.talon-update-probe',
    );
    try {
      await probe.writeAsString('ok', flush: true);
      await probe.delete();
      return null;
    } catch (_) {
      return InstallOutcome.manual(
        'Talon cannot write to ${dir.path}, so it cannot replace itself. '
        'Install the download from the release page instead.',
      );
    }
  }

  Future<Directory> _freshDir(Directory parent, String name) async {
    final dir = Directory('${parent.path}${Platform.pathSeparator}$name');
    if (await dir.exists()) await dir.delete(recursive: true);
    await dir.create(recursive: true);
    return dir;
  }

  // ── Swap scripts (pure, so they're testable without a release) ────────────

  /// POSIX helper: wait for the app to exit (bounded — never leave a script
  /// spinning forever on a wedged process), copy the new files over the
  /// install, clean up, relaunch.
  ///
  /// `cp -a src/. dest/` copies *into* dest rather than replacing it, which is
  /// what keeps the install path — and any desktop entry or dock pin that
  /// points at it — valid across the update.
  static String unixSwapScript({
    required int pid,
    required String sourceDir,
    required String installDir,
    required String relaunch,
    required String cleanupDir,
  }) =>
      '''
#!/bin/sh
# Talon companion self-update. Written by the app, run detached.
PID=$pid
i=0
while kill -0 "\$PID" 2>/dev/null; do
  i=\$((i + 1))
  [ "\$i" -gt 300 ] && exit 1
  sleep 0.2 2>/dev/null || sleep 1
done
cp -a ${_shQuote(sourceDir)}/. ${_shQuote(installDir)}/ || exit 1
rm -rf ${_shQuote(cleanupDir)}
exec ${_shQuote(relaunch)}
''';

  /// macOS helper: the DMG is mounted here rather than in the app, so the
  /// volume is never left attached if the user cancels the restart. `ditto`
  /// after an `rm -rf` is a true replace (a merge would leave stale
  /// frameworks behind), and the quarantine bit is cleared so the ad-hoc
  /// signed bundle opens without a second Gatekeeper prompt.
  static String macSwapScript({
    required int pid,
    required String dmgPath,
    required String appBundle,
    required String cleanupDir,
  }) =>
      '''
#!/bin/sh
# Talon companion self-update. Written by the app, run detached.
PID=$pid
i=0
while kill -0 "\$PID" 2>/dev/null; do
  i=\$((i + 1))
  [ "\$i" -gt 300 ] && exit 1
  sleep 0.2 2>/dev/null || sleep 1
done
MOUNT=\$(mktemp -d /tmp/talon-update.XXXXXX) || exit 1
hdiutil attach -nobrowse -quiet -mountpoint "\$MOUNT" ${_shQuote(dmgPath)} || exit 1
if [ -d "\$MOUNT/Talon.app" ]; then
  rm -rf ${_shQuote(appBundle)}
  ditto "\$MOUNT/Talon.app" ${_shQuote(appBundle)}
fi
hdiutil detach -quiet "\$MOUNT" || true
rmdir "\$MOUNT" 2>/dev/null
xattr -dr com.apple.quarantine ${_shQuote(appBundle)} 2>/dev/null
rm -rf ${_shQuote(cleanupDir)}
open ${_shQuote(appBundle)}
''';

  /// PowerShell helper: wait for the app to exit, mirror the unpacked files
  /// into the install directory (using robocopy to avoid PowerShell 5.1
  /// Copy-Item directory-nesting bugs and handle file locks), clean up, and
  /// relaunch with the install dir as working directory.
  static String windowsSwapScript({
    required int pid,
    required String sourceDir,
    required String installDir,
    required String relaunch,
    required String cleanupDir,
  }) =>
      '''
# Talon companion self-update. Written by the app, run detached.
\$ErrorActionPreference = 'Stop'
try { Wait-Process -Id $pid } catch { }
# Guard against Wait-Process exiting early or failing; ensure target process is truly dead
while (Get-Process -Id $pid -ErrorAction SilentlyContinue) {
  Start-Sleep -Milliseconds 500
}
# Short delay to allow Windows to release file locks on executables and DLLs
Start-Sleep -Seconds 1

\$src = ${_psQuote(sourceDir)}
\$dest = ${_psQuote(installDir)}

# Prefer robocopy to mirror the directory cleanly without PowerShell 5.1 Copy-Item nesting bugs
if (Get-Command robocopy -ErrorAction SilentlyContinue) {
  & robocopy \$src \$dest /E /R:10 /W:1 /NP /NFL /NDL | Out-Null
  if (\$LASTEXITCODE -ge 8) { exit \$LASTEXITCODE }
} else {
  # Fallback: copy items safely
  Get-ChildItem -Path \$src -Recurse | ForEach-Object {
    \$rel = \$_.FullName.Substring(\$src.Length).TrimStart('\\', '/')
    \$targetPath = Join-Path \$dest \$rel
    if (\$_.PSIsContainer) {
      if (!(Test-Path \$targetPath)) { New-Item -ItemType Directory -Path \$targetPath -Force | Out-Null }
    } else {
      Copy-Item -LiteralPath \$_.FullName -Destination \$targetPath -Force
    }
  }
}

Remove-Item -Path ${_psQuote(cleanupDir)} -Recurse -Force -ErrorAction SilentlyContinue
Start-Process -FilePath ${_psQuote(relaunch)} -WorkingDirectory \$dest
''';

  /// `/Applications/Talon.app/Contents/MacOS/Talon` → `/Applications/Talon.app`
  /// (null when the executable isn't inside a bundle, e.g. `flutter run`).
  static String? macAppBundle(String executablePath) {
    // Literal '/' rather than the host separator: this shape is macOS's, and
    // the function is unit-tested from whatever machine runs the suite.
    const marker = '.app/Contents/MacOS/';
    final at = executablePath.indexOf(marker);
    if (at < 0) return null;
    return executablePath.substring(0, at + 4);
  }

  static String _shQuote(String s) => "'${s.replaceAll("'", "'\\''")}'";

  static String _psQuote(String s) => "'${s.replaceAll("'", "''")}'";
}
