/**
 * The native bridge's report dialect: Markdown, which every client
 * renders, with no escaping (nothing is parsed server-side) and no
 * per-message cap — a bridge message is a JSON string, not a platform
 * bubble, so a report is one reply however long it grows.
 */

import type { ReportFormatter } from "../../presentation/reports.js";

export const NATIVE_REPORTS: ReportFormatter = {
  bold: (s) => `**${s}**`,
  italic: (s) => `_${s}_`,
  emphasis: (s) => `*${s}*`,
  code: (s) => `\`${s}\``,
  escape: (s) => s,
  lineLimit: 100_000,
  metricLabelMax: 80,
  pulseLabel: "🔔 Pulse:",
};

/** Wrap preformatted text (status tables, listings) in a code fence. */
export function fence(text: string): string {
  return `\`\`\`\n${text.replace(/```/g, "ˋˋˋ")}\n\`\`\``;
}
