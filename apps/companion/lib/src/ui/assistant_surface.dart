import 'package:flutter/material.dart';

import '../theme.dart';
import 'brand.dart';

/// Shared assistant-turn layout for completed and live turns.
///
/// The identity header (avatar + name + timestamp / live badge), the tool
/// activity, and the stats footer all live OUTSIDE the reply bubble on the
/// open canvas — only the reply content itself wears the bubble, like a chat
/// app. Keeping live and history turns in the same silhouette prevents the
/// streaming reply from jumping when it becomes history.
class AssistantSurface extends StatelessWidget {
  final String botName;

  /// Small widget beside the name: a clock stamp in history, the live badge
  /// while streaming. Sits in the header row, outside the bubble.
  final Widget? trailing;

  /// Rendered on the canvas between the header and the bubble — tool
  /// timelines / traces, reasoning strips.
  final Widget? aboveBubble;

  /// The reply content. Wrapped in the response bubble; null renders no
  /// bubble at all (e.g. a live turn that hasn't produced text yet).
  final Widget? bubble;

  /// Rendered on the canvas under the bubble — copy action, token/duration
  /// stats, buttons, reactions, typing indicators.
  final Widget? belowBubble;

  /// Applied to the bubble container so tests/screenshots can find it.
  final Key? surfaceKey;

  /// False for a turn grouped under the previous assistant row: the avatar +
  /// name header is skipped (the run's first row already carries it) and the
  /// content stays aligned by an avatar-width gutter.
  final bool showHeader;

  /// True when another row of the same run follows (a further message the
  /// model delivered mid-turn, or the live turn still working): the gap below
  /// shrinks so the run reads as one reply, and on desktop the bubble's
  /// lower-left corner tightens to join the next one.
  final bool continues;

  const AssistantSurface({
    super.key,
    required this.botName,
    this.trailing,
    this.aboveBubble,
    this.bubble,
    this.belowBubble,
    this.surfaceKey,
    this.showHeader = true,
    this.continues = false,
  });

  @override
  Widget build(BuildContext context) {
    if (TalonDensity.touch) return _phone(context);
    return _pointer(context);
  }

  /// Phone anatomy: the reply is the page, not a card on it.
  ///
  /// A phone column is ~360dp wide. The desktop presentation spends 36 of them
  /// on an avatar gutter and another 30 on the bubble's own padding + border,
  /// which is a fifth of the line length for chrome that says nothing the
  /// header above it hasn't already said. So on touch the assistant's text
  /// sits directly on the canvas at full width — ChatGPT/Claude anatomy —
  /// while the user's message keeps its bubble. Two speakers, one bubble
  /// between them: whose turn it is stays obvious, and the long-form side
  /// gets every pixel of reading width.
  Widget _phone(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
          top: showHeader ? 14 : 0, bottom: continues ? 10 : 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (showHeader) ...[
            Row(
              children: [
                const BrandMark(size: 24),
                const SizedBox(width: TalonSpace.sm),
                Flexible(
                  child: Text(
                    botName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TalonType.subtitle,
                  ),
                ),
                if (trailing != null) ...[
                  const SizedBox(width: TalonSpace.sm),
                  trailing!,
                ],
              ],
            ),
            const SizedBox(height: TalonSpace.sm),
          ],
          if (aboveBubble != null) ...[
            aboveBubble!,
            const SizedBox(height: 6),
          ],
          if (bubble != null)
            SizedBox(
              key: surfaceKey,
              width: double.infinity,
              child: bubble!,
            ),
          if (belowBubble != null) belowBubble!,
        ],
      ),
    );
  }

  Widget _pointer(BuildContext context) {
    final dark = TalonTheme.isDark;
    return Padding(
      padding:
          EdgeInsets.only(top: showHeader ? 10 : 0, bottom: continues ? 4 : 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (showHeader)
            const Padding(
              padding: EdgeInsets.only(top: 1),
              child: BrandMark(size: 26),
            )
          else
            const SizedBox(width: 26),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Identity header on the canvas, not in the bubble.
                if (showHeader) ...[
                  Padding(
                    padding: const EdgeInsets.only(top: 3),
                    child: Row(
                      children: [
                        Flexible(
                          child: Text(
                            botName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TalonType.subtitle,
                          ),
                        ),
                        if (trailing != null) ...[
                          const SizedBox(width: TalonSpace.sm),
                          trailing!,
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(height: 7),
                ],
                // Tool calls / reasoning live on the canvas above the reply.
                if (aboveBubble != null) ...[
                  aboveBubble!,
                  const SizedBox(height: 4),
                ],
                if (bubble != null)
                  Container(
                    key: surfaceKey,
                    padding: const EdgeInsets.fromLTRB(14, 11, 14, 11),
                    decoration: BoxDecoration(
                      color: dark
                          ? TalonColors.surface.withValues(alpha: 0.54)
                          : TalonColors.surface.withValues(alpha: 0.96),
                      // Runs read as one stack: every bubble after the first
                      // keeps a tight top-left, every bubble before the last
                      // a tight bottom-left, so they join along the avatar
                      // side like a chat app's grouped messages.
                      borderRadius: BorderRadius.only(
                        topLeft: const Radius.circular(7),
                        topRight: const Radius.circular(20),
                        bottomRight: const Radius.circular(20),
                        bottomLeft: Radius.circular(continues ? 7 : 20),
                      ),
                      border: Border.all(color: TalonColors.glassStroke),
                      boxShadow: dark
                          ? null
                          : [
                              BoxShadow(
                                color: const Color(0xFF171A3D)
                                    .withValues(alpha: 0.055),
                                blurRadius: 18,
                                offset: const Offset(0, 5),
                              ),
                            ],
                    ),
                    child: bubble!,
                  ),
                // Stats / actions footer on the canvas below the bubble.
                if (belowBubble != null) belowBubble!,
              ],
            ),
          ),
        ],
      ),
    );
  }
}
