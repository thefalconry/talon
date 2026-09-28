/// The Overview chapter's cards: live daemon status, diagnostics ("doctor"),
/// About, and the connection profile. All read the app state and the last
/// config snapshot; only the diagnostics dump and the About version probe
/// do any work of their own.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../models/bridge_models.dart';
import '../../services/log.dart';
import '../../state/app_state.dart';
import '../../theme.dart';
import '../connect_screen.dart';
import 'settings_widgets.dart';

class StatusCard extends StatelessWidget {
  final AppState state;
  final ConfigSnapshot? cfg;
  const StatusCard({super.key, required this.state, required this.cfg});

  @override
  Widget build(BuildContext context) {
    final cfg = this.cfg;
    final s = state;
    final connected = s.conn == ConnState.connected;
    final up = cfg == null ? '' : fmtUptime(cfg.uptimeMs);
    final healthy = connected && (cfg?.healthy ?? true);
    final badgeColor = !connected
        ? TalonColors.bad
        : (healthy ? TalonColors.ok : TalonColors.warn);
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        // Faint indigo→teal wash so the white stat tiles pop off the card.
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            TalonColors.accent.withValues(alpha: 0.07),
            TalonColors.accent2.withValues(alpha: 0.05),
          ],
        ),
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: TalonColors.glassStroke, width: 1),
        boxShadow: TalonShadows.soft,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 11,
                height: 11,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: connected ? TalonColors.ok : TalonColors.bad,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      connected ? 'Connected' : 'Disconnected',
                      style: const TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 18,
                      ),
                    ),
                    Text(
                      connected
                          ? (healthy
                              ? 'Agent online and healthy'
                              : 'Agent online')
                          : 'Not connected to the daemon',
                      style:
                          TextStyle(fontSize: 13, color: TalonColors.textDim),
                    ),
                  ],
                ),
              ),
              Container(
                width: 44,
                height: 44,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: badgeColor.withValues(alpha: 0.14),
                ),
                child: Icon(
                  connected && healthy
                      ? Icons.verified_user_outlined
                      : Icons.gpp_maybe_outlined,
                  size: 22,
                  color: badgeColor,
                ),
              ),
            ],
          ),
          if (cfg != null) ...[
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                    child:
                        statTile(Icons.dns_outlined, 'Backend', cfg.backend)),
                const SizedBox(width: 10),
                Expanded(
                    child: statTile(Icons.account_tree_outlined, 'Sessions',
                        '${cfg.sessions}')),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                    child: statTile(
                        Icons.forum_outlined, 'Messages', '${cfg.messages}')),
                const SizedBox(width: 10),
                Expanded(
                    child: statTile(
                        Icons.memory_outlined, 'Memory', '${cfg.memoryMb} MB')),
              ],
            ),
            if (up.isNotEmpty) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                      child: statTile(Icons.schedule_outlined, 'Uptime', up)),
                  const SizedBox(width: 10),
                  Expanded(
                    child: statTile(
                      Icons.favorite_outline,
                      'Health',
                      healthy ? 'Good' : 'Check',
                      pill: healthy,
                    ),
                  ),
                ],
              ),
            ],
          ],
          if (s.config.canManageDaemon) ...[
            const SizedBox(height: 14),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: () async {
                  final r = await s.restartDaemon();
                  if (context.mounted && !r.ok && r.detail != null) {
                    ScaffoldMessenger.of(
                      context,
                    ).showSnackBar(SnackBar(content: Text(r.detail!)));
                  }
                },
                icon: const Icon(Icons.restart_alt, size: 18),
                label: const Text('Restart daemon'),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class DiagnosticsCard extends StatelessWidget {
  final AppState state;
  final ConfigSnapshot? cfg;
  const DiagnosticsCard({super.key, required this.state, required this.cfg});

  @override
  Widget build(BuildContext context) {
    final cfg = this.cfg;
    final s = state;
    // The effective connection (with any auto-discovered port/token), not the
    // saved profile — diagnostics should describe what's actually in use.
    final c = s.activeConfig;
    final protoOk = s.status.protocol == kBridgeProtocolVersion;
    final connected = s.conn == ConnState.connected;

    SettingsHealth connHealth;
    String connDetail;
    switch (s.conn) {
      case ConnState.connected:
        connHealth = SettingsHealth.ok;
        connDetail = 'Streaming events';
      case ConnState.connecting:
        connHealth = SettingsHealth.warn;
        connDetail = 'Connecting…';
      case ConnState.error:
        connHealth = SettingsHealth.bad;
        connDetail = 'Not connected';
      case ConnState.idle:
        connHealth = SettingsHealth.warn;
        connDetail = 'Idle';
    }

    return SettingsSection(
      title: 'Diagnostics',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          healthRow(connHealth, 'Connection', connDetail),
          healthRow(
            !connected
                ? SettingsHealth.warn
                : (protoOk ? SettingsHealth.ok : SettingsHealth.bad),
            'Bridge protocol',
            connected
                ? (protoOk
                    ? 'v${s.status.protocol} — matched'
                    : 'app v$kBridgeProtocolVersion · daemon v${s.status.protocol} — mismatch')
                : 'Unknown until connected',
          ),
          healthRow(
            cfg == null
                ? SettingsHealth.warn
                : (cfg.healthy ? SettingsHealth.ok : SettingsHealth.bad),
            'Daemon health',
            cfg == null
                ? 'No status yet'
                : (cfg.healthy ? 'Reporting healthy' : 'Unhealthy'),
          ),
          healthRow(
            SettingsHealth.info,
            'Transport',
            '${c.baseUrl}${c.tls ? ' · TLS' : ''}',
          ),
          healthRow(
            SettingsHealth.info,
            'Authentication',
            (c.token != null && c.token!.isNotEmpty)
                ? 'Bearer token set'
                : (c.isLoopback ? 'None (loopback)' : 'None'),
          ),
          const SizedBox(height: 12),
          // Wrap, not Row: both labelled buttons don't always fit one line on
          // a narrow phone (and Inter runs a touch wider than the old system
          // face) — wrapping beats clipping.
          Wrap(
            spacing: 10,
            runSpacing: 8,
            children: [
              OutlinedButton.icon(
                onPressed: () => s.start(),
                icon: const Icon(Icons.wifi_tethering, size: 16),
                label: const Text('Reconnect'),
                style: OutlinedButton.styleFrom(
                  foregroundColor: TalonColors.accent,
                  side: BorderSide(
                    color: TalonColors.accent.withValues(alpha: 0.5),
                  ),
                ),
              ),
              TextButton.icon(
                onPressed: () => _copyDiagnostics(context),
                icon: const Icon(Icons.copy_all_outlined, size: 16),
                label: const Text('Copy diagnostics'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _copyDiagnostics(BuildContext context) async {
    final s = state;
    final cfg = this.cfg;
    final buf = StringBuffer()
      ..writeln('Talon diagnostics')
      ..writeln('connection: ${s.conn.name}')
      ..writeln('endpoint: ${s.activeConfig.baseUrl}')
      ..writeln(
        'protocol: app v$kBridgeProtocolVersion / daemon v${s.status.protocol}',
      )
      ..writeln('backend: ${s.status.backend}')
      ..writeln('model: ${s.status.model}')
      ..writeln('bot: ${s.status.botName}');
    if (cfg != null) {
      buf
        ..writeln('healthy: ${cfg.healthy}')
        ..writeln('uptimeMs: ${cfg.uptimeMs}')
        ..writeln('sessions: ${cfg.sessions}')
        ..writeln('messages: ${cfg.messages}')
        ..writeln('memoryMb: ${cfg.memoryMb}');
    }
    buf
      ..writeln('--- recent log ---')
      ..writeln(AppLog.dump());
    await Clipboard.setData(ClipboardData(text: buf.toString()));
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Diagnostics copied to clipboard')),
      );
    }
  }
}

/// About: app + daemon identity. Stateful only to resolve this app's own
/// version once.
class AboutCard extends StatefulWidget {
  final AppState state;
  final ConfigSnapshot? cfg;
  const AboutCard({super.key, required this.state, required this.cfg});

  @override
  State<AboutCard> createState() => _AboutCardState();
}

/// Commit the build came from, stamped by CI via
/// `--dart-define=TALON_COMMIT=<sha7>`. Empty for local builds.
const String _buildCommit = String.fromEnvironment('TALON_COMMIT');

/// 'v5.20.0+520000 (e6f3cde)'. The version alone is identical for a release
/// and for any test build cut from the same package.json, so the commit is
/// what tells them apart.
@visibleForTesting
String formatAppVersion(String version, String build, String commit) {
  final base = 'v$version+$build';
  return commit.isEmpty ? base : '$base ($commit)';
}

class _AboutCardState extends State<AboutCard> {
  /// This app's own version, for the About card ('' until loaded).
  String _appVersion = '';

  @override
  void initState() {
    super.initState();
    PackageInfo.fromPlatform().then((info) {
      if (mounted) {
        setState(() => _appVersion = formatAppVersion(
            info.version, info.buildNumber, _buildCommit));
      }
    }).catchError((_) {});
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.state;
    final cfg = widget.cfg;
    return SettingsSection(
      title: 'About',
      child: Column(
        children: [
          if (_appVersion.isNotEmpty) infoRow('App version', _appVersion),
          infoRow('Assistant', s.status.botName),
          infoRow('Backend', s.status.backend),
          infoRow(
            'Default model',
            cfg?.modelDisplay.isNotEmpty == true
                ? cfg!.modelDisplay
                : s.status.model,
          ),
          infoRow('Bridge protocol', 'v$kBridgeProtocolVersion'),
          infoRow('Active chats', '${s.status.activeChats}'),
          if (cfg != null) infoRow('Uptime', fmtUptime(cfg.uptimeMs)),
          if (s.status.startedAt.isNotEmpty)
            infoRow(
              'Started',
              s.status.startedAt.replaceFirst('T', ' ').split('.').first,
            ),
        ],
      ),
    );
  }
}

class ConnectionCard extends StatelessWidget {
  final AppState state;
  const ConnectionCard({super.key, required this.state});

  @override
  Widget build(BuildContext context) {
    final c = state.config;
    final where = c.isLoopback
        ? 'This computer${c.canManageDaemon ? ' (managed)' : ''}'
        : '${c.host}:${c.port}';
    return SettingsSection(
      title: 'Connection',
      child: Column(
        children: [
          Row(
            children: [
              Icon(Icons.lan_outlined, size: 18, color: TalonColors.textDim),
              const SizedBox(width: 10),
              Expanded(
                child: Text(where, style: const TextStyle(fontSize: 14)),
              ),
              TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) =>
                        ConnectScreen(state: state, firstRun: false),
                  ),
                ),
                child: const Text('Change'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
