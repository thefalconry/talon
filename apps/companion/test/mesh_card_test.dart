import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/settings/mesh_card.dart';

/// Device control is on out of the box, and its restrictions are settings:
/// the per-pairing opt-in and the command limits.
void main() {
  setUp(() {
    TalonTheme.mode.value = ThemeMode.light;
    TalonTheme.apply(Brightness.light);
  });

  Future<AppState> pump(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 2000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    SharedPreferences.setMockInitialValues({});
    final state = AppState(await Prefs.load());
    addTearDown(state.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: buildTalonTheme(),
        home: Scaffold(
          // The settings screen rebuilds its cards on AppState changes.
          body: ListenableBuilder(
            listenable: state,
            builder: (_, __) =>
                SingleChildScrollView(child: MeshCard(state: state)),
          ),
        ),
      ),
    );
    await tester.pump();
    return state;
  }

  Finder stepUp(String label) => find.descendant(
        of: find.ancestor(of: find.text(label), matching: find.byType(Row)),
        matching: find.byIcon(Icons.add_circle_outline),
      );

  testWidgets('shows the defaults and the opt-in restrictions',
      (tester) async {
    final state = await pump(tester);
    expect(state.prefs.meshDeviceControl, isTrue);
    expect(find.text('Ask again for each pairing'), findsOneWidget);
    expect(find.text('Commands at once'), findsOneWidget);
    expect(find.text('Commands waiting'), findsOneWidget);
    expect(find.text('4 GiB'), findsOneWidget);
  });

  testWidgets('the limits are adjustable', (tester) async {
    final state = await pump(tester);
    await tester.tap(stepUp('Largest file write'));
    await tester.pump();
    expect(state.prefs.meshMaxWriteGiB, 8);
    await tester.tap(stepUp('Commands at once'));
    await tester.pump();
    expect(state.prefs.meshMaxConcurrent, 5);
    expect(find.text('8 GiB'), findsOneWidget);
  });
}
