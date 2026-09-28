/// This device's mesh membership: location sharing, periodic reporting,
/// device control and its Android privilege ladder, desktop start-at-login,
/// and the registered device list. The switches are all prefs-backed and
/// about *this* machine; the ladder is read from the platform bridges.
library;

import 'dart:async';

import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../models/bridge_models.dart';
import '../../services/autostart.dart';
import '../../services/device_exec.dart';
import '../../services/log.dart';
import '../../services/mesh_background.dart';
import '../../services/mesh_service.dart';
import '../../services/prefs.dart';
import '../../services/sandbox.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import 'settings_widgets.dart';

class MeshCard extends StatefulWidget {
  final AppState state;
  const MeshCard({super.key, required this.state});

  @override
  State<MeshCard> createState() => _MeshCardState();
}

class _MeshCardState extends State<MeshCard> {
  /// Desktop start-at-login state (null = unknown/loading). Read from the OS
  /// on open, reconciled after every flip (the OS is the source of truth).
  bool? _autostart;
  bool _autostartBusy = false;

  /// Android's execution-privilege ladder for device control (root → Shizuku →
  /// app UID). Read from the platform bridges, not from prefs — the tier is a
  /// property of the device, not a setting. Its own executor rather than the
  /// mesh service's: the channels are process-wide, so a grant obtained here
  /// is the same grant the background mesh isolate then uses.
  final DeviceExec _exec = DeviceExec();
  Map<String, dynamic>? _rootInfo;
  Map<String, String>? _privilege;
  bool _rootBusy = false;

  /// Android only — every other platform runs commands as the logged-in user
  /// and has no ladder to show.
  bool get _showsPrivilege => defaultTargetPlatform == TargetPlatform.android;

  @override
  void initState() {
    super.initState();
    if (Autostart.isSupported) {
      Autostart.isEnabled().then((v) {
        if (mounted) setState(() => _autostart = v);
      });
    }
    if (_showsPrivilege) unawaited(_refreshPrivilege());
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _setAutostart(bool v) async {
    if (_autostartBusy) return;
    setState(() {
      _autostartBusy = true;
      _autostart = v; // optimistic; reconciled below
    });
    final actual = await Autostart.setEnabled(v);
    if (!mounted) return;
    setState(() {
      _autostart = actual;
      _autostartBusy = false;
    });
    if (actual != v) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            v
                ? 'Could not enable start at login (check System Settings → Login Items)'
                : 'Could not disable start at login',
          ),
        ),
      );
    }
  }

  /// Re-read the privilege ladder. [probe] `true` actually *tries* to take
  /// root (spawning `su`, which raises the root manager's grant dialog), so it
  /// is only ever passed from the explicit button — opening Settings must not
  /// pop a root prompt.
  Future<void> _refreshPrivilege({bool probe = false}) async {
    if (!_showsPrivilege) return;
    if (probe) setState(() => _rootBusy = true);
    try {
      final root = await _exec.rootStatus(probe: probe);
      final privilege = await _exec.privilegeStatus();
      if (!mounted) return;
      setState(() {
        _rootInfo = root;
        _privilege = privilege;
      });
    } catch (e) {
      AppLog.warn('settings', 'privilege refresh failed', e);
    } finally {
      if (mounted && probe) setState(() => _rootBusy = false);
    }
  }

  /// The adb-root path: write the agent script, then show the one-liner to run
  /// from a computer. This is the tier for a `userdebug` phone where `adb root`
  /// works but no `su` will serve an app uid.
  Future<void> _showRootAgentSetup() async {
    final info = await _exec.installRootAgent();
    if (!mounted) return;
    final command = '${info?['command'] ?? _rootInfo?['agentCommand'] ?? ''}';
    if (command.isEmpty) {
      _toast('Could not prepare the root agent on this device.');
      return;
    }
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Root via adb'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'On a userdebug build, run this once from a computer with the '
              'device connected. Talon picks the agent up within 30 seconds.\n\n'
              'It stops at the next reboot — for a device that power-cycles '
              'on its own, flash Magisk instead and use Request root.',
              style: TextStyle(fontSize: 13, color: TalonColors.textDim),
            ),
            const SizedBox(height: 12),
            SelectableText(
              command,
              style: const TextStyle(fontSize: 12, fontFamily: 'monospace'),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () {
              Clipboard.setData(ClipboardData(text: command));
              _toast('Command copied');
            },
            child: const Text('Copy'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Done'),
          ),
        ],
      ),
    );
    await _refreshPrivilege();
  }

  @override
  Widget build(BuildContext context) {
    final prefs = widget.state.prefs;
    final locByDevice = {
      for (final loc in widget.state.meshLocations) loc.deviceId: loc,
    };
    return SettingsSection(
      title: 'Mesh',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          settingsSwitchRow(
            'Location sharing',
            'Register this device and answer on-demand locate requests',
            prefs.meshSharing,
            (v) => widget.state.setMeshSharing(v),
          ),
          const SizedBox(height: 10),
          healthRow(
            _meshBackgroundHealth(widget.state.meshBackgroundHealth.kind),
            'Background',
            widget.state.meshBackgroundHealth.label,
          ),
          if (Autostart.isSupported) ...[
            const Divider(height: 22),
            settingsSwitchRow(
              'Start at login',
              'Launch Talon when you sign in, so the mesh is online from boot',
              _autostart ?? false,
              (_autostart == null || _autostartBusy) ? null : _setAutostart,
            ),
          ],
          const Divider(height: 22),
          settingsSwitchRow(
            'Periodic reporting',
            'Send a live location fix on an interval',
            prefs.meshPeriodic,
            // null = properly disabled (greyed out) while sharing is off —
            // an enabled-looking switch that swallows taps reads as stuck.
            prefs.meshSharing ? (v) => widget.state.setMeshPeriodic(v) : null,
          ),
          if (prefs.meshSharing && prefs.meshPeriodic)
            settingsIntervalRow(
              'Mesh interval',
              '${(prefs.meshIntervalSeconds / 60).round()} min',
              (prefs.meshIntervalSeconds / 60).round(),
              min: 1,
              onChange: (m) => widget.state.setMeshIntervalSeconds(m * 60),
            ),
          const Divider(height: 22),
          // The Flatpak build is client-only: shell/file commands would only
          // reach the sandbox, so the switch is shown off and greyed out.
          settingsSwitchRow(
            'Device control',
            isFlatpak
                ? 'Not available in the Flatpak build — the sandbox cannot '
                    'run commands on this computer.'
                : 'Let the connected Talon run shell + file commands on '
                    'this device (teleport).',
            prefs.meshDeviceControl && !isFlatpak,
            prefs.meshSharing && !isFlatpak
                ? (v) => widget.state.setMeshDeviceControl(v)
                : null,
          ),
          if (_showsPrivilege && prefs.meshDeviceControl && !isFlatpak) ...[
            settingsSwitchRow(
              'Elevated access',
              'Allow those commands to run as root or through Shizuku when '
                  'available. Off: they run as the app itself.',
              prefs.meshElevated,
              (v) => widget.state.setMeshElevated(v),
            ),
            if (prefs.meshElevated) _privilegeRow(),
          ],
          if (!isFlatpak) ...[
            settingsSwitchRow(
              'Ask again for each pairing',
              'Start every newly paired bridge with device control and '
                  'elevated access off, until you turn them on for it.',
              prefs.meshGrantsPerPairing,
              (v) => widget.state.setMeshGrantsPerPairing(v),
            ),
            if (prefs.meshDeviceControl) ..._limitRows(prefs),
          ],
          const Divider(height: 22),
          Row(
            children: [
              Icon(Icons.hub_outlined, size: 18, color: TalonColors.textDim),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  widget.state.meshDevices.isEmpty
                      ? 'No mesh devices yet'
                      : '${widget.state.meshDevices.length} device${widget.state.meshDevices.length == 1 ? '' : 's'}',
                  style: const TextStyle(fontSize: 14),
                ),
              ),
              IconButton(
                onPressed: widget.state.refreshMeshDevices,
                icon: const Icon(Icons.refresh, size: 18),
                tooltip: 'Refresh mesh',
              ),
            ],
          ),
          const SizedBox(height: 6),
          for (final device in widget.state.meshDevices)
            _meshDeviceRow(device, locByDevice[device.id]),
        ],
      ),
    );
  }

  /// The device-control limits, each overridable: commands at once, commands
  /// waiting for a slot, and the largest file a mesh write may produce
  /// (stepped in powers of two).
  List<Widget> _limitRows(Prefs prefs) {
    final running =
        prefs.meshMaxConcurrent ?? MeshService.maxConcurrentCommands;
    final queued = prefs.meshMaxQueued ?? MeshService.maxQueuedCommands;
    final writeGiB =
        MeshService.maxWriteBytesFor(prefs) ~/ (1024 * 1024 * 1024);
    return [
      settingsIntervalRow(
        'Commands at once',
        '$running',
        running,
        min: 1,
        onChange: (n) => widget.state.setMeshLimits(concurrent: n),
      ),
      settingsIntervalRow(
        'Commands waiting',
        '$queued',
        queued,
        min: 0,
        onChange: (n) => widget.state.setMeshLimits(queued: n),
      ),
      // Stepped in powers of two: the row's value is the exponent.
      settingsIntervalRow(
        'Largest file write',
        '$writeGiB GiB',
        writeGiB.bitLength - 1,
        min: 0,
        onChange: (step) =>
            widget.state.setMeshLimits(writeGiB: 1 << step.clamp(0, 10)),
      ),
    ];
  }

  SettingsHealth _meshBackgroundHealth(MeshForegroundHealthKind kind) {
    switch (kind) {
      case MeshForegroundHealthKind.healthy:
        return SettingsHealth.ok;
      case MeshForegroundHealthKind.starting:
      case MeshForegroundHealthKind.off:
      case MeshForegroundHealthKind.unsupported:
        return SettingsHealth.warn;
      case MeshForegroundHealthKind.stale:
        return SettingsHealth.bad;
    }
  }

  /// The live privilege tier for device control, plus the two ways to raise
  /// it. Read-only status by design — the tier is what the device grants, not
  /// something a switch here can turn on.
  Widget _privilegeRow() {
    final tier = _privilege?['execPrivilege'];
    final (label, health) = switch (tier) {
      'root' => ('Root', SettingsHealth.ok),
      'system' => ('System (uid 1000)', SettingsHealth.ok),
      'shizuku' => ('Shizuku (shell)', SettingsHealth.ok),
      'app' => ('App only', SettingsHealth.warn),
      _ => ('Checking…', SettingsHealth.info),
    };
    final detail = _privilege?['root'] ?? 'reading privilege…';
    // The adb agent is only worth offering where `adb root` can actually
    // work — a user build has no root adbd to start it with.
    final debuggable = _rootInfo?['debuggable'] == true;
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          healthRow(health, label, detail),
          Row(
            children: [
              TextButton.icon(
                onPressed: _rootBusy
                    ? null
                    : () => _refreshPrivilege(probe: tier != 'root'),
                icon: _rootBusy
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.shield_outlined, size: 16),
                // Probing when we already have root is just a refresh; when we
                // don't, it is the request that raises the su grant dialog.
                label: Text(tier == 'root' ? 'Recheck' : 'Request root'),
              ),
              if (debuggable && tier != 'root')
                TextButton.icon(
                  onPressed: _rootBusy ? null : _showRootAgentSetup,
                  icon: const Icon(Icons.usb, size: 16),
                  label: const Text('Root via adb'),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _meshDeviceRow(DeviceInfo device, DeviceLocation? loc) {
    final battery = device.battery == null
        ? ''
        : ' · ${device.battery}%${device.charging == true ? ' charging' : ''}';
    final last = fmtAge(
      DateTime.now().millisecondsSinceEpoch - device.lastSeen,
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            device.online ? Icons.radio_button_checked : Icons.radio_button_off,
            size: 16,
            color: device.online ? TalonColors.ok : TalonColors.textFaint,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  device.name,
                  style: const TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  '${device.platform} · $last$battery',
                  style: TextStyle(fontSize: 12, color: TalonColors.textFaint),
                ),
                if (device.appVersion.isNotEmpty)
                  Text(
                    'v${device.appVersion}',
                    style: TextStyle(
                      fontSize: 11,
                      color: TalonColors.textFaint,
                    ),
                  ),
              ],
            ),
          ),
          if (loc != null)
            IconButton(
              onPressed: () => launchUrl(
                Uri.parse('https://maps.google.com/?q=${loc.lat},${loc.lon}'),
                mode: LaunchMode.externalApplication,
              ),
              icon: const Icon(Icons.map_outlined, size: 18),
              tooltip: 'Open map',
            ),
        ],
      ),
    );
  }
}
