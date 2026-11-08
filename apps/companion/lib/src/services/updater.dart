import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';

import 'log.dart';
import 'prefs.dart';
import 'sandbox.dart';
import 'update_installer.dart';

/// Where releases come from: Talon's own GitHub releases. The feed is the
/// recent-releases list rather than `/releases/latest`: the newest release
/// is published before its companion builds finish (and a build can fail),
/// so `latest` alone would read "up to date" while an older release still
/// carries a newer artifact for this platform. Drafts and pre-releases are
/// skipped, so a tagged release-please build is the only thing the app will
/// ever offer to install.
const String kUpdateFeedUrl =
    'https://api.github.com/repos/thefalconry/talon/releases?per_page=15';

/// Human-facing releases page, for the "download it yourself" escape hatch
/// (a managed install the app can't overwrite, or an unsupported platform).
const String kReleasesPageUrl = 'https://github.com/thefalconry/talon/releases';

/// A bare lowercase SHA-256 hex digest, as published in an asset's `digest`.
final RegExp _sha256Hex = RegExp(r'^[0-9a-f]{64}$');

/// A semantic version, ordered the way semver orders: numerically by
/// major/minor/patch, with any pre-release suffix sorting *below* the release
/// it leads to (4.2.0-rc.1 < 4.2.0).
///
/// Parsing is forgiving about the two shapes this app actually meets — the
/// release tag (`v4.1.0`) and Flutter's own version string
/// (`4.1.0+401000`) — because the build number is derived from the same
/// semver upstream and so never decides an ordering.
@immutable
class AppVersion implements Comparable<AppVersion> {
  final int major;
  final int minor;
  final int patch;

  /// The pre-release identifiers (`rc.1` → `['rc', '1']`), empty for a
  /// stable release.
  final List<String> preRelease;

  const AppVersion(
    this.major,
    this.minor,
    this.patch, [
    this.preRelease = const [],
  ]);

  static AppVersion? tryParse(String raw) {
    var s = raw.trim();
    if (s.isEmpty) return null;
    if (s.startsWith('v') || s.startsWith('V')) s = s.substring(1);
    // Drop Flutter's +buildNumber and any build metadata.
    final plus = s.indexOf('+');
    if (plus >= 0) s = s.substring(0, plus);
    var pre = const <String>[];
    final dash = s.indexOf('-');
    if (dash >= 0) {
      final tail = s.substring(dash + 1);
      if (tail.isEmpty) return null;
      pre = tail.split('.');
      s = s.substring(0, dash);
    }
    final parts = s.split('.');
    if (parts.isEmpty || parts.length > 3) return null;
    final nums = <int>[];
    for (final p in parts) {
      final n = int.tryParse(p);
      if (n == null || n < 0) return null;
      nums.add(n);
    }
    while (nums.length < 3) {
      nums.add(0);
    }
    return AppVersion(nums[0], nums[1], nums[2], pre);
  }

  bool get isPreRelease => preRelease.isNotEmpty;

  @override
  int compareTo(AppVersion other) {
    if (major != other.major) return major.compareTo(other.major);
    if (minor != other.minor) return minor.compareTo(other.minor);
    if (patch != other.patch) return patch.compareTo(other.patch);
    // A release outranks any pre-release of the same number.
    if (preRelease.isEmpty) return other.preRelease.isEmpty ? 0 : 1;
    if (other.preRelease.isEmpty) return -1;
    for (var i = 0; i < preRelease.length && i < other.preRelease.length; i++) {
      final a = preRelease[i];
      final b = other.preRelease[i];
      final an = int.tryParse(a);
      final bn = int.tryParse(b);
      final cmp =
          (an != null && bn != null) ? an.compareTo(bn) : a.compareTo(b);
      if (cmp != 0) return cmp;
    }
    return preRelease.length.compareTo(other.preRelease.length);
  }

  bool operator >(AppVersion other) => compareTo(other) > 0;
  bool operator <(AppVersion other) => compareTo(other) < 0;
  bool operator >=(AppVersion other) => compareTo(other) >= 0;
  bool operator <=(AppVersion other) => compareTo(other) <= 0;

  @override
  bool operator ==(Object other) =>
      other is AppVersion &&
      major == other.major &&
      minor == other.minor &&
      patch == other.patch &&
      preRelease.join('.') == other.preRelease.join('.');

  @override
  int get hashCode => Object.hash(major, minor, patch, preRelease.join('.'));

  @override
  String toString() => [
        '$major.$minor.$patch',
        if (preRelease.isNotEmpty) '-${preRelease.join('.')}',
      ].join();
}

/// One installable release: the version, the notes to show, and the single
/// asset that matches the platform the app is running on.
@immutable
class UpdateRelease {
  final AppVersion version;
  final String tag;
  final String notes;
  final String pageUrl;
  final String assetName;
  final String assetUrl;
  final int assetSize;

  /// Lowercase hex SHA-256 of the asset, when the release API published one
  /// (`digest: "sha256:…"`). Verified before the bytes are ever handed to an
  /// installer. A release without one is offered but never installed: there
  /// is nothing to check the download against.
  final String? sha256;

  const UpdateRelease({
    required this.version,
    required this.tag,
    required this.notes,
    required this.pageUrl,
    required this.assetName,
    required this.assetUrl,
    required this.assetSize,
    this.sha256,
  });

  /// The release asset this platform installs. The names are fixed by the
  /// companion workflow's packaging step — keep the two in step.
  static String? assetNameFor(String platform, [String? version]) {
    final v = (version != null && version.isNotEmpty) ? '-$version' : '';
    return switch (platform) {
      'android' => 'talon-companion-android$v.apk',
      'windows' => 'talon-companion-windows$v.zip',
      'macos' => 'talon-companion-macos$v.dmg',
      'linux' => 'talon-companion-linux$v.tar.gz',
      _ => null,
    };
  }

  /// The newest installable release in a feed payload: either a single
  /// release object (`/releases/latest`) or a list of them (`/releases`).
  /// Drafts, pre-releases and releases with no artifact for [platform] are
  /// skipped, so a release whose companion build is still running (or
  /// failed) falls back to the newest one that has something to install.
  static UpdateRelease? newestFromFeed(
    Object? decoded, {
    required String platform,
  }) {
    final items = decoded is List ? decoded : [decoded];
    UpdateRelease? best;
    for (final raw in items) {
      if (raw is! Map) continue;
      final json = raw.cast<String, dynamic>();
      if (json['draft'] == true || json['prerelease'] == true) continue;
      final release = fromFeedJson(json, platform: platform);
      if (release == null) continue;
      if (best == null || release.version > best.version) best = release;
    }
    return best;
  }

  /// Parse a GitHub `releases/latest` payload. Returns null when the payload
  /// is unusable (no parseable tag, or no asset for this platform — e.g. a
  /// release whose companion build failed, which must read as "nothing to
  /// install" rather than an error the user can act on).
  static UpdateRelease? fromFeedJson(
    Map<String, dynamic> json, {
    required String platform,
  }) {
    final tag = '${json['tag_name'] ?? ''}';
    final version = AppVersion.tryParse(tag);
    if (version == null) return null;
    if (assetNameFor(platform) == null) return null;
    final assets = json['assets'];
    if (assets is! List) return null;

    final bareVersion =
        (tag.startsWith('v') || tag.startsWith('V')) ? tag.substring(1) : tag;
    final candidates = {
      if (bareVersion.isNotEmpty) assetNameFor(platform, bareVersion),
      assetNameFor(platform, tag),
      assetNameFor(platform),
    }.whereType<String>().toSet();

    for (final raw in assets) {
      if (raw is! Map) continue;
      final asset = raw.cast<String, dynamic>();
      final name = '${asset['name'] ?? ''}';
      if (!candidates.contains(name)) continue;
      final url = '${asset['browser_download_url'] ?? ''}';
      if (url.isEmpty) continue;
      final digest = '${asset['digest'] ?? ''}'.toLowerCase();
      final hex = digest.startsWith('sha256:') ? digest.substring(7) : '';
      return UpdateRelease(
        version: version,
        tag: tag,
        notes: '${json['body'] ?? ''}',
        pageUrl: '${json['html_url'] ?? kReleasesPageUrl}',
        assetName: name,
        assetUrl: url,
        assetSize: (asset['size'] is num) ? (asset['size'] as num).toInt() : 0,
        sha256: _sha256Hex.hasMatch(hex) ? hex : null,
      );
    }
    return null;
  }
}

/// Where the updater is in its cycle. The UI renders straight off this.
enum UpdatePhase {
  /// Nothing known yet, or an offer the user dismissed.
  idle,
  checking,
  upToDate,

  /// A newer release exists and is waiting for the user to start it.
  available,
  downloading,
  verifying,

  /// Handing the artifact to the platform (pm install / swap script).
  installing,

  /// Everything is staged: the app has to exit for the swap to complete.
  restartPending,

  /// Handed off to something outside the app (Android's package installer,
  /// or the browser for a manual download).
  handedOff,
  error,
}

/// The companion's self-updater: checks Talon's GitHub releases, downloads the
/// asset for this platform, verifies it, and hands it to [UpdateInstaller].
///
/// Deliberately *offered*, not silent. A background check runs on launch and
/// every [checkInterval] after, but nothing is downloaded or installed until
/// the user asks — an app that swaps itself under a live conversation (or over
/// a phone's mobile data, given the APK is ~60 MB) would be the wrong kind of
/// automatic. "Auto" here means the app notices; the user decides.
///
/// Everything with a platform edge is injectable so the whole cycle is
/// testable off-device: the HTTP client, the installer, the version provider,
/// the platform string and the clock.
class UpdateService extends ChangeNotifier {
  UpdateService({
    required this.prefs,
    http.Client? client,
    UpdateInstaller? installer,
    Future<String> Function()? versionProvider,
    String? platform,
    String feedUrl = kUpdateFeedUrl,
    DateTime Function()? clock,
    bool? flatpak,
  })  : _client = client ?? http.Client(),
        _installer = installer ?? PlatformUpdateInstaller(),
        _versionProvider = versionProvider ?? _packageVersion,
        platform = platform ?? UpdateInstaller.currentPlatform,
        _feedUrl = feedUrl,
        _now = clock ?? DateTime.now,
        managedByFlatpak = flatpak ?? isFlatpak;

  /// How stale a check may get before the next launch/tick refreshes it.
  static const Duration checkInterval = Duration(hours: 6);

  /// GitHub's unauthenticated API allows 60 requests/hour per IP; one probe
  /// every six hours is nowhere near it, and this timeout keeps a dead
  /// network from leaving the card spinning.
  static const Duration _timeout = Duration(seconds: 20);

  final Prefs prefs;
  final http.Client _client;
  final UpdateInstaller _installer;
  final Future<String> Function() _versionProvider;
  final String platform;
  final String _feedUrl;
  final DateTime Function() _now;

  /// Installed from Flathub: the app dir is read-only and `flatpak update`
  /// owns upgrades, so the self-updater stays completely idle — no checks,
  /// no downloads — and the card says who manages updates instead.
  final bool managedByFlatpak;

  Timer? _timer;
  bool _disposed = false;
  bool _cancelRequested = false;

  UpdatePhase _phase = UpdatePhase.idle;
  UpdatePhase get phase => _phase;

  UpdateRelease? _release;

  /// An already downloaded and verified artifact, staged and ready to install
  /// without re-downloading.
  File? _stagedArtifact;

  /// Whether an already downloaded and checksum-verified artifact is staged
  /// and ready to install directly without re-downloading.
  bool get canInstallStaged =>
      _stagedArtifact != null &&
      _stagedArtifact!.existsSync() &&
      _release != null &&
      !busy;

  /// The release on offer — null unless [phase] is available/downloading/
  /// verifying/installing/restartPending/handedOff.
  UpdateRelease? get release => _release;

  String? _error;
  String? get error => _error;

  String? _message;

  /// Last human-facing note from an installer (what to do next, mostly).
  String? get message => _message;

  AppVersion? _current;
  AppVersion? get currentVersion => _current;

  int _received = 0;
  int _total = 0;
  int get receivedBytes => _received;
  int get totalBytes => _total;

  /// Download progress 0..1, or null while the size is unknown.
  double? get progress =>
      _total > 0 ? (_received / _total).clamp(0.0, 1.0) : null;

  DateTime? get lastCheckedAt => prefs.updateLastCheckedAt;

  bool get autoCheck => prefs.autoUpdateCheck;

  /// Whether this build can update itself at all. Everything else in the card
  /// stays visible either way — an unsupported platform still gets the version
  /// readout and the link to the releases page.
  bool get supported =>
      !managedByFlatpak && UpdateRelease.assetNameFor(platform) != null;

  bool get busy =>
      _phase == UpdatePhase.checking ||
      _phase == UpdatePhase.downloading ||
      _phase == UpdatePhase.verifying ||
      _phase == UpdatePhase.installing;

  /// An offer the user has not started or skipped.
  bool get updateAvailable => _phase == UpdatePhase.available;

  static Future<String> _packageVersion() async {
    final info = await PackageInfo.fromPlatform();
    return info.version;
  }

  /// Resolve this build's version and, when auto-checking is on, run a check
  /// if the last one has gone stale. Safe to call more than once.
  ///
  /// Called once from `main` — deliberately NOT from the Settings card, so
  /// opening Settings never starts a timer or a request of its own.
  Future<void> start() async {
    await loadVersion();
    if (!supported) return;
    _timer?.cancel();
    _timer = Timer.periodic(checkInterval, (_) {
      if (autoCheck) unawaited(check());
    });
    if (autoCheck) await check();
  }

  /// Read the running build's version (for the card's readout). Cheap,
  /// cached, and safe anywhere — it touches no network.
  Future<void> loadVersion() async {
    if (_current != null) return;
    try {
      _current = AppVersion.tryParse(await _versionProvider());
      _notify();
    } catch (e) {
      AppLog.warn('update', 'could not read the running version', e);
    }
  }

  /// Toggle the periodic check. Turning it on runs one immediately so the
  /// switch has a visible consequence.
  Future<void> setAutoCheck(bool value) async {
    await prefs.setAutoUpdateCheck(value);
    _notify();
    if (value) await check();
  }

  /// Ask GitHub what the newest release is.
  ///
  /// [force] is the "Check now" button: it ignores both the freshness window
  /// and a version the user previously skipped. A scheduled call does neither.
  Future<UpdateRelease?> check({bool force = false}) async {
    if (busy) return _release;
    if (!supported) return null;
    await loadVersion();
    if (!force) {
      final last = prefs.updateLastCheckedAt;
      if (last != null && _now().difference(last) < checkInterval) {
        return _release;
      }
    }
    _error = null;
    _setPhase(UpdatePhase.checking);
    try {
      final resp = await _client.get(
        Uri.parse(_feedUrl),
        headers: const {
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'talon-companion',
        },
      ).timeout(_timeout);
      if (resp.statusCode != 200) {
        throw HttpException('release feed returned ${resp.statusCode}');
      }
      final decoded = jsonDecode(resp.body);
      if (decoded is! Map && decoded is! List) {
        throw const FormatException('unexpected feed shape');
      }
      await prefs.setUpdateLastCheckedAt(_now());
      final latest = UpdateRelease.newestFromFeed(decoded, platform: platform);
      final current = _current;
      if (latest == null || current == null || latest.version <= current) {
        _release = null;
        _setPhase(UpdatePhase.upToDate);
        return null;
      }
      if (!force && prefs.skippedUpdateVersion == latest.version.toString()) {
        AppLog.info('update', 'v${latest.version} available but skipped');
        _release = null;
        _setPhase(UpdatePhase.upToDate);
        return null;
      }
      AppLog.info('update', 'v${latest.version} available (running $current)');
      _release = latest;
      _setPhase(UpdatePhase.available);
      return latest;
    } catch (e) {
      AppLog.warn('update', 'check failed', e);
      _error = _friendly(e);
      _setPhase(UpdatePhase.error);
      return null;
    }
  }

  /// Download the offered asset, verify it, and hand it to the installer.
  Future<void> downloadAndInstall() async {
    final rel = _release;
    if (rel == null || busy || !supported) return;
    _cancelRequested = false;
    _error = null;
    _message = null;
    final expected = rel.sha256;
    if (expected == null) {
      // No digest, no install: the length alone can't tell a tampered or
      // swapped asset from the real one. Refuse before downloading anything.
      _error = 'This release publishes no SHA-256 checksum for '
          '${rel.assetName}, so the download could not be verified. Nothing '
          'was installed — get it from the release page instead.';
      _setPhase(UpdatePhase.error);
      return;
    }

    final dir = await _installer.stagingDir();
    await dir.create(recursive: true);
    final potential =
        File('${dir.path}${Platform.pathSeparator}${rel.assetName}');
    if (await potential.exists()) {
      try {
        final size = await potential.length();
        if (rel.assetSize <= 0 || size == rel.assetSize) {
          final digest = await sha256.bind(potential.openRead()).first;
          if (digest.toString().toLowerCase() == expected) {
            _stagedArtifact = potential;
            await installStaged();
            return;
          }
        }
      } catch (_) {}
    }

    _received = 0;
    _total = rel.assetSize;
    _setPhase(UpdatePhase.downloading);
    File? artifact;
    try {
      artifact = potential;
      _stagedArtifact = null;
      if (await artifact.exists()) await artifact.delete();

      final request = http.Request('GET', Uri.parse(rel.assetUrl))
        ..headers['Accept'] = 'application/octet-stream'
        ..headers['User-Agent'] = 'talon-companion';
      final resp = await _client.send(request).timeout(_timeout);
      if (resp.statusCode != 200) {
        throw HttpException('download returned ${resp.statusCode}');
      }
      if (resp.contentLength != null && resp.contentLength! > 0) {
        _total = resp.contentLength!;
      }
      final sink = artifact.openWrite();
      try {
        await for (final chunk in resp.stream) {
          if (_cancelRequested) break;
          sink.add(chunk);
          _received += chunk.length;
          _notify();
        }
      } finally {
        await sink.close();
      }
      if (_cancelRequested) {
        await _safeDelete(artifact);
        _stagedArtifact = null;
        _setPhase(UpdatePhase.available);
        return;
      }

      _setPhase(UpdatePhase.verifying);
      final size = await artifact.length();
      if (rel.assetSize > 0 && size != rel.assetSize) {
        throw const FormatException(
          'the download is the wrong size — it was cut short',
        );
      }
      final digest = await sha256.bind(artifact.openRead()).first;
      if (digest.toString().toLowerCase() != expected) {
        throw const FormatException(
          'the download failed its checksum — nothing was installed',
        );
      }

      _stagedArtifact = artifact;
      _setPhase(UpdatePhase.installing);
      final outcome = await _installer.install(artifact, rel);
      _message = outcome.message;
      switch (outcome.kind) {
        case InstallKind.restartPending:
          _setPhase(UpdatePhase.restartPending);
        case InstallKind.handedOff:
          _setPhase(UpdatePhase.handedOff);
        case InstallKind.manual:
          await _safeDelete(artifact);
          _stagedArtifact = null;
          _error = outcome.message;
          _setPhase(UpdatePhase.handedOff);
        case InstallKind.failed:
          // Keep staged artifact on installer failure (e.g. Samsung Auto
          // Blocker or missing permissions) so user can retry directly.
          _error = outcome.message;
          _setPhase(UpdatePhase.error);
      }
    } catch (e) {
      AppLog.error('update', 'install failed', e);
      // A download that never verified (cut short, bad checksum) is deleted,
      // never left to be retried; only a verified artifact stays staged.
      if (artifact != null && _stagedArtifact == null) {
        await _safeDelete(artifact);
      }
      _error = _friendly(e);
      _setPhase(UpdatePhase.error);
    }
  }

  /// Retry installing the already-downloaded and verified artifact without
  /// downloading it again.
  Future<void> installStaged() async {
    final rel = _release;
    final artifact = _stagedArtifact;
    if (rel == null ||
        artifact == null ||
        !artifact.existsSync() ||
        busy ||
        !supported) {
      return;
    }
    _cancelRequested = false;
    _error = null;
    _message = null;
    try {
      _setPhase(UpdatePhase.installing);
      final outcome = await _installer.install(artifact, rel);
      _message = outcome.message;
      switch (outcome.kind) {
        case InstallKind.restartPending:
          _setPhase(UpdatePhase.restartPending);
        case InstallKind.handedOff:
          _setPhase(UpdatePhase.handedOff);
        case InstallKind.manual:
          await _safeDelete(artifact);
          _stagedArtifact = null;
          _error = outcome.message;
          _setPhase(UpdatePhase.handedOff);
        case InstallKind.failed:
          _error = outcome.message;
          _setPhase(UpdatePhase.error);
      }
    } catch (e) {
      AppLog.error('update', 'staged install failed', e);
      _error = _friendly(e);
      _setPhase(UpdatePhase.error);
    }
  }

  /// Stop an in-flight download (the partial file is removed).
  void cancel() {
    if (_phase == UpdatePhase.downloading) _cancelRequested = true;
  }

  /// Quit so the staged swap can replace the running install. Desktop only —
  /// the helper script is already waiting on this process to exit.
  Future<void> applyAndRestart() async {
    if (_phase != UpdatePhase.restartPending) return;
    await _installer.quitForSwap();
  }

  /// Don't offer this version again (a later one still gets offered).
  Future<void> skipCurrentRelease() async {
    final rel = _release;
    if (rel == null) return;
    if (_stagedArtifact != null) {
      await _safeDelete(_stagedArtifact!);
      _stagedArtifact = null;
    }
    await prefs.setSkippedUpdateVersion(rel.version.toString());
    _release = null;
    _setPhase(UpdatePhase.upToDate);
  }

  /// Clear a transient result (error / up-to-date) back to a neutral card.
  void dismiss() {
    if (_phase == UpdatePhase.error || _phase == UpdatePhase.upToDate) {
      _error = null;
      _setPhase(UpdatePhase.idle);
    }
  }

  Future<void> _safeDelete(File f) async {
    try {
      if (await f.exists()) await f.delete();
    } catch (_) {
      // A leftover in the staging dir is harmless; it's overwritten next time.
    }
  }

  static String _friendly(Object e) => switch (e) {
        SocketException _ => 'No connection to github.com.',
        TimeoutException _ => 'The update server took too long to answer.',
        HttpException(:final message) => 'Update failed: $message.',
        FormatException(:final message) => message,
        _ => '$e',
      };

  void _setPhase(UpdatePhase p) {
    _phase = p;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _client.close();
    super.dispose();
  }
}
