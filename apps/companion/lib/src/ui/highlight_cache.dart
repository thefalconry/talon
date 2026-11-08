import 'dart:collection';

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';
import 'package:highlight/highlight.dart' show Node, highlight;

/// One run of highlighted text and the highlight.js classes wrapping it,
/// outermost first. Plain data, so it crosses an isolate boundary as-is and
/// is theme-independent (a light/dark switch reuses the same runs).
typedef HighlightRun = (String text, List<String> classes);

/// Syntax highlighting off the build path (#1062).
///
/// `HighlightView` ran highlight.js's Dart port inside `build`, uncached, at
/// any size. `ListView.builder` disposes rows that scroll off and rebuilds
/// them on the way back, so scrolling through a long code block — a pasted
/// log, a tool dump — re-highlighted it every time, stalling the UI thread
/// long enough for GNOME to offer "Force Quit". Now:
///
/// * results are cached (LRU) by (language, code), so a row that scrolls
///   back in paints immediately;
/// * small blocks ([syncLimit]) highlight synchronously on first sight — a
///   few ms, and no plain→coloured flicker;
/// * larger blocks ([asyncLimit]) highlight in a background isolate and show
///   plain text until the result lands;
/// * anything bigger stays plain monospace — colour is not worth seconds of
///   CPU on a 200 KB log.
class HighlightCache {
  HighlightCache._();

  /// Up to this many characters highlight synchronously in build.
  static const int syncLimit = 3000;

  /// Up to this many characters (and [asyncLineLimit] lines) highlight in a
  /// background isolate. Beyond either, the block renders plain.
  static const int asyncLimit = 64 * 1024;
  static const int asyncLineLimit = 2000;

  static const int _capacity = 64;
  static final LinkedHashMap<(String, int, int), List<HighlightRun>> _lru =
      LinkedHashMap();

  static (String, int, int) _key(String code, String language) =>
      (language, code.length, code.hashCode);

  /// Cached runs for [code] in [language], or null. A hit is refreshed as
  /// most-recently used.
  static List<HighlightRun>? lookup(String code, String language) {
    final key = _key(code, language);
    final hit = _lru.remove(key);
    if (hit != null) _lru[key] = hit;
    return hit;
  }

  static void _store(String code, String language, List<HighlightRun> runs) {
    final key = _key(code, language);
    _lru.remove(key);
    _lru[key] = runs;
    while (_lru.length > _capacity) {
      _lru.remove(_lru.keys.first);
    }
  }

  /// Whether a block this size gets colour at all.
  static bool eligible(String code) =>
      code.length <= asyncLimit &&
      '\n'.allMatches(code).length < asyncLineLimit;

  /// Highlight now (cached). For blocks within [syncLimit].
  static List<HighlightRun> highlightSync(String code, String language) {
    final hit = lookup(code, language);
    if (hit != null) return hit;
    final runs = highlightRuns((code: code, language: language));
    _store(code, language, runs);
    return runs;
  }

  /// Highlight in a background isolate (cached).
  static Future<List<HighlightRun>> highlightAsync(
    String code,
    String language,
  ) async {
    final hit = lookup(code, language);
    if (hit != null) return hit;
    final runs = await compute(
      highlightRuns,
      (code: code, language: language),
      debugLabel: 'highlight',
    );
    _store(code, language, runs);
    return runs;
  }

  /// Build the spans for [runs] under [theme] — the same nesting semantics as
  /// flutter_highlight (inner classes override outer ones).
  static List<TextSpan> spans(
    List<HighlightRun> runs,
    Map<String, TextStyle> theme,
  ) {
    return [
      for (final (text, classes) in runs)
        TextSpan(text: text, style: _style(classes, theme)),
    ];
  }

  static TextStyle? _style(List<String> classes, Map<String, TextStyle> theme) {
    TextStyle? style;
    for (final c in classes) {
      final s = theme[c];
      if (s == null) continue;
      style = style == null ? s : style.merge(s);
    }
    return style;
  }

  @visibleForTesting
  static int get debugSize => _lru.length;

  @visibleForTesting
  static void debugClear() => _lru.clear();
}

/// Highlight [job] into flat runs. Top-level so [compute] can send it to an
/// isolate. An unknown language (```console, ```text) yields one plain run
/// rather than throwing — `HighlightView` threw in build for those.
List<HighlightRun> highlightRuns(({String code, String language}) job) {
  List<Node> nodes;
  try {
    nodes = highlight.parse(job.code, language: job.language).nodes ?? [];
  } catch (_) {
    return [(job.code, const <String>[])];
  }
  final out = <HighlightRun>[];
  void walk(List<Node> level, List<String> stack) {
    for (final n in level) {
      final cls = n.className;
      final classes = cls == null ? stack : [...stack, cls];
      final value = n.value;
      final children = n.children;
      if (value != null) {
        out.add((value, classes));
      } else if (children != null) {
        walk(children, classes);
      }
    }
  }

  walk(nodes, const []);
  return out;
}
