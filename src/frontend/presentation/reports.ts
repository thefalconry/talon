/**
 * The five chat reports — metrics, doctor, mesh, usage, settings — in one
 * place, parameterised by the platform's markup dialect.
 *
 * Discord and Telegram carried line-for-line copies of these renderers,
 * differing only in how they spell bold/italic/code, whether text needs
 * HTML escaping, and how much fits in one message. Two copies of a
 * report is two places to fix a bug and two places to drift, which is
 * exactly what happened: the `/metrics` leaderboard cap and the metric
 * label budget landed on Telegram and never reached Discord.
 *
 * The seam is `ReportFormatter`. Everything a platform does differently
 * is one of its fields; everything else is written once here. Discord's
 * `escape` is the identity function, so applying it at every point
 * Telegram escapes leaves Discord's bytes untouched — and Telegram keeps
 * escaping exactly where it always did, which is what stops a model id
 * or a device name containing `<` from 400-ing the whole send.
 *
 * Where the two platforms differ in *content* rather than markup, both
 * behaviours survive: `/metrics` really is two reports (Discord splits
 * across messages, Telegram shrinks into one panel), and they share the
 * section model rather than the output shape.
 */

import type { DoctorReport } from "../../core/doctor/index.js";
import type { MeshPingResult } from "../../core/mesh/devices/service.js";
import type { BackendUsageEntry } from "./plan-usage-report.js";
import {
  DEFAULT_PULSE_INTERVAL_MS,
  formatDuration,
  formatBytes,
  formatModelLabel,
} from "./format.js";

/**
 * One platform's report dialect.
 *
 * Every field exists because the two implementations differed on it. Add
 * a field only when a third frontend genuinely differs — a report that
 * needs a new *shape* is a new function here, not a new flag.
 */
export interface ReportFormatter {
  /** Bold run: `**s**` on Discord, `<b>s</b>` on Telegram. */
  bold(s: string): string;
  /** Italic run: `_s_` on Discord, `<i>s</i>` on Telegram. */
  italic(s: string): string;
  /**
   * The *other* italic spelling: `*s*` on Discord, `<i>s</i>` on
   * Telegram. Discord markdown has two markers for one effect and
   * `/usage` has always used this one for the staleness label; keeping
   * both spellings is what makes that report byte-identical.
   */
  emphasis(s: string): string;
  /** Inline code run: `` `s` `` on Discord, `<code>s</code>` on Telegram. */
  code(s: string): string;
  /**
   * Escape text that is not markup. Telegram parses with `parse_mode:
   * HTML`, so every interpolated value — model ids, device names, metric
   * keys, backend notes — must go through this or the send fails with
   * `can't parse entities`. Discord needs none, and passes the identity
   * function.
   */
  escape(s: string): string;
  /** Characters this platform accepts in one report message. */
  lineLimit: number;
  /** Longest metric key rendered before it is elided (60 vs 80). */
  metricLabelMax: number;
  /** Settings-panel pulse row label — Discord's carries a 🔔, Telegram's doesn't. */
  pulseLabel: string;
}

export type MetricsSnapshot = {
  counters: Record<string, number>;
  histograms: Record<
    string,
    { count: number; avg: number; min: number; max: number }
  >;
};

/**
 * One titled block of a metrics report. `hidden` counts rows dropped to
 * make the report fit; it renders as a trailing "…and N more".
 */
type Section = { title: string; rows: string[]; hidden: number };

function truncateMetricLabel(label: string, max: number): string {
  return label.length <= max ? label : `${label.slice(0, max - 3)}...`;
}

/**
 * Group a snapshot into the report's sections.
 *
 * `toolCallsTopN` pre-caps the `tool_calls` leaderboard: a long-lived
 * bot accumulates a lifetime entry per distinct tool name (easily 100+
 * once plugin and MCP tools are counted) and past the top rows the tail
 * is one-call tools nobody reads. Discord passes `Infinity` — it splits
 * across messages instead and has never capped.
 */
function buildMetricsSections(
  metrics: MetricsSnapshot,
  fmt: ReportFormatter,
  toolCallsTopN: number,
): Section[] {
  const sections: Section[] = [];

  // Histograms come in two flavours: durations (keys ending in `_ms`,
  // rendered as human times) and plain counts like `tool_calls_per_turn`
  // (rendered as bare numbers — "min=1ms" for a count is nonsense).
  const histKeys = Object.keys(metrics.histograms).sort();
  const durationKeys = histKeys.filter((key) => key.endsWith("_ms"));
  const countKeys = histKeys.filter((key) => !key.endsWith("_ms"));
  const histLine = (key: string, format: (v: number) => string): string => {
    const h = metrics.histograms[key]!;
    return (
      `  ${fmt.code(fmt.escape(truncateMetricLabel(key, fmt.metricLabelMax)))}` +
      `  n=${h.count} avg=${format(h.avg)}  min=${format(h.min)} ` +
      `max=${format(h.max)}`
    );
  };
  if (durationKeys.length > 0) {
    sections.push({
      title: fmt.bold("Latency"),
      rows: durationKeys.map((key) => histLine(key, formatDuration)),
      hidden: 0,
    });
  }
  if (countKeys.length > 0) {
    sections.push({
      title: fmt.bold("Distributions"),
      rows: countKeys.map((key) => histLine(key, String)),
      hidden: 0,
    });
  }

  for (const [prefix, keys] of groupCounters(metrics)) {
    const shown = keys.slice(0, toolCallsTopN);
    sections.push({
      title: fmt.bold(fmt.escape(prefix)),
      rows: shown.map((key) => {
        const label = key.includes(".")
          ? key.split(".").slice(1).join(".")
          : key;
        const name = truncateMetricLabel(label, fmt.metricLabelMax);
        return (
          `  ${fmt.code(fmt.escape(name))}  ` +
          `${metrics.counters[key]!.toLocaleString()}`
        );
      }),
      hidden: keys.length - shown.length,
    });
  }

  return sections;
}

/** Counter keys bucketed by their dotted namespace, groups in name order. */
function groupCounters(metrics: MetricsSnapshot): Array<[string, string[]]> {
  const groups = new Map<string, string[]>();
  for (const key of Object.keys(metrics.counters).sort()) {
    const prefix = key.includes(".") ? key.split(".")[0]! : "general";
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push(key);
  }
  return [...groups.keys()].sort().map((prefix): [string, string[]] => {
    // tool_calls reads best as a leaderboard — busiest tools first.
    // Other groups keep alphabetical order (stable lookup by name).
    const keys = groups.get(prefix)!;
    return [
      prefix,
      prefix === "tool_calls"
        ? [...keys].sort(
            (a, b) =>
              metrics.counters[b]! - metrics.counters[a]! || a.localeCompare(b),
          )
        : keys,
    ];
  });
}

/** A section as lines: title, rows, and the elision note when rows were dropped. */
function sectionLines(section: Section, fmt: ReportFormatter): string[] {
  return [
    section.title,
    ...section.rows,
    ...(section.hidden > 0
      ? [`  ${fmt.italic(`…and ${section.hidden} more`)}`]
      : []),
  ];
}

/**
 * Render the metrics report across as many messages as it takes, each
 * ≤ `maxLen`, continuation messages re-stating the title. Discord's
 * shape: nothing is dropped, the report just gets longer.
 */
export function renderMetricsMessages(
  metrics: MetricsSnapshot,
  fmt: ReportFormatter,
  maxLen = fmt.lineLimit,
  title = "📊 Metrics",
): string[] {
  const firstHeader = fmt.bold(title);
  const continuationHeader = fmt.bold(`${title} (cont.)`);
  const sections = buildMetricsSections(metrics, fmt, Infinity);
  if (sections.length === 0) {
    return [`${firstHeader}\n\n${fmt.italic("No metrics recorded yet.")}`];
  }

  const chunks: string[] = [];
  let header = firstHeader;
  let current = header;
  const flush = () => {
    chunks.push(current);
    header = continuationHeader;
    current = header;
  };
  const appendLine = (line: string) => {
    if (!line && current === header) return;
    const candidate = `${current}\n${line}`;
    if (candidate.length <= maxLen) {
      current = candidate;
      return;
    }
    if (current !== header) {
      flush();
      if (!line) return;
    }
    const available = maxLen - header.length - 1;
    if (available < 0) return;
    const safeLine =
      line.length <= available
        ? line
        : available >= 4
          ? `${line.slice(0, available - 3)}...`
          : line.slice(0, available);
    current = `${current}\n${safeLine}`;
  };

  for (const section of sections) {
    appendLine("");
    for (const line of sectionLines(section, fmt)) appendLine(line);
  }
  if (current !== header || chunks.length === 0) chunks.push(current);
  return chunks;
}

/**
 * Render the metrics report as a SINGLE message, shrinking to fit.
 *
 * Telegram's shape: rather than split the report across messages — which
 * is what the tappable panel replaced — rows are dropped from the longest
 * section first (each drop bumping that section's "…and N more") until
 * the whole thing fits. Sections always keep at least their first row, so
 * every group stays visible.
 */
export function renderMetricsPanel(
  metrics: MetricsSnapshot,
  fmt: ReportFormatter,
  title: string,
  maxLen = fmt.lineLimit,
  toolCallsTopN = Infinity,
): string {
  const header = fmt.bold(fmt.escape(title));
  const sections = buildMetricsSections(metrics, fmt, toolCallsTopN);
  if (sections.length === 0) {
    return `${header}\n\n${fmt.italic("No metrics recorded yet.")}`;
  }

  const render = () =>
    [header, ...sections.map((s) => sectionLines(s, fmt).join("\n"))].join(
      "\n\n",
    );

  let out = render();
  while (out.length > maxLen) {
    let target: Section | undefined;
    for (const section of sections) {
      if (section.rows.length <= 1) continue;
      if (!target || section.rows.length > target.rows.length) target = section;
    }
    if (!target) break;
    target.rows.pop();
    target.hidden += 1;
    out = render();
  }

  if (out.length <= maxLen) return out;
  // Nothing left to shed (a pathologically small maxLen). Cut on a line
  // boundary so we never slice through an HTML tag and fail the parse.
  const cut = out.lastIndexOf("\n", maxLen - 1);
  return cut > 0 ? out.slice(0, cut) : out.slice(0, maxLen);
}

const DOCTOR_ICONS: Record<string, string> = {
  ok: "✅",
  warn: "⚠️",
  fail: "❌",
  info: "▫️",
};

/**
 * Render a DoctorReport as one message body.
 *
 * Same data as `talon doctor` (src/core/doctor/) plus in-process runtime
 * info — when this renders, the bot is by definition running, so the
 * CLI's "is the bot up" probe becomes an uptime line instead. Callers
 * that have a message cap split the result themselves.
 */
export function renderDoctorReport(
  report: DoctorReport,
  fmt: ReportFormatter,
): string {
  const lines = [fmt.bold("🩺 Talon Doctor"), "", fmt.bold("Environment")];

  const render = (check: DoctorReport["checks"][number]): string => {
    const detail = check.detail ? ` (${fmt.escape(check.detail)})` : "";
    return `${DOCTOR_ICONS[check.status]} ${fmt.escape(check.label)}${detail}`;
  };

  for (const check of report.checks.filter((c) => !c.inactive)) {
    lines.push(render(check));
  }

  // Configured-but-idle backends get their own block: they describe what a
  // switch would run into, not the state of the running deployment.
  const idle = report.checks.filter((c) => c.inactive);
  if (idle.length > 0) {
    lines.push("", fmt.bold("Other backends"), ...idle.map(render));
  }

  lines.push("", fmt.bold("Native modules"));
  for (const mod of report.native) {
    const size =
      mod.sizeBytes !== undefined ? ` · ${formatBytes(mod.sizeBytes)}` : "";
    const note = mod.note ? ` (${fmt.escape(mod.note)})` : "";
    lines.push(
      `${mod.ok ? DOCTOR_ICONS.ok : DOCTOR_ICONS.fail} ` +
        `${fmt.code(fmt.escape(mod.name))} — ${fmt.escape(mod.language)} → ` +
        `${fmt.escape(mod.target)}${size}${note}`,
    );
  }

  lines.push(
    "",
    fmt.bold("Process"),
    `Uptime ${formatDuration(process.uptime() * 1000)} · PID ${process.pid} · ` +
      `Node ${fmt.escape(process.versions.node)}`,
    "",
    report.issues === 0
      ? `${DOCTOR_ICONS.ok} All checks passed.`
      : `${DOCTOR_ICONS.warn} ${report.issues} issue(s) found.`,
  );

  return lines.join("\n");
}

function meshDeviceLine(
  r: MeshPingResult,
  fmt: ReportFormatter,
  now: number,
): string {
  const d = r.device;
  const bits: string[] = [fmt.escape(d.platform)];
  if (r.reachable && typeof r.latencyMs === "number") {
    bits.push(`${r.latencyMs} ms`);
  } else if (d.online && r.error) {
    bits.push(fmt.escape(r.error));
  } else if (!d.online) {
    bits.push(`last seen ${formatDuration(now - d.lastSeen)} ago`);
  }
  if (typeof d.battery === "number") {
    bits.push(`${d.battery}%${d.charging ? " charging" : ""}`);
  }
  return `  ${fmt.bold(fmt.escape(d.name))} — ${bits.join(" · ")}`;
}

/**
 * Render the `/mesh` fleet report.
 *
 * Devices group under a state heading — Responding, Unreachable, Offline
 * — rather than carrying a coloured status glyph per row: the grouping
 * already says what the glyph said, and the report stays readable when
 * the fleet grows. Empty groups are omitted entirely. `footer` is the
 * platform's own trailer (Telegram appends the bridge block; Discord
 * appends nothing).
 */
export function renderMeshReport(
  results: MeshPingResult[],
  fmt: ReportFormatter,
  now = Date.now(),
  footer: string[] = [],
): string {
  const heading = fmt.bold("Mesh");
  if (results.length === 0) {
    return [
      heading,
      "",
      fmt.italic("No devices have registered yet."),
      ...footer,
    ].join("\n");
  }

  const responding = results
    .filter((r) => r.reachable)
    .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
  const unreachable = results
    .filter((r) => !r.reachable && r.device.online)
    .sort((a, b) => a.device.name.localeCompare(b.device.name));
  const offline = results
    .filter((r) => !r.reachable && !r.device.online)
    .sort((a, b) => b.device.lastSeen - a.device.lastSeen);

  const summary = [
    `${results.length} device${results.length === 1 ? "" : "s"}`,
    `${responding.length} responding`,
    ...(unreachable.length > 0 ? [`${unreachable.length} unreachable`] : []),
    ...(offline.length > 0 ? [`${offline.length} offline`] : []),
  ].join(" · ");

  const lines = [heading, summary];
  const section = (title: string, entries: MeshPingResult[]): void => {
    if (entries.length === 0) return;
    lines.push(
      "",
      fmt.bold(title),
      ...entries.map((r) => meshDeviceLine(r, fmt, now)),
    );
  };
  section("Responding", responding);
  section("Unreachable", unreachable);
  section("Offline", offline);
  lines.push(...footer);

  return lines.join("\n");
}

/** Render the `/usage` report — one block per exposed backend. */
export function renderUsageMessage(
  entries: BackendUsageEntry[],
  fmt: ReportFormatter,
): string {
  const lines = [fmt.bold("📊 Plan usage")];
  for (const entry of entries) lines.push("", ...usageBlock(entry, fmt));
  return lines.join("\n");
}

type UsageWindow = NonNullable<BackendUsageEntry["plan"]>["windows"][number];

/**
 * Green with half or more left, amber down to 15%, red below that or when
 * the backend cannot run at all; grey when nothing is measured.
 */
function usageDot(entry: BackendUsageEntry): string {
  const h = entry.headroom;
  if (h.unavailable) return "🔴";
  if (h.source === "none") return "⚪";
  if (h.headroom >= 0.5) return "🟢";
  return h.headroom >= 0.15 ? "🟡" : "🔴";
}

/** The headline: dot, name, plan tier, and how much is left. */
function usageHeadline(entry: BackendUsageEntry, fmt: ReportFormatter): string {
  const h = entry.headroom;
  const name = fmt.bold(fmt.escape(entry.label || entry.id));
  const tier = entry.plan?.plan ? ` · ${fmt.escape(entry.plan.plan)}` : "";
  const head = `${usageDot(entry)} ${name}${tier}`;
  if (h.unavailable)
    return `${head} — unavailable: ${fmt.escape(h.unavailable)}`;
  if (h.source === "none") {
    return `${head} — ${fmt.italic(fmt.escape(entry.note ?? "not measured"))}`;
  }
  const left = fmt.bold(`${Math.round(h.headroom * 100)}% left`);
  // Name the model when its own cap, not the account's, is what limits it.
  const forModel =
    h.model && h.limiting?.scope ? ` for ${fmt.escape(h.model)}` : "";
  const budget = h.source === "ledger" ? " of its local budget" : "";
  const age = entry.plan?.ageLabel
    ? ` ${fmt.emphasis(`(${entry.plan.ageLabel})`)}`
    : "";
  const stale = h.stale ? ` ${fmt.emphasis("(stale)")}` : "";
  return `${head} — ${left}${forModel}${budget}${age}${stale}`;
}

/** "4 Neon, 4 Carbon" under "Gemini": the scope's own name is not repeated. */
function scopeModels(scope: string, models: string[] | undefined): string {
  const lead = scope.split(/[\s/]+/)[0]?.toLowerCase() ?? "";
  const names = (models ?? [])
    .filter((m) => m.toLowerCase() !== scope.toLowerCase())
    .map((m) => {
      const [first, ...rest] = m.split(" ");
      return first?.toLowerCase() === lead && rest.length > 0
        ? rest.join(" ")
        : m;
    });
  return names.join(", ");
}

function usageRow(w: UsageWindow, fmt: ReportFormatter): string {
  const label = `${(w.period ?? w.label).padEnd(3)} `;
  const bar = fmt.code(
    `${fmt.escape(label)}${w.bar} ${String(w.percent).padStart(3)}%`,
  );
  const flag = w.percent >= 90 ? " 🔴" : w.percent >= 75 ? " 🟡" : "";
  const reset = w.resetIn
    ? ` resets in ${w.resetIn}`
    : w.resetLabel
      ? ` resets ${fmt.escape(w.resetLabel)}`
      : "";
  return `${bar}${flag}${reset}`;
}

/** `5h` → 5, `7d` → 168; a window with no period sorts last. */
function periodHours(w: UsageWindow): number {
  const m = /^(\d+)([hd])$/.exec(w.period ?? "");
  if (!m) return Infinity;
  return Number(m[1]) * (m[2] === "d" ? 24 : 1);
}

/** The windows, under a heading per model or group they limit. */
function usageWindows(
  all: readonly UsageWindow[],
  fmt: ReportFormatter,
): string[] {
  // Shortest window first in every group, whatever order the plan used.
  const windows = [...all].sort((a, b) => periodHours(a) - periodHours(b));
  const account = windows.filter((w) => !w.scope);
  const scoped = windows.filter((w) => w.scope);
  const lines: string[] = [];
  if (account.length > 0 && scoped.length > 0)
    lines.push(fmt.italic("All models"));
  lines.push(...account.map((w) => usageRow(w, fmt)));

  const scopes = [...new Set(scoped.map((w) => w.scope as string))];
  for (const scope of scopes) {
    const rows = scoped.filter((w) => w.scope === scope);
    const models = scopeModels(scope, rows[0]?.models);
    const title = models
      ? `${fmt.escape(scope)}: ${fmt.escape(models)}`
      : `${fmt.escape(scope)} only`;
    lines.push(fmt.italic(title), ...rows.map((w) => usageRow(w, fmt)));
  }
  return lines;
}

function usageBlock(entry: BackendUsageEntry, fmt: ReportFormatter): string[] {
  const lines = [usageHeadline(entry, fmt)];
  const plan = entry.plan;
  if (!plan) return lines;
  lines.push(...usageWindows(plan.windows, fmt));
  if (plan.resetsAvailable) {
    const n = plan.resetsAvailable;
    const resets = `usage limit reset${n === 1 ? "" : "s"} available`;
    const by = plan.resetsExpireLabel
      ? ` ${fmt.escape(`(use by ${plan.resetsExpireLabel})`)}`
      : "";
    lines.push(`• You have ${fmt.bold(String(n))} ${resets}${by}`);
  }
  return lines;
}

/** Settings panel body — model, effort, and the pulse row. */
export function renderSettingsText(
  fmt: ReportFormatter,
  model: string,
  effort: string,
  proactive: boolean,
  pulseIntervalMs?: number,
  modelDetails?: Array<string>,
): string {
  const intervalStr = formatDuration(
    pulseIntervalMs || DEFAULT_PULSE_INTERVAL_MS,
  );
  return [
    fmt.bold("🦅 Settings"),
    "",
    `${fmt.bold("Model:")} ${fmt.code(fmt.escape(formatModelLabel(model)))}`,
    ...(modelDetails?.length ? modelDetails.map((d) => fmt.escape(d)) : []),
    `${fmt.bold("Effort:")} ${effort}`,
    `${fmt.bold(fmt.pulseLabel)} ${proactive ? "on" : "off"} (every ${intervalStr})`,
  ].join("\n");
}
