import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_markdown/flutter_markdown.dart';

import '../state/app_state.dart';
import '../theme.dart';
import 'assistant_surface.dart';
import 'code_block.dart';
import 'markdown.dart';
import 'tool_timeline.dart';
import 'effects.dart';

/// The in-progress turn, rendered in the assistant-row layout: the Talon
/// avatar, the model's reasoning, the live tool timeline, and the streaming
/// reply (with a blinking caret while text is still arriving).
///
/// Listens to its own [TurnState]: streamed tokens rebuild this row — and
/// only this row — at most once per frame (#1059).
class LiveTurn extends StatelessWidget {
  final TurnState turn;
  final String botName;

  /// False when the live turn continues a run of assistant messages the model
  /// already delivered mid-turn (send_message): the run's first row carries
  /// the avatar + name, so this row only adds the work still in progress.
  final bool showHeader;

  const LiveTurn({
    super.key,
    required this.turn,
    required this.botName,
    this.showHeader = true,
  });

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(listenable: turn, builder: _build);
  }

  Widget _build(BuildContext context, Widget? _) {
    // Same anatomy as a finished turn: reasoning and the tool timeline live
    // on the canvas above the bubble; only the streaming reply text wears the
    // bubble. Until text arrives, no bubble is drawn at all — one quiet
    // working row sits on the canvas instead.
    final hasPre = turn.reasoning.isNotEmpty || turn.tools.isNotEmpty;
    final streaming = turn.draft.isNotEmpty;
    // A running tool already animates (its spinner) and names what is
    // happening, so it *is* the working row; a second "Working…" under it
    // would say the same thing twice.
    final toolRunning = turn.tools.any((t) => !t.done && t.error == null);
    return AssistantSurface(
      botName: botName,
      surfaceKey: const Key('assistant-live-card'),
      showHeader: showHeader,
      aboveBubble: hasPre
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (turn.reasoning.isNotEmpty)
                  _ReasoningStrip(
                    text: turn.reasoning.join(''),
                    // Once the reply starts streaming — or the model is
                    // already mid-run delivering messages — the thinking is
                    // background: fold the strip into a quiet pill (tap
                    // re-expands).
                    condensed: streaming || !showHeader,
                  ),
                if (turn.tools.isNotEmpty) ToolTrace(tools: turn.tools),
              ],
            )
          : null,
      bubble: streaming ? _StreamingText(text: turn.draft) : null,
      belowBubble: streaming || toolRunning
          ? null
          : WorkingRow(
              key: const ValueKey('working'),
              label: turn.reasoning.isNotEmpty && !turn.continuing
                  ? 'Thinking…'
                  : 'Working…',
            ),
    );
  }
}

/// The streaming draft with a blinking caret pinned to its end — the expected
/// "still generating" signal. The caret sits inline after the markdown so it
/// tracks the last line of text.
class _StreamingText extends StatefulWidget {
  final String text;
  const _StreamingText({required this.text});

  @override
  State<_StreamingText> createState() => _StreamingTextState();
}

/// Streaming Markdown without the O(n²): the draft is split at paragraph
/// breaks ([markdownBlockBreaks]) into finished blocks and a live tail. Each
/// finished block is built into a widget exactly once and the same instance
/// is handed back on every later rebuild, so Flutter skips it entirely — no
/// re-parse, no re-layout, no re-highlight. Only the tail (the paragraph
/// being written) is re-parsed per frame. Before, the whole reply so far was
/// re-parsed on every token (#1059).
class _StreamingTextState extends State<_StreamingText> {
  /// Offsets in the draft where finished blocks end.
  final List<int> _breaks = [];
  final List<Widget> _blocks = [];

  /// The finished prefix, to detect a reset (a new, unrelated draft).
  String _stable = '';

  /// Matches MarkdownBody's own default spacing between blocks.
  static const double _blockGap = 8;

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(_StreamingText old) {
    super.didUpdateWidget(old);
    if (old.text != widget.text) _sync();
  }

  void _sync() {
    final text = widget.text;
    if (!text.startsWith(_stable)) {
      _breaks.clear();
      _blocks.clear();
      _stable = '';
    }
    for (final end in markdownBlockBreaks(text, from: _stableEnd)) {
      final block = text.substring(_stableEnd, end);
      _breaks.add(end);
      if (block.trim().isEmpty) continue;
      _blocks.add(Padding(
        padding: const EdgeInsets.only(bottom: _blockGap),
        // Finished blocks never change again: full (highlighted) code blocks.
        child: _markdown(block),
      ));
    }
    _stable = text.substring(0, _stableEnd);
  }

  int get _stableEnd => _breaks.isEmpty ? 0 : _breaks.last;

  Widget _markdown(String data, {bool live = false, Widget? caret}) =>
      MarkdownBody(
        data: data,
        // Same builder as finalized messages — without it, a code block
        // renders as a bare grey slab while streaming and then jumps to
        // the framed panel on finalize. The tail passes live: no background
        // highlight per token (see CodeBlock).
        builders: {
          'code': CodeElementBuilder(live: live),
          if (caret != null) 'caret': StreamingCaretBuilder(caret),
        },
        inlineSyntaxes: [if (caret != null) StreamingCaretSyntax()],
        styleSheet: talonMarkdownStyle(),
      );

  @override
  Widget build(BuildContext context) {
    final still = MediaQuery.of(context).disableAnimations;
    final tail = widget.text.substring(_stableEnd);
    final inline = tail.trim().isEmpty ? null : withInlineCaret(tail);
    return Column(
      key: const ValueKey('draft'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ..._blocks,
        if (tail.trim().isNotEmpty)
          _markdown(
            inline ?? tail,
            live: true,
            caret: inline == null ? null : _Caret(still: still),
          ),
        // Between blocks (the last one just finished), or inside open code
        // where the inline sentinel would print: a caret on its own line.
        if (inline == null) _Caret(still: still, standalone: true),
      ],
    );
  }
}

/// The streaming caret: a small accent block, blinking where motion is
/// allowed.
class _Caret extends StatelessWidget {
  final bool still;
  final bool standalone;
  const _Caret({required this.still, this.standalone = false});

  @override
  Widget build(BuildContext context) {
    final caret = Container(
      key: const Key('streaming-caret'),
      width: 7,
      height: 15,
      margin: EdgeInsets.only(left: standalone ? 1 : 2, top: standalone ? 2 : 0),
      decoration: BoxDecoration(
        color: TalonColors.accent2,
        borderRadius: BorderRadius.circular(2),
      ),
    );
    if (still) return caret;
    return caret
        .animate(onPlay: (c) => c.repeat(reverse: true))
        .fadeOut(duration: 650.ms, curve: Curves.easeInOut)
        .wrapAmbient();
  }
}

/// The model's live reasoning, in a quiet accent-edged strip. Fades/blurs in
/// so it doesn't pop when the model starts thinking, and folds into a
/// one-line pill once the reply starts streaming (tap to re-expand) — the
/// pattern users know from the Claude/ChatGPT apps.
class _ReasoningStrip extends StatefulWidget {
  final String text;
  final bool condensed;
  const _ReasoningStrip({required this.text, this.condensed = false});

  @override
  State<_ReasoningStrip> createState() => _ReasoningStripState();
}

class _ReasoningStripState extends State<_ReasoningStrip> {
  /// The user's explicit choice, overriding the automatic fold. Null = auto.
  bool? _userExpanded;

  bool get _expanded => _userExpanded ?? !widget.condensed;

  @override
  Widget build(BuildContext context) {
    if (!_expanded) {
      return Padding(
        padding: const EdgeInsets.only(bottom: TalonSpace.sm),
        child: Semantics(
          button: true,
          expanded: false,
          child: InkWell(
            onTap: () => setState(() => _userExpanded = true),
            borderRadius: TalonRadius.rPill,
            child: Container(
              padding: const EdgeInsets.symmetric(
                  horizontal: TalonSpace.md, vertical: 5),
              decoration: BoxDecoration(
                color: TalonColors.glassFill,
                borderRadius: TalonRadius.rPill,
                border: Border.all(color: TalonColors.glassStroke),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.bubble_chart_outlined,
                      size: 13, color: TalonColors.textFaint),
                  const SizedBox(width: 6),
                  Text(
                    'Thought — tap to expand',
                    style:
                        TextStyle(fontSize: 11.5, color: TalonColors.textFaint),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    }
    return _strip(context);
  }

  Widget _strip(BuildContext context) {
    final text = widget.text;
    final strip = Padding(
      padding: const EdgeInsets.only(bottom: TalonSpace.sm),
      child: Container(
        padding:
            const EdgeInsets.symmetric(horizontal: TalonSpace.md, vertical: 9),
        decoration: BoxDecoration(
          borderRadius: TalonRadius.rMd,
          border: Border(
            left: BorderSide(color: TalonColors.accent, width: 2.5),
          ),
          color: TalonColors.glassFill,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.bubble_chart_outlined,
                size: 15, color: TalonColors.textFaint),
            const SizedBox(width: TalonSpace.sm),
            Expanded(
              child: AnimatedSize(
                duration: TalonMotion.base,
                curve: TalonMotion.emphasized,
                alignment: Alignment.topLeft,
                child: Text(
                  text.trim(),
                  maxLines: 5,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: TalonColors.textDim,
                    fontSize: 12.5,
                    height: 1.45,
                    fontStyle: FontStyle.italic,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
    // While the reply streams, the expanded strip stays tappable to fold
    // back down (the pill re-expands it).
    final Widget body = widget.condensed
        ? Semantics(
            button: true,
            expanded: true,
            label: 'Hide activity',
            child: GestureDetector(
              onTap: () => setState(() => _userExpanded = false),
              child: strip,
            ),
          )
        : strip;
    if (MediaQuery.of(context).disableAnimations) return body;
    return body.animate().fadeIn(duration: TalonMotion.base).blurX(
          begin: 3,
          end: 0,
          duration: TalonMotion.base,
          curve: TalonMotion.emphasized,
        );
  }
}

/// The one quiet "still working" row under an in-progress turn: three softly
/// breathing accent dots and a short label, with no chrome around it. Shown
/// while the model is thinking or working between delivered messages, and
/// gone the moment reply text streams or the turn ends — so a run of
/// mid-turn messages reads as one reply still being written rather than a
/// finished bubble followed by a separate "Talon · Working" card.
class WorkingRow extends StatelessWidget {
  final String label;
  const WorkingRow({super.key, this.label = 'Working…'});

  @override
  Widget build(BuildContext context) {
    final still = MediaQuery.of(context).disableAnimations;
    Widget dot(int i) {
      final base = Container(
        width: 5,
        height: 5,
        margin: const EdgeInsets.only(right: 3),
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: TalonColors.accent2,
        ),
      );
      if (still) return base;
      return base
          .animate(onPlay: (c) => c.repeat(reverse: true))
          .fadeIn(
              delay: (i * 180).ms,
              begin: 0.25,
              duration: 700.ms,
              curve: Curves.easeInOut)
          .wrapAmbient();
    }

    final row = Semantics(
      liveRegion: true,
      label: label,
      excludeSemantics: true,
      child: Padding(
        key: const Key('working-row'),
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            dot(0),
            dot(1),
            dot(2),
            const SizedBox(width: 6),
            Text(
              label,
              style: TextStyle(fontSize: 12.5, color: TalonColors.textFaint),
            ),
          ],
        ),
      ),
    );
    if (still) return row;
    return row.animate().fadeIn(duration: TalonMotion.base);
  }
}
