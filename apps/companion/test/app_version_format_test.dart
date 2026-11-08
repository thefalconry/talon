import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/ui/settings/overview_cards.dart';

void main() {
  test('app version carries the build commit when CI stamped one', () {
    expect(formatAppVersion('5.20.0', '520000', 'e6f3cde'),
        'v5.20.0+520000 (e6f3cde)');
  });

  test('local builds without a commit keep the bare version', () {
    expect(formatAppVersion('5.20.0', '520000', ''), 'v5.20.0+520000');
  });
}
