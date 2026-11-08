/// The on-device mesh command audit in Settings → Mesh: what the connected
/// Talon ran here, newest first, with a clear button. Reads the same file
/// the background mesh isolate writes (see MeshAudit).
library;

import 'package:flutter/material.dart';

import '../../services/mesh_audit.dart';
import '../../theme.dart';
import 'settings_widgets.dart';

class MeshAuditSection extends StatefulWidget {
  const MeshAuditSection({super.key, this.audit});

  /// Injectable for tests; defaults to the app-support audit file.
  final MeshAudit? audit;

  @override
  State<MeshAuditSection> createState() => _MeshAuditSectionState();
}

class _MeshAuditSectionState extends State<MeshAuditSection> {
  /// Entries shown before "Show all".
  static const _preview = 5;

  /// Entries loaded at all; the file itself keeps more.
  static const _limit = 100;

  late final MeshAudit _audit = widget.audit ?? MeshAudit();
  List<MeshAuditEntry>? _entries;
  bool _showAll = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final entries = await _audit.read(limit: _limit);
    if (mounted) setState(() => _entries = entries);
  }

  Future<void> _clear() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Clear command audit?'),
        content: const Text(
          'This deletes the record of mesh commands run on this device.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Clear'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await _audit.clear();
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final entries = _entries;
    final shown = entries == null
        ? const <MeshAuditEntry>[]
        : _showAll
            ? entries
            : entries.take(_preview).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(
              Icons.receipt_long_outlined,
              size: 18,
              color: TalonColors.textDim,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                entries == null
                    ? 'Command audit'
                    : 'Command audit · ${entries.length}'
                        '${entries.length >= _limit ? '+' : ''}',
                style: const TextStyle(fontSize: 14),
              ),
            ),
            IconButton(
              onPressed: _load,
              icon: const Icon(Icons.refresh, size: 18),
              tooltip: 'Refresh audit',
            ),
            IconButton(
              onPressed: (entries?.isEmpty ?? true) ? null : _clear,
              icon: const Icon(Icons.delete_outline, size: 18),
              tooltip: 'Clear audit',
            ),
          ],
        ),
        if (entries != null && entries.isEmpty)
          Text(
            'No mesh commands have run on this device yet.',
            style: TextStyle(fontSize: 12, color: TalonColors.textFaint),
          ),
        for (final e in shown) _entryRow(e),
        if (entries != null && entries.length > _preview)
          TextButton(
            onPressed: () => setState(() => _showAll = !_showAll),
            child: Text(_showAll ? 'Show fewer' : 'Show all'),
          ),
      ],
    );
  }

  Widget _entryRow(MeshAuditEntry e) {
    final age = fmtAge(DateTime.now().millisecondsSinceEpoch - e.ts);
    final faint = TextStyle(fontSize: 11.5, color: TalonColors.textFaint);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            e.ok ? Icons.check_circle_outline : Icons.cancel_outlined,
            size: 16,
            color: e.ok ? TalonColors.ok : TalonColors.bad,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  e.target == null ? e.name : '${e.name}  ${e.target}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontFamily: 'monospace',
                  ),
                ),
                Text(
                  '$age · ${e.tier} · ${e.durationMs}ms · ${e.credential}',
                  style: faint,
                ),
                if (e.error != null)
                  Text(
                    e.error!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11.5, color: TalonColors.bad),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
