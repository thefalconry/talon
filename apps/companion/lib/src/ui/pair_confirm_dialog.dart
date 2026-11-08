import 'package:flutter/material.dart';

import '../models/connection.dart';

/// Asks before a `talon://pair` link changes where the app connects.
///
/// Any app or web page can open a pairing link, so the dialog shows only what
/// the app itself derived from it — the scheme, host and port it will dial and
/// the certificate it will pin — and nothing the link merely *claims* (its
/// suggested display name is never shown). It also says whether the bridge
/// gets device control straight away (the default) or starts without it
/// (the opt-in "ask again for each pairing" setting, or control turned off).
class PairConfirmDialog extends StatelessWidget {
  final ConnectionConfig config;

  /// Whether a working connection would be replaced (changes the wording).
  final bool replacing;

  /// Whether the bridge will be able to run commands here once connected.
  final bool deviceControl;

  const PairConfirmDialog({
    super.key,
    required this.config,
    required this.replacing,
    this.deviceControl = true,
  });

  static const _controlOn = 'This bridge will be able to run shell and file '
      'commands on this device (Settings → Mesh → Device control turns that '
      'off).';
  static const _controlOff = 'Device control stays off for this bridge until '
      'you turn it on in Settings.';

  /// Show the dialog; true only when the user explicitly chose to connect.
  static Future<bool> ask(
    BuildContext context,
    ConnectionConfig config, {
    required bool replacing,
    bool deviceControl = true,
  }) async {
    final answer = await showDialog<bool>(
      context: context,
      // Dismissing the dialog any other way means "no".
      builder: (_) => PairConfirmDialog(
        config: config,
        replacing: replacing,
        deviceControl: deviceControl,
      ),
    );
    return answer ?? false;
  }

  @override
  Widget build(BuildContext context) {
    final fingerprint = config.fingerprint;
    final mono = TextStyle(
      fontFamily: 'monospace',
      fontSize: 12,
      color: Theme.of(context).colorScheme.onSurface,
    );
    return AlertDialog(
      title: Text(replacing ? 'Switch to another bridge?' : 'Connect to bridge?'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'A pairing link wants to connect Talon to this bridge. Only '
              'continue if you just created it with /mesh link on your own '
              'Talon.',
            ),
            const SizedBox(height: 14),
            const Text('Address', style: TextStyle(fontWeight: FontWeight.w600)),
            SelectableText(
              config.baseUrl,
              key: const ValueKey('pair-confirm-address'),
              style: mono,
            ),
            const SizedBox(height: 10),
            const Text(
              'Certificate (SHA-256)',
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
            if (fingerprint != null)
              SelectableText(
                ConnectionConfig.formatFingerprint(fingerprint),
                key: const ValueKey('pair-confirm-fingerprint'),
                style: mono,
              )
            else
              const Text(
                'None — unencrypted connection on the local network.',
                key: ValueKey('pair-confirm-fingerprint'),
              ),
            if (fingerprint != null) ...[
              const SizedBox(height: 6),
              const Text(
                'It should match the fingerprint `talon status` shows on '
                'that machine.',
                style: TextStyle(fontSize: 12),
              ),
            ],
            const SizedBox(height: 14),
            Text(
              '${replacing ? 'This replaces the current connection. ' : ''}'
              '${deviceControl ? _controlOn : _controlOff}',
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text('Connect'),
        ),
      ],
    );
  }
}
