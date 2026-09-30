import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/services/mesh_audit.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/settings/mesh_audit_section.dart';

MeshAuditEntry _entry(String id, {bool ok = true, String name = 'stat'}) =>
    MeshAuditEntry(
      ts: DateTime.now().millisecondsSinceEpoch,
      commandId: id,
      name: name,
      target: '/tmp/$id',
      ok: ok,
      error: ok ? null : 'boom',
      durationMs: 3,
      credential: 'shared',
      tier: 'app',
    );

void main() {
  testWidgets('Settings section lists entries and clears them', (
    tester,
  ) async {
    final audit = _MemoryAudit([
      _entry('c1'),
      _entry('c2', ok: false, name: 'exec'),
    ]);
    await tester.pumpWidget(
      MaterialApp(
        theme: buildTalonTheme(),
        home: Scaffold(body: MeshAuditSection(audit: audit)),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Command audit · 2'), findsOneWidget);
    expect(find.text('stat  /tmp/c1'), findsOneWidget);
    expect(find.text('boom'), findsOneWidget);

    await tester.tap(find.byTooltip('Clear audit'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Clear'));
    await tester.pumpAndSettle();
    expect(audit.entries, isEmpty);
    expect(
      find.text('No mesh commands have run on this device yet.'),
      findsOneWidget,
    );
  });
}

/// In-memory audit for widget tests (no file I/O inside fake async).
class _MemoryAudit extends MeshAudit {
  _MemoryAudit(this.entries) : super(file: () async => null);
  final List<MeshAuditEntry> entries;

  @override
  Future<List<MeshAuditEntry>> read({int? limit}) async =>
      entries.reversed.take(limit ?? entries.length).toList();

  @override
  Future<void> clear() async => entries.clear();
}
