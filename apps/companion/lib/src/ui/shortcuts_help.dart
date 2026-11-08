import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';

import '../theme.dart';

/// One row: a chord (e.g. "⌘K" / "Ctrl+K") plus what it does.
class _ShortcutEntry {
  final String keys;
  final String label;
  const _ShortcutEntry(this.keys, this.label);
}

bool get _isMac => defaultTargetPlatform == TargetPlatform.macOS;

/// Desktop keyboard shortcuts, mirroring the bindings actually wired in
/// [CallbackShortcuts] across app_shell.dart / quick_switcher.dart / the
/// composer. Keep this list in sync when a new global binding is added —
/// it's the only place a user can discover them.
List<_ShortcutEntry> _entries() {
  final mod = _isMac ? '⌘' : 'Ctrl';
  return [
    _ShortcutEntry(
        '$mod K', 'Command palette — run an action, jump to a chat, search'),
    _ShortcutEntry('$mod N', 'New chat'),
    const _ShortcutEntry('Esc', 'Close the open conversation / dialog'),
    const _ShortcutEntry('↑ / ↓', 'Move selection in the command palette'),
    const _ShortcutEntry('Enter', 'Run the highlighted action / open result'),
  ];
}

/// Opens the "Keyboard shortcuts" dialog. Safe to call from anywhere with a
/// [BuildContext] — used by settings and the command palette.
Future<void> openShortcutsHelp(BuildContext context) {
  return showDialog<void>(
    context: context,
    barrierColor: Colors.black.withValues(alpha: 0.55),
    builder: (_) => const _ShortcutsHelpDialog(),
  );
}

class _ShortcutsHelpDialog extends StatelessWidget {
  const _ShortcutsHelpDialog();

  @override
  Widget build(BuildContext context) {
    final entries = _entries();
    return Dialog(
      backgroundColor: Colors.transparent,
      alignment: const Alignment(0, -0.4),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Container(
          decoration: BoxDecoration(
            color: TalonColors.void1,
            borderRadius: TalonRadius.rLg,
            border: Border.all(color: TalonColors.glassStroke),
          ),
          padding: const EdgeInsets.fromLTRB(
              TalonSpace.lg, TalonSpace.md, TalonSpace.lg, TalonSpace.lg),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text('Keyboard shortcuts', style: TalonType.title),
                  ),
                  IconButton(
                    tooltip: 'Close',
                    onPressed: () => Navigator.of(context).pop(),
                    icon: Icon(Icons.close, size: 18, color: TalonColors.textDim),
                  ),
                ],
              ),
              const SizedBox(height: TalonSpace.sm),
              for (final e in entries)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Row(
                    children: [
                      Container(
                        constraints: const BoxConstraints(minWidth: 68),
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 4),
                        decoration: BoxDecoration(
                          color: TalonColors.surfaceHi,
                          borderRadius: TalonRadius.rSm,
                          border: Border.all(color: TalonColors.glassStroke),
                        ),
                        alignment: Alignment.center,
                        child: Text(
                          e.keys,
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w600,
                            fontFeatures: [FontFeature.tabularFigures()],
                          ),
                        ),
                      ),
                      const SizedBox(width: TalonSpace.sm),
                      Expanded(
                        child: Text(
                          e.label,
                          style: TextStyle(
                              fontSize: 13.5, color: TalonColors.textDim),
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
