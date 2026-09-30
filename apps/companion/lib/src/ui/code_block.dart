import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_highlight/themes/atom-one-dark.dart';
import 'package:flutter_highlight/themes/atom-one-light.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:markdown/markdown.dart' as md;

import '../theme.dart';
import 'highlight_cache.dart';

/// Renders fenced code blocks as framed, syntax-highlighted panels with a
/// language tag and a copy button — inline code falls through to the default
/// markdown styling (returning null keeps flutter_markdown's own rendering).
///
/// [live] marks a reply that is still streaming: its blocks change on every
/// token, so they only get (cached, synchronous) colour while small and never
/// start a background highlight that the next token would make stale.
class CodeElementBuilder extends MarkdownElementBuilder {
  final bool live;
  CodeElementBuilder({this.live = false});

  @override
  Widget? visitElementAfter(md.Element element, TextStyle? preferredStyle) {
    var language = '';
    final className = element.attributes['class'];
    if (className != null && className.startsWith('language-')) {
      language = className.substring('language-'.length);
    }
    final code = element.textContent;
    // Fenced blocks carry a language class or contain newlines; single-line
    // `inline code` gets the default pill styling from the stylesheet.
    final isBlock = language.isNotEmpty || code.contains('\n');
    if (!isBlock) return null;
    return CodeBlock(code: code.trimRight(), language: language, live: live);
  }
}

/// A framed code panel. Selection comes from the enclosing message's single
/// `SelectionArea` — the panel deliberately has none of its own (#1062:
/// nested selection systems inside a lazily-disposed list are a crash source
/// on desktop).
class CodeBlock extends StatefulWidget {
  final String code;
  final String language;
  final bool live;
  const CodeBlock({
    super.key,
    required this.code,
    this.language = '',
    this.live = false,
  });

  /// Longer blocks are cut to this many lines on screen (Copy still copies
  /// everything): laying out a 200 KB paragraph stalls the UI thread for
  /// seconds, and nobody reads line 40,000 of a log in a chat bubble.
  static const int maxDisplayLines = 1500;

  /// A finished block longer than this many lines opens folded to
  /// [collapsedLines], with a "Show all" toggle: a 60-line listing otherwise
  /// pushes the rest of the reply a screen or more down on a phone.
  static const int collapseAbove = 24;
  static const int collapsedLines = 14;

  @override
  State<CodeBlock> createState() => _CodeBlockState();
}

class _CodeBlockState extends State<CodeBlock> {
  bool _copied = false;

  /// What's drawn: tabs expanded (a tab renders as a single space-ish advance
  /// in Flutter text, collapsing indentation) and capped at
  /// [CodeBlock.maxDisplayLines]. The clipboard keeps the original.
  String _display = '';
  int _hiddenLines = 0;
  int _lines = 0;

  /// The reader opened a folded block (see [CodeBlock.collapseAbove]).
  bool _expanded = false;

  /// Highlight runs for [_display], or null to draw it plain (no language,
  /// too big, or a background highlight still in flight).
  List<HighlightRun>? _runs;
  bool _inFlight = false;

  @override
  void initState() {
    super.initState();
    _prepare();
  }

  @override
  void didUpdateWidget(CodeBlock old) {
    super.didUpdateWidget(old);
    if (old.code != widget.code || old.language != widget.language) {
      _prepare();
    }
  }

  void _prepare() {
    final expanded = widget.code.replaceAll('\t', '    ');
    final lines = '\n'.allMatches(expanded).length + 1;
    if (lines > CodeBlock.maxDisplayLines) {
      var cut = -1;
      for (var i = 0; i < CodeBlock.maxDisplayLines; i++) {
        cut = expanded.indexOf('\n', cut + 1);
      }
      _display = expanded.substring(0, cut);
      _hiddenLines = lines - CodeBlock.maxDisplayLines;
      _lines = CodeBlock.maxDisplayLines;
    } else {
      _display = expanded;
      _hiddenLines = 0;
      _lines = lines;
    }
    _runs = null;
    final language = widget.language;
    if (language.isEmpty || !HighlightCache.eligible(_display)) return;
    final hit = HighlightCache.lookup(_display, language);
    if (hit != null) {
      _runs = hit;
    } else if (_display.length <= HighlightCache.syncLimit) {
      _runs = HighlightCache.highlightSync(_display, language);
    } else if (!widget.live) {
      _highlightInBackground();
    }
  }

  /// At most one isolate per block at a time; if the code changed while it
  /// ran, the result is cached anyway and the current text goes next.
  void _highlightInBackground() {
    if (_inFlight) return;
    _inFlight = true;
    final code = _display;
    final language = widget.language;
    HighlightCache.highlightAsync(code, language).then((runs) {
      _inFlight = false;
      if (!mounted) return;
      if (code == _display && language == widget.language) {
        setState(() => _runs = runs);
      } else if (_runs == null && !widget.live) {
        _prepare();
      }
    }, onError: (Object _) {
      _inFlight = false;
    });
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.code));
    if (!mounted) return;
    setState(() => _copied = true);
    Future.delayed(const Duration(milliseconds: 1400), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  /// Plain `Text` / `Text.rich` (not the raw `RichText` HighlightView drew),
  /// so the enclosing SelectionArea can select it.
  static const double _codeFontSize = 12.5;
  static const double _codeLineHeight = 1.5;

  Widget _code() {
    final style = TalonType.mono
        .copyWith(fontSize: _codeFontSize, height: _codeLineHeight);
    final runs = _runs;
    if (runs == null) return Text(_display, style: style);
    final theme = TalonTheme.isDark ? atomOneDarkTheme : atomOneLightTheme;
    return Text.rich(
      TextSpan(
        style: TextStyle(color: theme['root']?.color).merge(style),
        children: HighlightCache.spans(runs, theme),
      ),
    );
  }

  bool get _collapsible => !widget.live && _lines > CodeBlock.collapseAbove;

  /// The scrolling code, folded to its first [CodeBlock.collapsedLines]
  /// lines (fading out at the cut) until the reader asks for the rest.
  Widget _body() {
    final Widget scroller = _FadingHScroll(
      padding: const EdgeInsets.all(12),
      child: _code(),
    );
    if (!_collapsible) return scroller;
    final folded = !_expanded;
    const line = _codeFontSize * _codeLineHeight;
    final full = _lines * line + 24;
    const shown = CodeBlock.collapsedLines * line + 12;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (folded)
          ClipRect(
            child: ShaderMask(
              blendMode: BlendMode.dstIn,
              shaderCallback: (rect) => const LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [Colors.white, Colors.white, Colors.transparent],
                stops: [0, 0.72, 1],
              ).createShader(rect),
              child: Align(
                alignment: Alignment.topLeft,
                heightFactor: (shown / full).clamp(0.0, 1.0),
                child: scroller,
              ),
            ),
          )
        else
          scroller,
        Semantics(
          button: true,
          expanded: !folded,
          child: InkWell(
            key: const Key('code-block-expand'),
            onTap: () => setState(() => _expanded = folded),
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 7),
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(color: TalonColors.glassStroke),
                ),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    folded ? Icons.unfold_more_rounded : Icons.unfold_less_rounded,
                    size: 14,
                    color: TalonColors.textFaint,
                  ),
                  const SizedBox(width: 5),
                  Text(
                    folded ? 'Show all $_lines lines' : 'Show less',
                    style: TextStyle(fontSize: 11.5, color: TalonColors.textDim),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(
        // On light mode the tinted fill reads as a weird grey slab; the
        // syntax colors + monospace font carry the "this is code" signal on
        // their own, so keep the panel frameless there (border alone delimits
        // it). Dark mode keeps the subtle inky panel.
        color: TalonTheme.isDark
            ? TalonColors.void0.withValues(alpha: 0.65)
            : Colors.transparent,
        borderRadius: TalonRadius.rMd,
        border: Border.all(color: TalonColors.glassStroke),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Header strip: language tag + copy affordance.
          Container(
            padding: const EdgeInsets.fromLTRB(12, 6, 6, 6),
            decoration: BoxDecoration(
              border: Border(
                bottom: BorderSide(color: TalonColors.glassStroke),
              ),
            ),
            child: Row(
              children: [
                Text(
                  widget.language.isEmpty ? 'code' : widget.language,
                  style: TalonType.mono.copyWith(
                    fontSize: 11,
                    color: TalonColors.textFaint,
                    letterSpacing: 0.4,
                  ),
                ),
                const Spacer(),
                // No label: the chip's own "Copy"/"Copied" text is the
                // announcement — adding one would make it say both.
                Semantics(
                  button: true,
                  child: InkWell(
                    onTap: _copy,
                    borderRadius: TalonRadius.rSm,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 4),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            _copied ? Icons.check : Icons.copy_rounded,
                            size: 13,
                            color: _copied
                                ? TalonColors.ok
                                : TalonColors.textFaint,
                          ),
                          const SizedBox(width: 5),
                          Text(
                            _copied ? 'Copied' : 'Copy',
                            style: TextStyle(
                              fontSize: 11,
                              color: _copied
                                  ? TalonColors.ok
                                  : TalonColors.textFaint,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          _body(),
          if (_hiddenLines > 0)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
              child: Text(
                '$_hiddenLines more lines not shown · Copy for the full block',
                style: TalonType.mono.copyWith(
                  fontSize: 11,
                  color: TalonColors.textFaint,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Horizontal code scroller whose overflowing edge fades out — the cue that
/// there's more off-screen. A hard clip at the panel border reads as
/// truncated output, not scrollable code.
class _FadingHScroll extends StatefulWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  const _FadingHScroll({required this.child, required this.padding});

  @override
  State<_FadingHScroll> createState() => _FadingHScrollState();
}

class _FadingHScrollState extends State<_FadingHScroll> {
  final ScrollController _controller = ScrollController();
  bool _fadeStart = false;
  bool _fadeEnd = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_update);
    // Extents aren't known until after the first layout.
    WidgetsBinding.instance.addPostFrameCallback((_) => _update());
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _update() {
    if (!mounted || !_controller.hasClients) return;
    final pos = _controller.position;
    final start = pos.extentBefore > 1;
    final end = pos.extentAfter > 1;
    if (start != _fadeStart || end != _fadeEnd) {
      setState(() {
        _fadeStart = start;
        _fadeEnd = end;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return NotificationListener<ScrollMetricsNotification>(
      // Fires when content/viewport size changes (e.g. streaming appends a
      // longer line) — scroll offsets go through the controller listener.
      onNotification: (_) {
        _update();
        return false;
      },
      child: ShaderMask(
        shaderCallback: (rect) {
          // dstIn: the gradient's alpha masks the child, so the fade works
          // over any panel/bubble background without color-matching it.
          final fade = (24.0 / rect.width).clamp(0.0, 0.35);
          return LinearGradient(
            begin: Alignment.centerLeft,
            end: Alignment.centerRight,
            colors: const [
              Colors.transparent,
              Colors.white,
              Colors.white,
              Colors.transparent,
            ],
            stops: [
              0,
              _fadeStart ? fade : 0,
              _fadeEnd ? 1 - fade : 1,
              1,
            ],
          ).createShader(rect);
        },
        blendMode: BlendMode.dstIn,
        child: SingleChildScrollView(
          controller: _controller,
          scrollDirection: Axis.horizontal,
          padding: widget.padding,
          child: widget.child,
        ),
      ),
    );
  }
}
