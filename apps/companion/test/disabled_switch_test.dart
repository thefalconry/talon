import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/settings/settings_widgets.dart';

/// A switch that can't be changed must look it: before, the theme ignored
/// WidgetState.disabled, so a blocked switch rendered exactly like a live one.
void main() {
  final theme = buildTalonTheme().switchTheme;

  for (final selected in [true, false]) {
    test('disabled ${selected ? 'on' : 'off'} switch is visibly dimmed', () {
      final live = {if (selected) WidgetState.selected};
      final off = {...live, WidgetState.disabled};
      expect(theme.trackColor!.resolve(off),
          isNot(theme.trackColor!.resolve(live)));
      expect(theme.thumbColor!.resolve(off),
          isNot(theme.thumbColor!.resolve(live)));
      expect(theme.trackColor!.resolve(off)!.a,
          lessThan(theme.trackColor!.resolve(live)!.a));
    });
  }

  testWidgets('a disabled settings row dims its label and blocks taps',
      (tester) async {
    var changed = false;
    Widget row(ValueChanged<bool>? onChanged) => MaterialApp(
          theme: buildTalonTheme(),
          home: Scaffold(
            body: settingsSwitchRow('Device control', 'sub', false, onChanged),
          ),
        );

    await tester.pumpWidget(row(null));
    await tester.pumpAndSettle();
    expect(tester.widget<AnimatedOpacity>(find.byType(AnimatedOpacity)).opacity,
        0.5);
    await tester.tap(find.byType(Switch));
    expect(changed, isFalse);

    await tester.pumpWidget(row((v) => changed = v));
    await tester.pumpAndSettle();
    expect(tester.widget<AnimatedOpacity>(find.byType(AnimatedOpacity)).opacity,
        1);
    await tester.tap(find.byType(Switch));
    expect(changed, isTrue);
  });
}
