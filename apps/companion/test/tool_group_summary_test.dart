import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/models/tool_format.dart';

void main() {
  group('toolGroupSummary', () {
    test('buckets by kind and counts, sentence-cased', () {
      expect(
        toolGroupSummary(['Bash', 'Bash', 'Bash']),
        'Ran 3 commands',
      );
      expect(
        toolGroupSummary(['Bash', 'Read', 'Read']),
        'Ran a command, read 2 files',
      );
      expect(
        toolGroupSummary(['Write', 'Edit']),
        'Edited 2 files',
      );
    });

    test('orders buckets by first appearance', () {
      expect(
        toolGroupSummary(['Read', 'Bash']),
        'Read a file, ran a command',
      );
      expect(
        toolGroupSummary(['Bash', 'Read']),
        'Ran a command, read a file',
      );
    });

    test('de-noises MCP names, unknown tools fall to the generic bucket', () {
      // An MCP tool whose bare name matches a known kind is bucketed there…
      expect(
        toolGroupSummary(['mcp__fs-tools__grep']),
        'Searched files',
      );
      // …and anything else counts as a generic tool use rather than guessing.
      expect(
        toolGroupSummary([
          'mcp__github-tools__search_code',
          'mcp__brave-search__brave_web_search',
        ]),
        'Used 2 tools',
      );
    });

    test('an empty list is empty', () {
      expect(toolGroupSummary(const []), '');
    });
  });
}
