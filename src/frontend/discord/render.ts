/**
 * Message rendering for Discord commands, callbacks, and the settings panel:
 * metrics, doctor, mesh, usage and settings text, sized to Discord's limits.
 *
 * The reports themselves live in `frontend/presentation/reports.ts` — this
 * file is Discord's dialect of them (`DISCORD_REPORTS`) plus the wrappers
 * that keep each command to a single import.
 *
 * Discord-specific quirks vs the Telegram renderers:
 *  - settings panel uses Components (Buttons + Select Menus), not inline keyboard.
 *  - custom_id strings are limited to 100 chars total — keep payload compact.
 *  - chat IDs are Discord snowflakes (strings), not numbers.
 *  - markdown needs no escaping, so `escape` is the identity function.
 */

import {
  DISCORD_MAX_TEXT,
  DISCORD_SAFE_RESERVE,
  splitMessage,
} from "./formatting.js";
import type { DoctorReport } from "../../core/doctor/index.js";
import type { MeshPingResult } from "../../core/mesh/devices/service.js";
import type { BackendUsageEntry } from "../presentation/plan-usage-report.js";
import {
  renderDoctorReport,
  renderMeshReport as renderMeshReportWith,
  renderMetricsMessages as renderMetricsMessagesWith,
  renderSettingsText as renderSettingsTextWith,
  renderUsageMessage as renderUsageMessageWith,
  type MetricsSnapshot,
  type ReportFormatter,
} from "../presentation/reports.js";

export { EFFORT_DESCRIPTIONS } from "../presentation/reasoning-levels.js";

export {
  parseInterval,
  formatDuration,
  formatTokenCount,
  formatBytes,
  formatUsd,
  formatModelLabel,
} from "../presentation/format.js";

/** Per-message length budget for report output. */
const DEFAULT_METRICS_MESSAGE_MAX = DISCORD_MAX_TEXT - DISCORD_SAFE_RESERVE;

/** Discord markdown: bold/italic/code markers, no escaping, 2000-char messages. */
export const DISCORD_REPORTS: ReportFormatter = {
  bold: (s) => `**${s}**`,
  italic: (s) => `_${s}_`,
  emphasis: (s) => `*${s}*`,
  code: (s) => `\`${s}\``,
  escape: (s) => s,
  lineLimit: DEFAULT_METRICS_MESSAGE_MAX,
  metricLabelMax: 60,
  pulseLabel: "🔔 Pulse:",
};

/**
 * Render the metrics report into one or more Discord messages, each ≤ maxLen
 * (default ~1900 chars to leave headroom under the 2000-char limit).
 */
export function renderMetricsMessages(
  metrics: MetricsSnapshot,
  maxLen = DEFAULT_METRICS_MESSAGE_MAX,
  title = "📊 Metrics",
): string[] {
  return renderMetricsMessagesWith(metrics, DISCORD_REPORTS, maxLen, title);
}

/**
 * Render a DoctorReport as Discord markdown, split to fit the message cap.
 * Same data as `talon doctor` and Telegram's /doctor.
 */
export function renderDoctorMessages(
  report: DoctorReport,
  maxLen = DEFAULT_METRICS_MESSAGE_MAX,
): string[] {
  return splitMessage(renderDoctorReport(report, DISCORD_REPORTS), maxLen);
}

/**
 * Render the /mesh fleet report as Discord markdown. Devices group under a
 * state heading; empty groups are omitted.
 */
export function renderMeshReport(
  results: MeshPingResult[],
  now = Date.now(),
): string {
  return renderMeshReportWith(results, DISCORD_REPORTS, now);
}

/** Render the `/usage` report — one block per exposed backend. */
export function renderUsageMessage(entries: BackendUsageEntry[]): string {
  return renderUsageMessageWith(entries, DISCORD_REPORTS);
}

/** Settings panel: build the markdown body. */
export function renderSettingsText(
  model: string,
  effort: string,
  proactive: boolean,
  pulseIntervalMs?: number,
  modelDetails?: Array<string>,
): string {
  return renderSettingsTextWith(
    DISCORD_REPORTS,
    model,
    effort,
    proactive,
    pulseIntervalMs,
    modelDetails,
  );
}
