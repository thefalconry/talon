/// Golden renders of the conversation view across the scenarios in
/// chat_fixtures.dart, on a phone and a desktop viewport.
///
///   TALON_GOLDENS=1 flutter test test/golden --update-goldens
///
/// PNGs land in test/golden/goldens/ (gitignored). See README.md.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/ui/root_view.dart';

import 'chat_fixtures.dart';
import 'golden_harness.dart';

void main() {
  if (!goldensEnabled) {
    test('chat goldens skipped (set TALON_GOLDENS=1)', () {});
    return;
  }

  setUpAll(goldenSetUpAll);

  for (final s in allChatScenarios) {
    for (final phone in [true, false]) {
      final label = phone ? 'phone' : 'desktop';
      testWidgets('$label · chat · ${s.name}', (tester) async {
        goldenSetUp();
        phone ? usePhone(tester) : useDesktop(tester);
        final state = seededState(
          narrow: phone,
          chats: [chatFor(s), if (!phone) ...sidebarChats()],
          messages: {'c1': s.messages},
          select: 'c1',
        );
        addTearDown(state.dispose);
        s.live?.call(state.turnFor('c1'));
        await tester.pumpWidget(goldenApp(RootView(state: state)));
        await shoot(tester, '${label}_chat_${s.name}');
      });
    }
  }

  // One light-theme pass over the busiest scenarios.
  for (final s in [burst, markdown]) {
    testWidgets('phone · chat · ${s.name} (light)', (tester) async {
      goldenSetUp(brightness: Brightness.light);
      usePhone(tester);
      final state = seededState(
        narrow: true,
        chats: [chatFor(s)],
        messages: {'c1': s.messages},
        select: 'c1',
      );
      addTearDown(state.dispose);
      s.live?.call(state.turnFor('c1'));
      await tester.pumpWidget(goldenApp(RootView(state: state)));
      await shoot(tester, 'phone_chat_${s.name}_light');
    });
  }
}
