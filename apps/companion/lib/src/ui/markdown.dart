import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:markdown/markdown.dart' as md;

import '../theme.dart';

/// Shared Markdown style for assistant content — dark, readable, with framed
/// code blocks and accent links. Used by finalized messages and the live draft.
///
/// Tuned against the golden renders in test/golden: headings step down from
/// the body size instead of shouting over it, tables keep their natural
/// column widths and scroll sideways rather than wrapping `native.discoveryPort`
/// one syllable per line, and blocks get a little more air between them.
MarkdownStyleSheet talonMarkdownStyle() {
  final body = TalonDensity.d(14.5, 16);
  TextStyle heading(double size, {FontWeight weight = FontWeight.w700}) =>
      TextStyle(
        color: TalonColors.text,
        fontSize: size,
        fontWeight: weight,
        height: 1.3,
        letterSpacing: -0.1,
      );
  return MarkdownStyleSheet(
    p: TextStyle(color: TalonColors.text, fontSize: body, height: 1.55),
    blockSpacing: 10,
    a: TextStyle(
      color: TalonColors.accent2,
      decoration: TextDecoration.underline,
      decorationColor: TalonColors.accent2.withValues(alpha: 0.45),
    ),
    strong: TextStyle(color: TalonColors.text, fontWeight: FontWeight.w700),
    em: TextStyle(color: TalonColors.text, fontStyle: FontStyle.italic),
    del: TextStyle(
        color: TalonColors.textDim, decoration: TextDecoration.lineThrough),
    listBullet: TextStyle(color: TalonColors.textDim, fontSize: body),
    listIndent: 22,
    // Headings sit a step above the body, with space above them so a
    // heading reads as the start of a section rather than a bold paragraph.
    h1: heading(body + 5),
    h1Padding: const EdgeInsets.only(top: 6),
    h2: heading(body + 3),
    h2Padding: const EdgeInsets.only(top: 6),
    h3: heading(body + 1, weight: FontWeight.w600),
    h3Padding: const EdgeInsets.only(top: 4),
    h4: heading(body, weight: FontWeight.w600),
    h5: heading(body, weight: FontWeight.w600),
    h6: heading(body - 1, weight: FontWeight.w600)
        .copyWith(color: TalonColors.textDim),
    // Inline `code`: on the dark theme a faint ink wash sets it apart; on the
    // light (paper) theme that same wash reads as a muddy grey box, so drop it
    // — the accent color + monospace font already distinguish inline code.
    code: TextStyle(
      color: TalonColors.accent2,
      backgroundColor:
          TalonTheme.isDark ? const Color(0x22000000) : Colors.transparent,
      fontFamily: 'JetBrains Mono',
      fontSize: TalonDensity.d(13.2, 14.4),
    ),
    // Fenced code chrome lives entirely in CodeElementBuilder's framed panel.
    // flutter_markdown ALSO wraps the pre element in a Container carrying
    // this decoration — a visible one here double-frames every code block
    // (border inside border, slab behind panel). Empty, not null: the
    // wrapping Container clips with Clip.hardEdge, which asserts a non-null
    // decoration.
    codeblockDecoration: const BoxDecoration(),
    codeblockPadding: EdgeInsets.zero,
    blockquote: TextStyle(color: TalonColors.textDim, fontSize: body),
    blockquoteDecoration: BoxDecoration(
      color: TalonColors.glassFill,
      borderRadius: BorderRadius.circular(8),
      border: Border(
        left: BorderSide(color: TalonColors.accent, width: 3),
      ),
    ),
    blockquotePadding: const EdgeInsets.fromLTRB(12, 6, 12, 6),
    // Tables: natural column widths (IntrinsicColumnWidth is also what makes
    // flutter_markdown wrap the table in a horizontal scroller), header row
    // set apart by weight and colour, hairlines between rows only.
    tableColumnWidth: const IntrinsicColumnWidth(),
    tableScrollbarThumbVisibility: false,
    tableHead: TextStyle(
      color: TalonColors.text,
      fontWeight: FontWeight.w600,
      fontSize: body - 1.5,
    ),
    tableBody: TextStyle(color: TalonColors.text, fontSize: body - 1.5),
    tableHeadAlign: TextAlign.left,
    tableCellsPadding: const EdgeInsets.fromLTRB(12, 7, 12, 7),
    tableBorder: TableBorder(
      top: BorderSide(color: TalonColors.glassStroke),
      bottom: BorderSide(color: TalonColors.glassStroke),
      left: BorderSide(color: TalonColors.glassStroke),
      right: BorderSide(color: TalonColors.glassStroke),
      horizontalInside: BorderSide(color: TalonColors.glassStroke),
      borderRadius: BorderRadius.circular(8),
    ),
    horizontalRuleDecoration: BoxDecoration(
      border: Border(top: BorderSide(color: TalonColors.glassStroke)),
    ),
  );
}

/// Decodes common HTML entities (&quot;, &amp;, &lt;, &gt;, &apos;, &nbsp;, and
/// numeric character references) into raw characters.
String unescapeHtml(String text) {
  if (!text.contains('&')) return text;
  return text
      .replaceAll('&quot;', '"')
      .replaceAll('&#34;', '"')
      .replaceAll('&apos;', "'")
      .replaceAll('&#39;', "'")
      .replaceAll('&lt;', '<')
      .replaceAll('&#60;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&#62;', '>')
      .replaceAll('&nbsp;', ' ')
      .replaceAll('&#160;', ' ')
      .replaceAllMapped(RegExp(r'&#(?:x([0-9a-fA-F]+)|(\d+));'), (m) {
        final code = m[1] != null
            ? int.tryParse(m[1]!, radix: 16)
            : int.tryParse(m[2]!);
        if (code != null && code > 0 && code <= 0x10FFFF) {
          return String.fromCharCode(code);
        }
        return m[0]!;
      })
      .replaceAll('&amp;', '&')
      .replaceAll('&#38;', '&');
}

/// Compact Markdown for list previews. Unlike [MarkdownBody], this stays a
/// single [RichText], so callers keep proper max-lines + ellipsis behaviour
/// while common inline syntax is rendered instead of leaking `**` / `_` /
/// backticks into the chat list.
class InlineMarkdownText extends StatelessWidget {
  final String data;
  final TextStyle style;
  final int maxLines;

  const InlineMarkdownText({
    super.key,
    required this.data,
    required this.style,
    this.maxLines = 1,
  });

  /// Parsed previews, keyed by the raw preview text. The sidebar rebuilds
  /// every tile whenever the chat list changes; re-running the Markdown
  /// parser (and a whitespace regex) for each of them on every rebuild was
  /// pure waste — a preview only changes when a new message lands (#1059).
  static final Map<String, List<md.Node>> _parsed = {};
  static const int _parsedCapacity = 512;
  static final RegExp _space = RegExp(r'\s+');

  static List<md.Node> _parse(String data) {
    final hit = _parsed.remove(data);
    if (hit != null) return _parsed[data] = hit; // refresh LRU position
    final source = unescapeHtml(data.replaceAll(_space, ' ').trim());
    final nodes = md.Document(
      extensionSet: md.ExtensionSet.gitHubWeb,
      encodeHtml: false,
    ).parse(source);
    _parsed[data] = nodes;
    if (_parsed.length > _parsedCapacity) _parsed.remove(_parsed.keys.first);
    return nodes;
  }

  @override
  Widget build(BuildContext context) {
    final nodes = _parse(data);
    return Text.rich(
      TextSpan(style: style, children: _spans(nodes, style, separate: true)),
      maxLines: maxLines,
      overflow: TextOverflow.ellipsis,
      softWrap: maxLines > 1,
    );
  }

  static List<InlineSpan> _spans(
    List<md.Node> nodes,
    TextStyle inherited, {
    bool separate = false,
  }) {
    final spans = <InlineSpan>[];
    for (var i = 0; i < nodes.length; i++) {
      if (separate && i > 0) spans.add(const TextSpan(text: ' '));
      final node = nodes[i];
      if (node is md.Text) {
        spans.add(TextSpan(text: unescapeHtml(node.text), style: inherited));
        continue;
      }
      if (node is! md.Element) continue;

      if (node.tag == 'br') {
        spans.add(const TextSpan(text: ' '));
        continue;
      }
      if (node.tag == 'img') {
        spans.add(TextSpan(
          text: unescapeHtml(node.attributes['alt'] ?? 'Image'),
          style: inherited,
        ));
        continue;
      }

      final next = switch (node.tag) {
        'strong' ||
        'b' =>
          inherited.merge(const TextStyle(fontWeight: FontWeight.w700)),
        'em' ||
        'i' =>
          inherited.merge(const TextStyle(fontStyle: FontStyle.italic)),
        'del' => inherited
            .merge(const TextStyle(decoration: TextDecoration.lineThrough)),
        'code' => inherited.merge(TextStyle(
            color: TalonColors.accent2,
            fontFamily: 'JetBrains Mono',
            fontSize: (inherited.fontSize ?? 12) * 0.95,
          )),
        'a' => inherited.merge(TextStyle(
            color: TalonColors.accent,
            decoration: TextDecoration.underline,
          )),
        'h1' ||
        'h2' ||
        'h3' ||
        'h4' ||
        'h5' ||
        'h6' =>
          inherited.merge(const TextStyle(fontWeight: FontWeight.w700)),
        _ => inherited,
      };
      final children = node.children ?? const <md.Node>[];
      final separatesChildren = node.tag == 'ul' || node.tag == 'ol';
      spans.add(TextSpan(
        style: next,
        children: _spans(children, next, separate: separatesChildren),
      ));
    }
    return spans;
  }
}

/// Private-use sentinel standing in for the streaming caret inside Markdown
/// source; [StreamingCaretSyntax] turns it into a `caret` element.
const String kStreamingCaret = '\uE000';

/// [tail] (the live, still-growing end of a streaming reply) with the caret
/// sentinel appended, so the caret renders at the end of the last line being
/// written. A caret widget *beside* the tail landed at the far right of any
/// full-width block (a list item, a table), nowhere near the text.
///
/// Null when the tail ends inside an open code fence or code span: the
/// sentinel would print there as a literal character, so the caller shows a
/// standalone caret instead.
String? withInlineCaret(String tail) {
  final fences =
      RegExp(r'^\s*(```|~~~)', multiLine: true).allMatches(tail).length;
  final lastLine = tail.substring(tail.lastIndexOf('\n') + 1);
  if (fences.isOdd || '`'.allMatches(lastLine).length.isOdd) return null;
  return '$tail$kStreamingCaret';
}

/// Parses [kStreamingCaret] into an empty `caret` element.
class StreamingCaretSyntax extends md.InlineSyntax {
  StreamingCaretSyntax() : super(kStreamingCaret);

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    parser.addNode(md.Element.empty('caret'));
    return true;
  }
}

/// Draws the `caret` element as an inline block in the accent colour. It is
/// returned as `Text.rich` around a [WidgetSpan] so flutter_markdown merges
/// it into the paragraph's own RichText — any other widget type would break
/// the paragraph into a Wrap.
class StreamingCaretBuilder extends MarkdownElementBuilder {
  final Widget caret;
  StreamingCaretBuilder(this.caret);

  @override
  Widget? visitElementAfter(md.Element element, TextStyle? preferredStyle) =>
      Text.rich(WidgetSpan(
        alignment: PlaceholderAlignment.middle,
        child: caret,
      ));
}

/// Where finished blocks end in a streaming Markdown [text], scanning from
/// [from] (0, or an offset this function returned earlier for a prefix of
/// the same text).
///
/// A break is the start of a non-indented line that follows a blank line
/// outside any fenced code block — the point after which nothing typed later
/// can change how the text before it parses (an indented line after a blank
/// may still belong to the previous list item, so it never breaks). A line
/// that is still being typed can start a block but never ends one.
List<int> markdownBlockBreaks(String text, {int from = 0}) {
  final breaks = <int>[];
  String? fence; // the open fence's marker (``` or ~~~), if inside one
  var sawBlank = false;
  var lineStart = from;
  while (lineStart < text.length) {
    final nl = text.indexOf('\n', lineStart);
    final complete = nl >= 0;
    final end = complete ? nl : text.length;
    final line = text.substring(lineStart, end);
    final trimmed = line.trimLeft();
    if (fence != null) {
      if (!complete) break;
      if (trimmed.startsWith(fence)) fence = null;
    } else if (trimmed.isEmpty) {
      if (!complete) break;
      sawBlank = true;
    } else {
      final indented = line.startsWith(' ') || line.startsWith('\t');
      if (sawBlank && !indented) breaks.add(lineStart);
      sawBlank = false;
      if (!complete) break;
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
        fence = trimmed.substring(0, 3);
      }
    }
    lineStart = nl + 1;
  }
  return breaks;
}
