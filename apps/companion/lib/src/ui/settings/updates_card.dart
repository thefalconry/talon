import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../services/updater.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import 'settings_widgets.dart';

/// Settings card for the self-updater: what's running, what's available, and
/// the one button that moves it forward.
///
/// It listens to [UpdateService] rather than holding update state of its own —
/// a check started here and a check started by the six-hourly timer paint
/// identically, and closing Settings mid-download doesn't lose the download.
class UpdatesCard extends StatefulWidget {
  final AppState state;

  /// Override the service under test; production always uses the app's own.
  final UpdateService? service;
  const UpdatesCard({super.key, required this.state, this.service});

  @override
  State<UpdatesCard> createState() => _UpdatesCardState();
}

class _UpdatesCardState extends State<UpdatesCard> {
  UpdateService get _svc => widget.service ?? widget.state.updates;
  bool _notesExpanded = false;

  @override
  void initState() {
    super.initState();
    _svc.addListener(_onChange);
    // Only the version readout. The periodic check belongs to the app's
    // lifetime (started in main), not to this screen being open — so opening
    // Settings never fires a request or leaves a timer behind it.
    _svc.loadVersion();
  }

  @override
  void dispose() {
    _svc.removeListener(_onChange);
    super.dispose();
  }

  void _onChange() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final svc = _svc;
    return SettingsSection(
      title: 'Updates',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          infoRow('Running', 'v${svc.currentVersion ?? '—'}'),
          infoRow('Last checked', _lastChecked(svc.lastCheckedAt)),
          const SizedBox(height: 6),
          _statusBlock(svc),
          const SizedBox(height: 4),
          if (!svc.managedByFlatpak)
            settingsSwitchRow(
              'Check automatically',
              'Look for a new release on launch and every six hours. Nothing '
                  'downloads until you say so.',
              svc.autoCheck,
              svc.busy ? null : (v) => svc.setAutoCheck(v),
            ),
          const SizedBox(height: 6),
          Row(
            children: [
              TextButton.icon(
                onPressed: svc.busy || !svc.supported
                    ? null
                    : () => svc.check(force: true),
                icon: const Icon(Icons.refresh, size: 17),
                label: const Text('Check now'),
              ),
              const Spacer(),
              TextButton(
                onPressed: () =>
                    _open(svc.release?.pageUrl ?? kReleasesPageUrl),
                child: const Text('Releases'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// The one part of the card that changes shape: a status line for the quiet
  /// states, and a bordered panel once there's something to act on.
  Widget _statusBlock(UpdateService svc) {
    if (svc.managedByFlatpak) {
      return healthRow(
        SettingsHealth.info,
        'Updates are managed by Flatpak',
        'Update Talon from your software centre, or run "flatpak update".',
      );
    }
    if (!svc.supported) {
      return healthRow(
        SettingsHealth.info,
        'Updates',
        'This platform installs updates from the releases page.',
      );
    }
    final rel = svc.release;
    switch (svc.phase) {
      case UpdatePhase.checking:
        return _busyRow('Checking for updates…');
      case UpdatePhase.idle:
        return healthRow(
          SettingsHealth.info,
          'Updates',
          svc.autoCheck
              ? 'Talon will tell you when a new release lands.'
              : 'Automatic checks are off — check manually below.',
        );
      case UpdatePhase.upToDate:
        return healthRow(
          SettingsHealth.ok,
          'Up to date',
          'v${svc.currentVersion ?? ''} is the newest release.',
        );
      case UpdatePhase.error:
        if (svc.canInstallStaged) {
          return _panel(
            icon: Icons.error_outline,
            title: 'Installation paused',
            body: svc.error ?? 'Permission or installer error occurred.',
            actions: [
              FilledButton.icon(
                onPressed: svc.installStaged,
                icon: const Icon(Icons.install_mobile, size: 17),
                label: const Text('Retry install'),
              ),
              TextButton(
                onPressed: () => svc.check(force: true),
                child: const Text('Check updates'),
              ),
            ],
          );
        }
        return healthRow(
          SettingsHealth.warn,
          'Check failed',
          svc.error ?? 'Something went wrong.',
        );
      case UpdatePhase.available:
        return _offerPanel(svc, rel!);
      case UpdatePhase.downloading:
        return _progressPanel(
          svc,
          'Downloading v${rel?.version ?? ''}',
          '${_mb(svc.receivedBytes)} of ${_mb(svc.totalBytes)}',
          svc.progress,
          onCancel: svc.cancel,
        );
      case UpdatePhase.verifying:
        return _progressPanel(svc, 'Verifying the download', '', null);
      case UpdatePhase.installing:
        return _progressPanel(svc, 'Installing', '', null);
      case UpdatePhase.restartPending:
        return _panel(
          icon: Icons.restart_alt,
          title: 'v${rel?.version ?? ''} is ready',
          body:
              svc.message ?? 'Restart Talon to finish — it reopens on its own.',
          actions: [
            FilledButton(
              onPressed: svc.applyAndRestart,
              child: const Text('Restart now'),
            ),
          ],
        );
      case UpdatePhase.handedOff:
        return _panel(
          icon: Icons.open_in_new,
          title: svc.error == null ? 'Almost there' : 'Finish it yourself',
          body: svc.error ?? svc.message ?? 'Handed off to the installer.',
          actions: [
            if (svc.canInstallStaged)
              FilledButton.icon(
                onPressed: svc.installStaged,
                icon: const Icon(Icons.install_mobile, size: 17),
                label: const Text('Retry install'),
              ),
            if (svc.error != null)
              TextButton(
                onPressed: () => _open(rel?.pageUrl ?? kReleasesPageUrl),
                child: const Text('Open release'),
              ),
          ],
        );
    }
  }

  Widget _offerPanel(UpdateService svc, UpdateRelease rel) {
    final notes = rel.notes.trim();
    final short = notes.length > 400 && !_notesExpanded
        ? '${notes.substring(0, 400).trimRight()}…'
        : notes;
    return _panel(
      icon: Icons.system_update_alt,
      title: 'Talon v${rel.version} is available',
      body: '${_mb(rel.assetSize)} · ${rel.assetName}',
      extra: notes.isEmpty
          ? null
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  short,
                  style: TextStyle(
                    fontSize: 12.5,
                    height: 1.4,
                    color: TalonColors.textDim,
                  ),
                ),
                if (notes.length > 400)
                  TextButton(
                    onPressed: () =>
                        setState(() => _notesExpanded = !_notesExpanded),
                    child: Text(_notesExpanded ? 'Show less' : 'Show more'),
                  ),
              ],
            ),
      actions: [
        FilledButton.icon(
          onPressed: svc.downloadAndInstall,
          icon: const Icon(Icons.download, size: 17),
          label: const Text('Download & install'),
        ),
        TextButton(
          onPressed: svc.skipCurrentRelease,
          child: const Text('Skip'),
        ),
      ],
    );
  }

  Widget _progressPanel(
    UpdateService svc,
    String title,
    String body,
    double? value, {
    VoidCallback? onCancel,
  }) {
    return _panel(
      icon: Icons.downloading,
      title: title,
      body: body,
      extra: ClipRRect(
        borderRadius: BorderRadius.circular(4),
        child: LinearProgressIndicator(value: value, minHeight: 6),
      ),
      actions: [
        if (onCancel != null)
          TextButton(onPressed: onCancel, child: const Text('Cancel')),
      ],
    );
  }

  Widget _busyRow(String label) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            const SizedBox(width: 12),
            Text(
              label,
              style: TextStyle(fontSize: 13, color: TalonColors.textDim),
            ),
          ],
        ),
      );

  Widget _panel({
    required IconData icon,
    required String title,
    required String body,
    Widget? extra,
    List<Widget> actions = const [],
  }) {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: TalonColors.accent.withValues(alpha: 0.06),
        borderRadius: TalonRadius.rMd,
        border: Border.all(color: TalonColors.accent.withValues(alpha: 0.28)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, size: 18, color: TalonColors.accent),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    if (body.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(
                        body,
                        style: TextStyle(
                          fontSize: 12.5,
                          height: 1.35,
                          color: TalonColors.textDim,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
          if (extra != null) ...[const SizedBox(height: 10), extra],
          if (actions.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(spacing: 8, runSpacing: 4, children: actions),
          ],
        ],
      ),
    );
  }

  Future<void> _open(String url) async {
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  static String _lastChecked(DateTime? at) {
    if (at == null) return 'Never';
    final d = DateTime.now().difference(at);
    if (d.inMinutes < 1) return 'Just now';
    if (d.inMinutes < 60) return '${d.inMinutes} min ago';
    if (d.inHours < 24) return '${d.inHours} h ago';
    return '${d.inDays} d ago';
  }

  static String _mb(int bytes) =>
      bytes <= 0 ? '—' : '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}
