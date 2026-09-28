import 'package:flutter/material.dart';

import '../models/connection.dart';

/// Asks before the token goes to a hand-typed TLS bridge nothing has pinned
/// yet (trust on first use, confirmed).
///
/// Pairing links and local discovery carry the daemon's own fingerprint, so
/// they never get here. A typed host has only what the handshake presented,
/// and anyone between the app and the bridge could have presented it; the
/// user compares it with the one the daemon prints, then connects. This is a
/// confirmation, not a gate: "Trust and connect" always proceeds.
///
/// With no [fingerprint] the bridge could not be reached to look; the user
/// can still connect, and the first certificate it presents is pinned as
/// before.
class CertificateConfirmDialog extends StatelessWidget {
  /// The URL that was probed.
  final String address;

  /// What the handshake presented (lowercase hex), or null when nothing
  /// answered.
  final String? fingerprint;

  /// The pin this profile held for the same address, when the presented
  /// certificate differs from it.
  final String? previous;

  const CertificateConfirmDialog({
    super.key,
    required this.address,
    required this.fingerprint,
    this.previous,
  });

  /// Show the dialog; true only when the user explicitly chose to connect.
  static Future<bool> ask(
    BuildContext context, {
    required String address,
    required String? fingerprint,
    String? previous,
  }) async {
    final answer = await showDialog<bool>(
      context: context,
      builder: (_) => CertificateConfirmDialog(
        address: address,
        fingerprint: fingerprint,
        previous: previous,
      ),
    );
    return answer ?? false;
  }

  @override
  Widget build(BuildContext context) {
    final fp = fingerprint;
    final mono = TextStyle(
      fontFamily: 'monospace',
      fontSize: 12,
      color: Theme.of(context).colorScheme.onSurface,
    );
    return AlertDialog(
      title: Text(
          fp == null ? 'Could not check the bridge' : 'Trust this bridge?'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Address',
                style: TextStyle(fontWeight: FontWeight.w600)),
            SelectableText(
              address,
              key: const ValueKey('cert-confirm-address'),
              style: mono,
            ),
            const SizedBox(height: 10),
            if (fp != null) ...[
              const Text(
                'Certificate (SHA-256)',
                style: TextStyle(fontWeight: FontWeight.w600),
              ),
              SelectableText(
                ConnectionConfig.formatFingerprint(fp),
                key: const ValueKey('cert-confirm-fingerprint'),
                style: mono,
              ),
              const SizedBox(height: 10),
              if (previous != null) ...[
                const Text(
                  'This is not the certificate this app trusted for this '
                  'address before. If you did not reinstall or re-key Talon, '
                  'do not connect.',
                  key: ValueKey('cert-confirm-changed'),
                ),
                const SizedBox(height: 10),
              ],
              const Text(
                'Compare it with the fingerprint `talon status` shows on that '
                'machine (also on the bridge\'s /health page). Your token is '
                'sent only after you connect, and this certificate is pinned '
                'from then on.',
              ),
            ] else
              const Text(
                'Nothing answered, so its certificate could not be shown. If '
                'you connect anyway, the first certificate it presents is '
                'trusted without asking.',
                key: ValueKey('cert-confirm-unreachable'),
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
          child: Text(fp == null ? 'Connect anyway' : 'Trust and connect'),
        ),
      ],
    );
  }
}
