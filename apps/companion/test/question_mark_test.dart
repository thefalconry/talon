import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/app_shell.dart';

/// Shift+/ used to be a global shortcut for the help dialog. An ancestor
/// shortcut that handles a printable key eats it before text input sees it,
/// so '?' could not be typed into the composer. The chord is gone; pressing
/// it with a text field focused must not open anything.
void main() {
  testWidgets('Shift+/ in the composer does not trigger a shortcut',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    SharedPreferences.setMockInitialValues({'onboarded.v1': true});
    final prefs = await Prefs.load();
    final state = AppState(prefs, narrowLayout: false);
    addTearDown(state.dispose);
    state.debugSeed(
      chats: [
        ClientChat(
            id: 'c1',
            title: 'General',
            createdAt: 1,
            lastActive: 2,
            preview: ''),
      ],
      messages: {'c1': []},
      connState: ConnState.connected,
    );
    await tester.pumpWidget(MaterialApp(
      theme: buildTalonTheme(),
      home: AppShell(state: state),
    ));
    await tester.pumpAndSettle();
    await tester.tap(find.text('General'));
    await tester.pumpAndSettle();

    final composer = find.byType(TextField).last;
    await tester.tap(composer);
    await tester.pump();

    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    final handled = await tester.sendKeyEvent(LogicalKeyboardKey.slash);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.pumpAndSettle();

    expect(find.text('Keyboard shortcuts'), findsNothing,
        reason: "'?' must reach the text field, not open the help dialog");
    expect(handled, isFalse,
        reason: 'no ancestor shortcut may swallow the key');
  });
}
