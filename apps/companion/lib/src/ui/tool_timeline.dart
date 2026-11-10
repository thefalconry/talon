import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';

import '../models/bridge_models.dart';
import '../models/tool_format.dart';
import '../theme.dart';

// The pure name helpers live in models/ so non-UI code (the voice session)
// can format a tool name without importing widgets. Re-exported here because
// every widget that renders a tool already imports this file.
export '../models/tool_format.dart';
import 'motion.dart';
import 'effects.dart';

/// The agent's tool activity, rendered as a connected vertical timeline: one
/// node per call, linked by a hairline rail, with a live spinner while running
/// and a calm check / warning when finished. Tapping a step reveals its full
/// input as formatted JSON (and its error, if any). Errored steps open on
/// their own so a failure is never hidden behind a tap.
///
/// Used in two places with the same visual language:
///   - live, under the streaming reply ([LiveTurn]);
///   - in history, tucked inside a collapsible [ToolTrace] summary.
class ToolTimeline extends StatelessWidget {
  final List<ToolActivity> tools;
  const ToolTimeline({super.key, required this.tools});

  @override
  Widget build(BuildContext context) {
    if (tools.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < tools.length; i++)
          ToolStep(
            key: ValueKey(tools[i].id),
            tool: tools[i],
            isFirst: i == 0,
            isLast: i == tools.length - 1,
          ),
      ],
    );
  }
}

/// A single node in the [ToolTimeline].
class ToolStep extends StatefulWidget {
  final ToolActivity tool;
  final bool isFirst;
  final bool isLast;

  const ToolStep({
    super.key,
    required this.tool,
    this.isFirst = true,
    this.isLast = true,
  });

  @override
  State<ToolStep> createState() => _ToolStepState();
}

class _ToolStepState extends State<ToolStep> {
  bool _expanded = false;
  bool _userToggled = false;
  Timer? _ticker;

  bool get _failed => widget.tool.error != null;
  bool get _running => !widget.tool.done && !_failed;
  bool get _hasDetail =>
      widget.tool.input.isNotEmpty ||
      (widget.tool.output?.isNotEmpty ?? false) ||
      widget.tool.error != null;
  // Only offer the disclosure once the call has finished — a running tool's
  // detail is incomplete (no result yet), so expanding it mid-flight is noise.
  bool get _expandable => widget.tool.done && _hasDetail;

  @override
  void initState() {
    super.initState();
    // Keep the elapsed readout live while the call is in flight.
    if (_running) {
      _ticker = Timer.periodic(const Duration(milliseconds: 200), (_) {
        if (mounted && _running) setState(() {});
      });
    }
    _expanded = _failed; // a failure explains itself without a tap.
  }

  @override
  void didUpdateWidget(covariant ToolStep old) {
    super.didUpdateWidget(old);
    if (!_running) {
      _ticker?.cancel();
      _ticker = null;
    }
    // Surface a freshly-arrived error automatically (unless the user has
    // deliberately collapsed this step).
    if (_failed && !_userToggled && !_expanded) {
      _expanded = true;
    }
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  Color get _statusColor => _failed
      ? TalonColors.bad
      : (widget.tool.done ? TalonColors.ok : TalonColors.accent2);

  @override
  Widget build(BuildContext context) {
    final row = IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _rail(context),
          const SizedBox(width: TalonSpace.md),
          Expanded(child: _content(context)),
        ],
      ),
    );

    if (reduceMotion(context)) return row;
    return row
        .animate()
        .fadeIn(duration: TalonMotion.base, curve: TalonMotion.emphasized)
        .slideY(begin: 0.18, end: 0, curve: TalonMotion.emphasized);
  }

  /// The node + the hairline connector that links it to the next step.
  Widget _rail(BuildContext context) {
    return SizedBox(
      width: 20,
      child: Column(
        children: [
          _node(context),
          if (!widget.isLast)
            Expanded(
              child: Container(
                width: 1.5,
                margin: const EdgeInsets.only(top: 2, bottom: 2),
                color: TalonColors.glassStroke,
              ),
            ),
        ],
      ),
    );
  }

  Widget _node(BuildContext context) {
    final color = _statusColor;
    final ring = Container(
      width: 20,
      height: 20,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: color.withValues(alpha: 0.14),
        border: Border.all(color: color.withValues(alpha: 0.55), width: 1.4),
      ),
      alignment: Alignment.center,
      child: _running
          ? SizedBox(
              width: 10,
              height: 10,
              child: CircularProgressIndicator(
                strokeWidth: 1.8,
                valueColor: AlwaysStoppedAnimation(color),
              ),
            )
          : Icon(
              _failed ? Icons.priority_high_rounded : Icons.check_rounded,
              size: 12,
              color: color,
            ),
    );

    // A soft breathing halo behind a running node — the one bit of ambient
    // motion, kept subtle and gated on the platform reduce-motion setting.
    if (!_running || reduceMotion(context)) return ring;
    return Stack(
      alignment: Alignment.center,
      children: [
        Container(
          width: 20,
          height: 20,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: color.withValues(alpha: 0.5),
          ),
        )
            .animate(onPlay: (c) => c.repeat(reverse: true))
            .fadeOut(duration: 1100.ms, curve: Curves.easeInOut)
            .scaleXY(end: 1.9, curve: Curves.easeOut)
            .wrapAmbient(),
        ring,
      ],
    );
  }

  Widget _content(BuildContext context) {
    final tool = widget.tool;
    final arg = toolArg(tool);
    final header = Row(
      children: [
        Flexible(
          child: Text(
            toolDisplayName(tool.name),
            maxLines: 1,
            softWrap: false,
            overflow: TextOverflow.ellipsis,
            style: TalonType.mono.copyWith(fontWeight: FontWeight.w600),
          ),
        ),
        if (arg != null) ...[
          const SizedBox(width: TalonSpace.sm),
          Flexible(
            child: Text(
              arg,
              maxLines: 1,
              softWrap: false,
              overflow: TextOverflow.ellipsis,
              style: TalonType.mono.copyWith(
                fontSize: 12,
                color: TalonColors.textFaint,
              ),
            ),
          ),
        ],
        const SizedBox(width: TalonSpace.sm),
        if (_running) _StatusBadge('Running', TalonColors.accent2),
        if (_failed) _StatusBadge('Failed', TalonColors.bad),
        const SizedBox(width: TalonSpace.sm),
        Text(
          fmtToolDuration(tool.elapsed),
          maxLines: 1,
          softWrap: false,
          style: TextStyle(
            color: TalonColors.textFaint,
            fontSize: 11.5,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
        if (_expandable)
          AnimatedRotation(
            duration: TalonMotion.fast,
            turns: _expanded ? 0.25 : 0,
            child: Icon(Icons.chevron_right,
                size: 16, color: TalonColors.textFaint),
          )
        else
          const SizedBox(width: 4),
      ],
    );

    return Padding(
      padding: const EdgeInsets.only(bottom: TalonSpace.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            button: _expandable,
            enabled: _expandable,
            expanded: _expandable ? _expanded : null,
            child: InkWell(
              onTap: _expandable
                  ? () {
                      final willExpand = !_expanded;
                      setState(() {
                        _expanded = willExpand;
                        _userToggled = true;
                      });
                      if (willExpand) {
                        WidgetsBinding.instance.addPostFrameCallback((_) {
                          if (!mounted) return;
                          Scrollable.ensureVisible(
                            context,
                            alignmentPolicy:
                                ScrollPositionAlignmentPolicy.keepVisibleAtEnd,
                          );
                        });
                      }
                    }
                  : null,
              borderRadius: TalonRadius.rSm,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: header,
              ),
            ),
          ),
          AnimatedSize(
            duration: TalonMotion.fast,
            curve: TalonMotion.emphasized,
            alignment: Alignment.topLeft,
            child: _expanded && _expandable
                ? _details(context)
                : const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }

  Widget _details(BuildContext context) {
    final tool = widget.tool;
    // A labeled section per meaningful field — `command: …`, `output: …` —
    // instead of one raw JSON dump. The `description` is skipped (it's already
    // the inline header), and empty values are dropped.
    final rows = <Widget>[];
    tool.input.forEach((key, value) {
      if (key == 'description') return;
      final text = _stringifyValue(value);
      if (text.isEmpty) return;
      rows.add(_LabeledBlock(label: key, text: text));
    });
    final output = tool.output;
    if (output != null && output.isNotEmpty) {
      rows.add(_LabeledBlock(label: 'output', text: output));
    }
    if (tool.error != null) {
      rows.add(
        _LabeledBlock(label: 'error', text: tool.error!, tone: TalonColors.bad),
      );
    }
    if (rows.isEmpty) return const SizedBox(width: double.infinity);

    return Padding(
      padding: const EdgeInsets.only(top: TalonSpace.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var i = 0; i < rows.length; i++) ...[
            if (i > 0) const SizedBox(height: TalonSpace.sm),
            rows[i],
          ],
        ],
      ),
    );
  }
}

/// One labeled detail row in an expanded tool step: a small caption
/// (`COMMAND`, `OUTPUT`, `ERROR`) above a framed monospace value.
class _LabeledBlock extends StatelessWidget {
  final String label;
  final String text;
  final Color? tone;
  const _LabeledBlock({required this.label, required this.text, this.tone});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 4, left: 2),
          child: Text(
            label.toUpperCase(),
            style: TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.8,
              color: tone ?? TalonColors.textFaint,
            ),
          ),
        ),
        _CodeBlock(text: text, tone: tone),
      ],
    );
  }
}

/// A small pill that names a live state ("Running" / "Failed") so status is
/// read from text, not colour alone (colour-blind friendly).
class _StatusBadge extends StatelessWidget {
  final String label;
  final Color color;
  const _StatusBadge(this.label, this.color);

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      margin: const EdgeInsets.only(right: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: TalonRadius.rPill,
        border: Border.all(color: color.withValues(alpha: 0.3)),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 10.5,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.3,
        ),
      ),
    );
  }
}

/// A framed, selectable monospace block for tool input / error detail.
class _CodeBlock extends StatelessWidget {
  final String text;
  final Color? tone;
  const _CodeBlock({required this.text, this.tone});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(TalonSpace.md),
      decoration: BoxDecoration(
        color: TalonColors.void0.withValues(alpha: 0.6),
        borderRadius: TalonRadius.rSm,
        border: Border.all(
          color: (tone ?? TalonColors.glassStroke)
              .withValues(alpha: tone == null ? 1 : 0.4),
        ),
      ),
      child: SelectableText(
        text,
        style: TalonType.mono.copyWith(
          fontSize: 12,
          height: 1.5,
          color: tone ?? TalonColors.textDim,
        ),
      ),
    );
  }
}

/// A collapsed tool group: one quiet row that stands in for a run of tool
/// calls — "Ran 3 commands, read 2 files · 4.2s" — and expands to the full
/// [ToolTimeline] on tap, the way the Claude desktop app folds its tool use.
///
/// Used for both the live turn and message history, so a reply doesn't change
/// shape when it finalizes. While a call is in flight the row shows a spinner
/// and what's running now. A failed step opens the group by itself (unless the
/// user has closed it) so an error is never buried behind a tap.
class ToolTrace extends StatefulWidget {
  final List<ToolActivity> tools;
  const ToolTrace({super.key, required this.tools});

  @override
  State<ToolTrace> createState() => _ToolTraceState();
}

class _ToolTraceState extends State<ToolTrace> {
  late bool _open = _anyFailed;
  bool _userToggled = false;
  Timer? _ticker;

  bool get _anyFailed => widget.tools.any((t) => t.error != null);

  ToolActivity? get _running {
    for (final t in widget.tools.reversed) {
      if (!t.done && t.error == null) return t;
    }
    return null;
  }

  @override
  void initState() {
    super.initState();
    _syncTicker();
  }

  @override
  void didUpdateWidget(covariant ToolTrace old) {
    super.didUpdateWidget(old);
    if (_anyFailed && !_open && !_userToggled) _open = true;
    _syncTicker();
  }

  // The live list is mutated in place and the row only rebuilds when the
  // turn notifies, so tick while something runs to keep the label current.
  void _syncTicker() {
    if (_running != null) {
      _ticker ??= Timer.periodic(const Duration(milliseconds: 500), (_) {
        if (mounted) setState(() {});
      });
    } else {
      _ticker?.cancel();
      _ticker = null;
    }
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tools = widget.tools;
    if (tools.isEmpty) return const SizedBox.shrink();
    final failed = tools.where((t) => t.error != null).length;
    final running = _running;

    final Widget leading = running != null
        ? SizedBox(
            width: 12,
            height: 12,
            child: CircularProgressIndicator(
              strokeWidth: 1.6,
              color: TalonColors.accent2,
            ),
          )
        : Icon(
            failed > 0 ? Icons.error_outline : Icons.terminal_rounded,
            size: 13,
            color: failed > 0 ? TalonColors.bad : TalonColors.textFaint,
          );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          button: true,
          expanded: _open,
          child: InkWell(
            key: const Key('tool-group-toggle'),
            onTap: () => setState(() {
              _open = !_open;
              _userToggled = true;
            }),
            borderRadius: TalonRadius.rSm,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  leading,
                  const SizedBox(width: 7),
                  // Flexible + ellipsis: on a phone-width bubble the label
                  // can exceed the row and an unconstrained Text overflows.
                  Flexible(
                    child: Text(
                      toolTraceLabel(tools),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: TalonColors.textDim,
                        fontSize: 12.5,
                      ),
                    ),
                  ),
                  const SizedBox(width: 2),
                  AnimatedRotation(
                    duration: TalonMotion.fast,
                    turns: _open ? 0.25 : 0,
                    child: Icon(Icons.chevron_right,
                        size: 16, color: TalonColors.textFaint),
                  ),
                ],
              ),
            ),
          ),
        ),
        AnimatedSize(
          duration: TalonMotion.base,
          curve: TalonMotion.emphasized,
          alignment: Alignment.topLeft,
          child: _open
              ? Padding(
                  padding: const EdgeInsets.only(top: 6, left: 4),
                  child: ToolTimeline(tools: tools),
                )
              : const SizedBox(width: double.infinity),
        ),
      ],
    );
  }
}

/// The collapsed group's label. Finished: `Ran 3 commands, read 2 files · 4.2s`
/// (plus `· 1 failed`). In flight: what's running now, e.g. `Run a command…`,
/// with a count of the steps already done.
String toolTraceLabel(List<ToolActivity> tools) {
  ToolActivity? running;
  for (final t in tools.reversed) {
    if (!t.done && t.error == null) {
      running = t;
      break;
    }
  }
  final failed = tools.where((t) => t.error != null).length;
  if (running != null) {
    final done = tools.where((t) => t.done || t.error != null).length;
    final now = '${toolPhrase(running.name)}…';
    return done == 0 ? now : '$now · $done done';
  }
  final total = Duration(
    milliseconds: tools.fold<int>(0, (a, t) => a + t.elapsed.inMilliseconds),
  );
  final base = '${toolGroupSummary([for (final t in tools) t.name])}'
      ' · ${fmtToolDuration(total)}';
  return failed == 0 ? base : '$base · $failed failed';
}

// ── Shared formatting helpers ────────────────────────────────────────────────

/// A glyph for a tool, matched on the whole raw name so an MCP server's
/// subject ("email", "market", "device") counts as much as the verb. Specific
/// matches come first; the fallback is the timeline's own sparkle.
IconData toolIcon(String raw) {
  final n = raw.toLowerCase();
  bool has(List<String> keys) => keys.any(n.contains);
  if (has(['mail', 'inbox'])) return Icons.mail_outline_rounded;
  if (has(['calendar', 'event', 'schedule', 'cron', 'remind'])) {
    return Icons.event_outlined;
  }
  if (has(['weather'])) return Icons.wb_sunny_outlined;
  if (has(['bash', 'shell', 'exec', 'command', 'terminal'])) {
    return Icons.terminal_rounded;
  }
  if (has(
      ['browser', 'playwright', 'scrape', 'crawl', 'fetch', 'url', 'web'])) {
    return Icons.public_rounded;
  }
  if (has(['search', 'grep', 'glob', 'find', 'query', 'lookup'])) {
    return Icons.search_rounded;
  }
  if (has(['memory', 'palace', 'drawer', 'recall'])) {
    return Icons.psychology_outlined;
  }
  if (has(['device', 'mesh', 'phone', 'teleport', 'ring'])) {
    return Icons.smartphone_rounded;
  }
  if (has(['market', 'order', 'trade', 'price', 'currency'])) {
    return Icons.trending_up_rounded;
  }
  if (has(['image', 'photo', 'video', 'ffmpeg', 'render', 'sticker'])) {
    return Icons.image_outlined;
  }
  if (has(['github', 'git', 'pull_request', 'commit', 'code'])) {
    return Icons.code_rounded;
  }
  if (has(['send', 'message', 'reply', 'post', 'telegram', 'discord'])) {
    return Icons.send_rounded;
  }
  if (has(['read', 'write', 'edit', 'file', 'document', 'note'])) {
    return Icons.description_outlined;
  }
  if (has(['flight', 'travel', 'transit', 'tfi', 'departure'])) {
    return Icons.directions_transit_rounded;
  }
  return Icons.auto_awesome_outlined;
}

/// Pick the most telling argument to preview inline next to the tool name.
/// `description` leads: Bash carries a human summary there, which reads far
/// better inline than the raw shell command (shown in the expansion instead).
String? toolArg(ToolActivity t) {
  if (t.input.isEmpty) return null;
  for (final key in const [
    'description',
    'query',
    'url',
    'path',
    'text',
    'name',
    'command',
  ]) {
    final v = t.input[key];
    if (v is String && v.isNotEmpty) {
      final flat = v.replaceAll(RegExp(r'\s+'), ' ').trim();
      return flat.length > 64 ? '${flat.substring(0, 63)}…' : flat;
    }
  }
  return null;
}

/// Compact elapsed-time formatting: `840ms`, `4.2s`, `12s`, `1m30s`.
String fmtToolDuration(Duration d) {
  final ms = d.inMilliseconds;
  if (ms < 1000) return '${ms}ms';
  final s = ms / 1000;
  if (s < 10) return '${s.toStringAsFixed(1)}s';
  if (s < 60) return '${s.toStringAsFixed(0)}s';
  final m = (s / 60).floor();
  return '${m}m${(s - m * 60).toStringAsFixed(0)}s';
}

/// Render a single input value for the expanded view: strings verbatim,
/// everything else as compact indented JSON. Bounded so a big blob can't run
/// away.
String _stringifyValue(Object? value) {
  if (value == null) return '';
  String text;
  if (value is String) {
    text = value.trim();
  } else {
    try {
      text = const JsonEncoder.withIndent('  ').convert(value);
    } catch (_) {
      text = value.toString();
    }
  }
  return text.length > 1400 ? '${text.substring(0, 1399)}…' : text;
}
