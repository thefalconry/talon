import { beforeEach, describe, expect, it } from "vitest";
import { clearModels, registerModels } from "../core/models/catalog.js";
import {
  formatDuration,
  formatModelLabel,
} from "../frontend/presentation/format.js";
import {
  formatCompactModelLabel,
  formatModelOptionLabel,
  getTelegramModelOptions,
  isSelectedModel,
  renderEffortRows,
  renderSettingsKeyboard,
  renderSettingsText,
} from "../frontend/telegram/render/menu.js";
import {
  renderMeshReport,
  renderMetricsKeyboard,
  renderMetricsPanel,
} from "../frontend/telegram/render/reports.js";
import type { MeshPingResult } from "../core/mesh/devices/service.js";

describe("telegram render", () => {
  beforeEach(() => {
    clearModels();
    // Post-merge state: convertSdkModels collapses base/1M/claude-* variants
    // of the same family+version into a single canonical entry. This fixture
    // is what the registry looks like after that merge.
    registerModels([
      {
        id: "default",
        displayName: "Sonnet 4.6",
        description: "Sonnet 4.6 · Best for everyday tasks",
        aliases: [
          "sonnet",
          "sonnet[1m]",
          "claude-sonnet-4-6",
          "claude-sonnet-4-6[1m]",
        ],
        provider: "anthropic",
        fallback: "haiku",
      },
      {
        id: "opus[1m]",
        displayName: "Opus 4.6",
        description: "Opus 4.6 with 1M context · Large context window",
        aliases: ["opus", "claude-opus-4-6", "claude-opus-4-6[1m]"],
        provider: "anthropic",
        fallback: "default",
      },
      {
        id: "haiku",
        displayName: "Haiku 4.5",
        description: "Haiku 4.5 · Fastest for quick answers",
        aliases: ["claude-haiku-4-5"],
        provider: "anthropic",
      },
    ]);
  });

  it("matches legacy aliases and 1M variants to the canonical selected model", () => {
    expect(isSelectedModel("claude-sonnet-4-6", "default")).toBe(true);
    // sonnet[1m] is merged into "default" — same canonical model.
    expect(isSelectedModel("sonnet[1m]", "default")).toBe(true);
    expect(isSelectedModel("claude-sonnet-4-6[1m]", "default")).toBe(true);
    expect(isSelectedModel("claude-sonnet-4-6", "haiku")).toBe(false);
  });

  it("formats labels using backend-registered displayName", () => {
    expect(formatModelLabel("default")).toBe("Sonnet 4.6");
    expect(formatModelLabel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    // 1M variants collapse into the same entry — same clean label.
    expect(formatModelLabel("sonnet[1m]")).toBe("Sonnet 4.6");
    expect(formatModelLabel("opus[1m]")).toBe("Opus 4.6");
    expect(formatModelLabel("claude-opus-4-6")).toBe("Opus 4.6");
    expect(formatModelOptionLabel(getTelegramModelOptions()[0]!)).toBe(
      "Sonnet 4.6",
    );
    expect(formatCompactModelLabel(getTelegramModelOptions()[1]!)).toBe(
      "Opus 4.6",
    );
  });

  it("shows one option per family+version (base/1M variants merged)", () => {
    expect(getTelegramModelOptions().map((model) => model.id)).toEqual([
      "default",
      "opus[1m]",
      "haiku",
    ]);
  });

  it("renders only the reasoning levels registered for the active model", () => {
    const buttons = renderEffortRows(
      "adaptive",
      ["minimal", "high", "xhigh"],
      "effort:",
    );
    const labels = buttons.flat().map((button) => button.text);

    expect(labels).toEqual(["Minimal", "High", "XHigh", "✓ Auto"]);
    expect(labels).not.toContain("Max");
    expect(labels).not.toContain("Off");
  });

  it("hides effort buttons when the active model registers no levels", () => {
    const buttons = renderSettingsKeyboard("default", "adaptive", true)
      .flat()
      .map((button) => button.callback_data);

    expect(buttons.some((data) => data.startsWith("settings:effort:"))).toBe(
      false,
    );
  });
});

describe("formatDuration", () => {
  it("preserves millisecond precision for subsecond values", () => {
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("keeps second-and-up formatting intact", () => {
    expect(formatDuration(1_500)).toBe("1s");
    expect(formatDuration(65_000)).toBe("1m 5s");
  });
});

describe("renderSettingsText", () => {
  // Telegram parses messages with parse_mode=HTML; any literal `<word>` in a
  // detail line (e.g. backend hints like "use /model <name>") would be
  // mis-read as a tag and reject the entire send. Detail strings come from
  // backends that also feed Discord (Markdown), so they stay plain text and
  // the Telegram frontend escapes per-line.
  it("escapes HTML special chars in modelDetails", () => {
    const out = renderSettingsText("default", "high", true, 60_000, [
      "Hint: use /model <name> to switch.",
      "Provider: A & B",
    ]);
    expect(out).not.toMatch(/<name>/);
    expect(out).toContain("&lt;name&gt;");
    expect(out).toContain("A &amp; B");
  });
});

describe("renderMetricsPanel", () => {
  it("formats latency metrics with millisecond precision", () => {
    const panel = renderMetricsPanel(
      {
        counters: { queries_total: 7 },
        histograms: {
          response_latency_ms: {
            count: 3,
            avg: 900,
            min: 250,
            max: 2_000,
          },
        },
      },
      "all",
    );

    expect(panel).toContain("avg=900ms");
    expect(panel).toContain("min=250ms");
    expect(panel).toContain("max=2s");
  });

  it("titles the panel by grain", () => {
    const snapshot = { counters: { queries_total: 1 }, histograms: {} };
    expect(renderMetricsPanel(snapshot, "today")).toContain(
      "<b>Metrics — today (UTC)</b>",
    );
    expect(renderMetricsPanel(snapshot, "all")).toContain(
      "<b>Metrics — all time</b>",
    );
  });

  it("renders count histograms as plain numbers under Distributions", () => {
    const out = renderMetricsPanel(
      {
        counters: {},
        histograms: {
          response_latency_ms: {
            count: 3,
            avg: 900,
            min: 250,
            max: 2_000,
          },
          tool_calls_per_turn: { count: 21, avg: 9, min: 1, max: 100 },
        },
      },
      "all",
    );

    // Duration histograms stay under Latency with time units…
    expect(out).toContain("<b>Latency</b>");
    expect(out).toContain("avg=900ms");
    // …while per-turn counts get their own section, unit-free.
    expect(out).toContain("<b>Distributions</b>");
    expect(out).toContain("avg=9  min=1 max=100");
    expect(out).not.toContain("min=1ms");
  });

  it("sorts the tool_calls group by count, busiest first", () => {
    const out = renderMetricsPanel(
      {
        counters: {
          "tool_calls.Read": 3,
          "tool_calls.Bash": 162,
          "tool_calls.end_turn": 16,
          "backend.claude.queries": 3,
          "backend.codex.queries": 18,
        },
        histograms: {},
      },
      "all",
    );

    const bash = out.indexOf(">Bash<");
    const endTurn = out.indexOf(">end_turn<");
    const read = out.indexOf(">Read<");
    expect(bash).toBeGreaterThan(-1);
    expect(bash).toBeLessThan(endTurn);
    expect(endTurn).toBeLessThan(read);
    // Other groups stay alphabetical.
    expect(out.indexOf("claude.queries")).toBeLessThan(
      out.indexOf("codex.queries"),
    );
  });

  it("caps the tool_calls leaderboard and reports the remainder", () => {
    const counters = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`tool_calls.tool_${i}`, 40 - i]),
    );

    const out = renderMetricsPanel({ counters, histograms: {} }, "all");

    // Top 12 by count survive; the other 28 collapse into one line.
    expect(out).toContain(">tool_0<");
    expect(out).toContain(">tool_11<");
    expect(out).not.toContain(">tool_12<");
    expect(out).toContain("…and 28 more");
  });

  it("always fits a single message, however long the report", () => {
    const counters = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [
        `backend.b${i}.queries`,
        1_000 + i,
      ]),
    );

    const out = renderMetricsPanel({ counters, histograms: {} }, "all", 400);

    expect(out.length).toBeLessThanOrEqual(400);
    expect(out).toContain("<b>Metrics — all time</b>");
    expect(out).toMatch(/…and \d+ more/);
  });

  it("shows an empty-state message when no metrics exist", () => {
    expect(renderMetricsPanel({ counters: {}, histograms: {} }, "today")).toBe(
      "<b>Metrics — today (UTC)</b>\n\n<i>No metrics recorded yet.</i>",
    );
  });
});

describe("renderMeshReport", () => {
  const NOW = 1_700_000_000_000;
  const device = (
    over: Partial<MeshPingResult["device"]> & { name: string },
  ): MeshPingResult["device"] => ({
    id: over.name,
    platform: "android",
    appVersion: "1.0.0",
    online: true,
    lastSeen: NOW,
    ...over,
  });

  it("groups devices by state instead of tagging each row", () => {
    const out = renderMeshReport(
      [
        {
          device: device({ name: "Pixel", battery: 87, charging: true }),
          reachable: true,
          latencyMs: 42,
        },
        {
          device: device({ name: "Laptop", platform: "linux" }),
          reachable: false,
          error: "connection refused",
        },
        {
          device: device({
            name: "Tablet",
            online: false,
            lastSeen: NOW - 90_000,
          }),
          reachable: false,
        },
      ],
      NOW,
    );

    expect(out).toContain("<b>Mesh</b>");
    expect(out).toContain(
      "3 devices · 1 responding · 1 unreachable · 1 offline",
    );
    expect(out).toContain("<b>Responding</b>");
    expect(out).toContain("<b>Pixel</b> — android · 42 ms · 87% charging");
    expect(out).toContain("<b>Unreachable</b>");
    expect(out).toContain("<b>Laptop</b> — linux · connection refused");
    expect(out).toContain("<b>Offline</b>");
    expect(out).toContain("last seen 1m 30s ago");
  });

  // The report is plain HTML by design — no status dots, battery bolts, or
  // satellite glyphs. Regressing that is the whole point of this test.
  it("carries no emoji", () => {
    const out = renderMeshReport(
      [
        {
          device: device({ name: "Pixel", battery: 12 }),
          reachable: true,
          latencyMs: 9,
        },
        {
          device: device({ name: "Old", online: false, lastSeen: NOW - 1_000 }),
          reachable: false,
        },
      ],
      NOW,
    );
    expect(out).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("omits groups that have no devices", () => {
    const out = renderMeshReport(
      [{ device: device({ name: "Pixel" }), reachable: true, latencyMs: 5 }],
      NOW,
    );
    expect(out).toContain("1 device · 1 responding");
    expect(out).toContain("<b>Responding</b>");
    expect(out).not.toContain("Unreachable");
    expect(out).not.toContain("Offline");
  });

  it("shows an empty state when nothing has registered", () => {
    expect(renderMeshReport([], NOW)).toBe(
      "<b>Mesh</b>\n\n<i>No devices have registered yet.</i>",
    );
  });
});

describe("renderMetricsKeyboard", () => {
  it("marks the active grain and offers the other", () => {
    expect(renderMetricsKeyboard("today")).toEqual([
      [
        { text: "✓ Today", callback_data: "metrics:today" },
        { text: "All time", callback_data: "metrics:all" },
      ],
    ]);
    expect(renderMetricsKeyboard("all")).toEqual([
      [
        { text: "Today", callback_data: "metrics:today" },
        { text: "✓ All time", callback_data: "metrics:all" },
      ],
    ]);
  });
});
