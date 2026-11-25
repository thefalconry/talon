/**
 * Characterization of the Discord and Telegram report renderers.
 *
 * Every string here reaches a user's chat client. The two platforms render
 * the same five reports — metrics, doctor, mesh, usage, settings — from the
 * same data, one in Discord markdown and one in Telegram HTML, and the
 * renderers were duplicated line for line until they drifted. This file
 * pins the exact bytes of both so the dedupe behind `ReportFormatter` is
 * provably a no-op: it passed before the refactor and passes after.
 *
 * Literals only — no vitest file snapshots. A snapshot that can be
 * regenerated with `-u` is not a guarantee.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import type { DoctorReport } from "../core/doctor/index.js";
import type { MeshPingResult } from "../core/mesh/devices/service.js";
import type { BackendUsageEntry } from "../frontend/presentation/plan-usage-report.js";

import {
  renderMetricsMessages as discordMetrics,
  renderDoctorMessages as discordDoctor,
  renderMeshReport as discordMesh,
  renderUsageMessage as discordUsage,
  renderSettingsText as discordSettings,
} from "../frontend/discord/render.js";
import {
  renderMetricsPanel as telegramMetrics,
  renderDoctorMessage as telegramDoctor,
  renderMeshReport as telegramMesh,
  renderUsageMessage as telegramUsage,
} from "../frontend/telegram/render/reports.js";
import { renderSettingsText as telegramSettings } from "../frontend/telegram/render/menu.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * One snapshot exercising every branch both renderers have: duration
 * histograms, count histograms, a grouped counter namespace, the
 * `tool_calls` leaderboard past Telegram's top-12 cap, an ungrouped
 * counter, a key long enough to hit both label caps (60 on Discord, 80
 * on Telegram), and a key carrying HTML metacharacters.
 */
const METRICS = {
  counters: {
    "backend.claude.queries": 3,
    "backend.codex.queries": 18,
    "tool_calls.Bash": 162,
    "tool_calls.Read": 3,
    "tool_calls.Write": 44,
    "tool_calls.Edit": 41,
    "tool_calls.Grep": 39,
    "tool_calls.Glob": 38,
    "tool_calls.Task": 37,
    "tool_calls.WebFetch": 36,
    "tool_calls.WebSearch": 35,
    "tool_calls.NotebookEdit": 34,
    "tool_calls.TodoWrite": 33,
    "tool_calls.BashOutput": 32,
    "tool_calls.KillShell": 31,
    "tool_calls.ExitPlanMode": 30,
    "tool_calls.<b>&amp;</b>": 7,
    "tool_calls.end_turn": 16,
    "plugin.a-very-long-plugin-namespace.counter_with_a_name_that_runs_past_every_cap": 5,
    "plugin.<b>&x</b>": 9,
    queries_total: 7,
  },
  histograms: {
    response_latency_ms: { count: 3, avg: 900, min: 250, max: 2_000 },
    tool_calls_per_turn: { count: 21, avg: 9, min: 1, max: 100 },
  },
};

const NOW = 1_700_000_000_000;

const DOCTOR: DoctorReport = {
  checks: [
    { status: "ok", label: "Config", detail: "~/.talon/config.json" },
    { status: "warn", label: "Backend <claude>", detail: "A & B not pinned" },
    { status: "fail", label: "Token" },
    { status: "info", label: "Frontend", detail: "telegram" },
    {
      status: "ok",
      label: "Codex",
      detail: "idle <backend>",
      inactive: true,
    },
  ],
  native: [
    {
      name: "blake3",
      language: "Rust",
      target: "wasm32-unknown-unknown",
      sizeBytes: 1_234_567,
      ok: true,
    },
    {
      name: "textops<zig>",
      language: "Zig & C",
      target: "wasm32-freestanding",
      ok: false,
      note: "missing <artifact> & stale",
    },
  ],
  issues: 2,
} as DoctorReport;

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

const MESH: MeshPingResult[] = [
  {
    device: device({ name: "Pixel <7>", battery: 87, charging: true }),
    reachable: true,
    latencyMs: 42,
  },
  {
    device: device({
      name: "Laptop & Co",
      // A platform string is device-reported; the renderer must not trust it.
      platform: "linux <x86>" as MeshPingResult["device"]["platform"],
    }),
    reachable: false,
    error: "connection refused <ECONNREFUSED>",
  },
  {
    device: device({ name: "Tablet", online: false, lastSeen: NOW - 90_000 }),
    reachable: false,
  },
];

/** A headroom reading, as every `/usage` entry now carries one. */
function headroom(
  id: string,
  label: string,
  percent: number,
  source: "plan" | "ledger" | "none" = "plan",
): BackendUsageEntry["headroom"] {
  return {
    id,
    label,
    headroom: 1 - percent / 100,
    source,
    fetchedAt: NOW,
    ...(source === "none" ? {} : { limiting: { label: "5h & up", percent } }),
  };
}

const USAGE: BackendUsageEntry[] = [
  {
    id: "claude",
    label: "Claude <SDK> & co",
    plan: {
      plan: "Max <20x>",
      ageLabel: "12m ago",
      resetsAvailable: 2,
      windows: [
        {
          label: "5h",
          percent: 42,
          bar: "████████░░░░░░░░░░░░",
          resetLabel: "21:00",
        },
        {
          label: "week",
          percent: 7,
          bar: "█░░░░░░░░░░░░░░░░░░░",
          resetLabel: undefined,
        },
        {
          label: "Fable",
          percent: 96,
          bar: "███████████████████░",
          resetLabel: "Nov 30 09:00",
          resetIn: "5d 11h",
          period: "7d",
          scope: "Fable",
          models: ["Fable"],
        },
      ],
    },
    headroom: headroom("claude", "Claude <SDK> & co", 42),
    headroomLabel: "58% — 5h 42% used",
  },
  {
    id: "agy",
    label: "Antigravity",
    plan: {
      plan: undefined,
      ageLabel: undefined,
      resetsAvailable: undefined,
      windows: [
        {
          label: "Gemini · 7d",
          percent: 81,
          bar: "████████████████░░░░",
          resetLabel: undefined,
          resetIn: "2d",
          period: "7d",
          scope: "Gemini",
          models: ["Gemini 4 Neon", "Gemini 4 Argon", "Gemini 3.8 Flash"],
        },
        {
          label: "Gemini · 5h",
          percent: 10,
          bar: "██░░░░░░░░░░░░░░░░░░",
          resetLabel: undefined,
          resetIn: "40m",
          period: "5h",
          scope: "Gemini",
          models: ["Gemini 4 Neon", "Gemini 4 Argon", "Gemini 3.8 Flash"],
        },
        {
          label: "Gemini 4 Argon · 7d",
          percent: 100,
          bar: "████████████████████",
          resetLabel: undefined,
          period: "7d",
          scope: "Gemini 4 <Argon>",
          models: ["Gemini 4 <Argon>"],
        },
      ],
    },
    headroom: {
      ...headroom("agy", "Antigravity", 100),
      model: "gemini-4-argon<high>",
      limiting: {
        label: "Gemini 4 Argon · 7d",
        percent: 100,
        scope: "Gemini 4 <Argon>",
      },
    },
    headroomLabel:
      "0% for gemini-4-argon<high> — Gemini 4 Argon · 7d 100% used",
  },
  {
    id: "codex",
    label: "Codex",
    plan: {
      plan: undefined,
      ageLabel: undefined,
      resetsAvailable: 1,
      resetsExpireLabel: "22 Oct",
      windows: [],
    },
    headroom: headroom("codex", "Codex", 0),
    headroomLabel: "100% — 5h 0% used",
  },
  {
    id: "kilo",
    label: "Kilo",
    plan: null,
    note: "no plan limits <here> & now",
    headroom: headroom("kilo", "Kilo", 0, "none"),
    headroomLabel: "100% — no usage signal",
  },
  {
    id: "bare",
    label: "",
    plan: null,
    headroom: headroom("bare", "", 25, "ledger"),
    headroomLabel: "75% — 5h (local budget) 25% used (local budget)",
  },
];

const SETTINGS_DETAILS = [
  "Hint: use /model <name> to switch.",
  "Provider: A & B",
];

afterEach(() => {
  vi.restoreAllMocks();
});

// ── /metrics ────────────────────────────────────────────────────────────────

describe("metrics report", () => {
  it("renders the Discord messages byte for byte", () => {
    expect(discordMetrics(METRICS)).toEqual([
      [
        "**📊 Metrics**",
        "**Latency**",
        "  `response_latency_ms`  n=3 avg=900ms  min=250ms max=2s",
        "",
        "**Distributions**",
        "  `tool_calls_per_turn`  n=21 avg=9  min=1 max=100",
        "",
        "**backend**",
        "  `claude.queries`  3",
        "  `codex.queries`  18",
        "",
        "**general**",
        "  `queries_total`  7",
        "",
        "**plugin**",
        "  `<b>&x</b>`  9",
        "  `a-very-long-plugin-namespace.counter_with_a_name_that_run...`  5",
        "",
        "**tool_calls**",
        "  `Bash`  162",
        "  `Write`  44",
        "  `Edit`  41",
        "  `Grep`  39",
        "  `Glob`  38",
        "  `Task`  37",
        "  `WebFetch`  36",
        "  `WebSearch`  35",
        "  `NotebookEdit`  34",
        "  `TodoWrite`  33",
        "  `BashOutput`  32",
        "  `KillShell`  31",
        "  `ExitPlanMode`  30",
        "  `end_turn`  16",
        "  `<b>&amp;</b>`  7",
        "  `Read`  3",
      ].join("\n"),
    ]);
  });

  it("splits Discord messages at the requested budget", () => {
    expect(discordMetrics(METRICS, 400)).toEqual([
      [
        "**📊 Metrics**",
        "**Latency**",
        "  `response_latency_ms`  n=3 avg=900ms  min=250ms max=2s",
        "",
        "**Distributions**",
        "  `tool_calls_per_turn`  n=21 avg=9  min=1 max=100",
        "",
        "**backend**",
        "  `claude.queries`  3",
        "  `codex.queries`  18",
        "",
        "**general**",
        "  `queries_total`  7",
        "",
        "**plugin**",
        "  `<b>&x</b>`  9",
        "  `a-very-long-plugin-namespace.counter_with_a_name_that_run...`  5",
        "",
        "**tool_calls**",
        "  `Bash`  162",
        "  `Write`  44",
        "  `Edit`  41",
      ].join("\n"),
      [
        "**📊 Metrics (cont.)**",
        "  `Grep`  39",
        "  `Glob`  38",
        "  `Task`  37",
        "  `WebFetch`  36",
        "  `WebSearch`  35",
        "  `NotebookEdit`  34",
        "  `TodoWrite`  33",
        "  `BashOutput`  32",
        "  `KillShell`  31",
        "  `ExitPlanMode`  30",
        "  `end_turn`  16",
        "  `<b>&amp;</b>`  7",
        "  `Read`  3",
      ].join("\n"),
    ]);
  });

  it("renders the Discord empty state", () => {
    expect(discordMetrics({ counters: {}, histograms: {} })).toEqual([
      ["**📊 Metrics**", "", "_No metrics recorded yet._"].join("\n"),
    ]);
  });

  it("renders the Telegram panel byte for byte", () => {
    expect(telegramMetrics(METRICS, "all")).toEqual(
      [
        "<b>Metrics — all time</b>",
        "",
        "<b>Latency</b>",
        "  <code>response_latency_ms</code>  n=3 avg=900ms  min=250ms max=2s",
        "",
        "<b>Distributions</b>",
        "  <code>tool_calls_per_turn</code>  n=21 avg=9  min=1 max=100",
        "",
        "<b>backend</b>",
        "  <code>claude.queries</code>  3",
        "  <code>codex.queries</code>  18",
        "",
        "<b>general</b>",
        "  <code>queries_total</code>  7",
        "",
        "<b>plugin</b>",
        "  <code>&lt;b&gt;&amp;x&lt;/b&gt;</code>  9",
        "  <code>a-very-long-plugin-namespace.counter_with_a_name_that_runs_past_every_cap</code>  5",
        "",
        "<b>tool_calls</b>",
        "  <code>Bash</code>  162",
        "  <code>Write</code>  44",
        "  <code>Edit</code>  41",
        "  <code>Grep</code>  39",
        "  <code>Glob</code>  38",
        "  <code>Task</code>  37",
        "  <code>WebFetch</code>  36",
        "  <code>WebSearch</code>  35",
        "  <code>NotebookEdit</code>  34",
        "  <code>TodoWrite</code>  33",
        "  <code>BashOutput</code>  32",
        "  <code>KillShell</code>  31",
        "  <i>…and 4 more</i>",
      ].join("\n"),
    );
  });

  it("shrinks the Telegram panel to the requested budget", () => {
    expect(telegramMetrics(METRICS, "today", 700)).toEqual(
      [
        "<b>Metrics — today (UTC)</b>",
        "",
        "<b>Latency</b>",
        "  <code>response_latency_ms</code>  n=3 avg=900ms  min=250ms max=2s",
        "",
        "<b>Distributions</b>",
        "  <code>tool_calls_per_turn</code>  n=21 avg=9  min=1 max=100",
        "",
        "<b>backend</b>",
        "  <code>claude.queries</code>  3",
        "  <code>codex.queries</code>  18",
        "",
        "<b>general</b>",
        "  <code>queries_total</code>  7",
        "",
        "<b>plugin</b>",
        "  <code>&lt;b&gt;&amp;x&lt;/b&gt;</code>  9",
        "  <code>a-very-long-plugin-namespace.counter_with_a_name_that_runs_past_every_cap</code>  5",
        "",
        "<b>tool_calls</b>",
        "  <code>Bash</code>  162",
        "  <code>Write</code>  44",
        "  <code>Edit</code>  41",
        "  <code>Grep</code>  39",
        "  <code>Glob</code>  38",
        "  <code>Task</code>  37",
        "  <code>WebFetch</code>  36",
        "  <i>…and 9 more</i>",
      ].join("\n"),
    );
  });

  it("renders the Telegram empty state", () => {
    expect(telegramMetrics({ counters: {}, histograms: {} }, "today")).toEqual(
      [
        "<b>Metrics — today (UTC)</b>",
        "",
        "<i>No metrics recorded yet.</i>",
      ].join("\n"),
    );
  });
});

// ── /doctor ─────────────────────────────────────────────────────────────────

describe("doctor report", () => {
  it("renders the Discord messages byte for byte", () => {
    vi.spyOn(process, "uptime").mockReturnValue(3_725.5);
    expect(discordDoctor(DOCTOR)).toEqual([
      [
        "**🩺 Talon Doctor**",
        "",
        "**Environment**",
        "✅ Config (~/.talon/config.json)",
        "⚠️ Backend <claude> (A & B not pinned)",
        "❌ Token",
        "▫️ Frontend (telegram)",
        "",
        "**Other backends**",
        "✅ Codex (idle <backend>)",
        "",
        "**Native modules**",
        "✅ `blake3` — Rust → wasm32-unknown-unknown · 1.2 MB",
        "❌ `textops<zig>` — Zig & C → wasm32-freestanding (missing <artifact> & stale)",
        "",
        "**Process**",
        `Uptime 1h 2m · PID ${process.pid} · Node ${process.versions.node}`,
        "",
        "⚠️ 2 issue(s) found.",
      ].join("\n"),
    ]);
  });

  it("splits the Discord messages at the requested budget", () => {
    vi.spyOn(process, "uptime").mockReturnValue(3_725.5);
    expect(discordDoctor(DOCTOR, 400)).toEqual([
      [
        "**🩺 Talon Doctor**",
        "",
        "**Environment**",
        "✅ Config (~/.talon/config.json)",
        "⚠️ Backend <claude> (A & B not pinned)",
        "❌ Token",
        "▫️ Frontend (telegram)",
        "",
        "**Other backends**",
        "✅ Codex (idle <backend>)",
        "",
        "**Native modules**",
        "✅ `blake3` — Rust → wasm32-unknown-unknown · 1.2 MB",
        "❌ `textops<zig>` — Zig & C → wasm32-freestanding (missing <artifact> & stale)",
        "",
        "**Process**",
        `Uptime 1h 2m · PID ${process.pid} · Node ${process.versions.node}`,
      ].join("\n"),
      "⚠️ 2 issue(s) found.",
    ]);
  });

  it("renders the Telegram message byte for byte", () => {
    vi.spyOn(process, "uptime").mockReturnValue(3_725.5);
    expect(telegramDoctor(DOCTOR)).toEqual(
      [
        "<b>🩺 Talon Doctor</b>",
        "",
        "<b>Environment</b>",
        "✅ Config (~/.talon/config.json)",
        "⚠️ Backend &lt;claude&gt; (A &amp; B not pinned)",
        "❌ Token",
        "▫️ Frontend (telegram)",
        "",
        "<b>Other backends</b>",
        "✅ Codex (idle &lt;backend&gt;)",
        "",
        "<b>Native modules</b>",
        "✅ <code>blake3</code> — Rust → wasm32-unknown-unknown · 1.2 MB",
        "❌ <code>textops&lt;zig&gt;</code> — Zig &amp; C → wasm32-freestanding (missing &lt;artifact&gt; &amp; stale)",
        "",
        "<b>Process</b>",
        `Uptime 1h 2m · PID ${process.pid} · Node ${process.versions.node}`,
        "",
        "⚠️ 2 issue(s) found.",
      ].join("\n"),
    );
  });
});

// ── /mesh ───────────────────────────────────────────────────────────────────

describe("mesh report", () => {
  it("renders the Discord report byte for byte", () => {
    expect(discordMesh(MESH, NOW)).toEqual(
      [
        "**Mesh**",
        "3 devices · 1 responding · 1 unreachable · 1 offline",
        "",
        "**Responding**",
        "  **Pixel <7>** — android · 42 ms · 87% charging",
        "",
        "**Unreachable**",
        "  **Laptop & Co** — linux <x86> · connection refused <ECONNREFUSED>",
        "",
        "**Offline**",
        "  **Tablet** — android · last seen 1m 30s ago",
      ].join("\n"),
    );
  });

  it("renders the Discord empty state", () => {
    expect(discordMesh([], NOW)).toEqual(
      ["**Mesh**", "", "_No devices have registered yet._"].join("\n"),
    );
  });

  it("renders the Telegram report byte for byte", () => {
    expect(telegramMesh(MESH, NOW)).toEqual(
      [
        "<b>Mesh</b>",
        "3 devices · 1 responding · 1 unreachable · 1 offline",
        "",
        "<b>Responding</b>",
        "  <b>Pixel &lt;7&gt;</b> — android · 42 ms · 87% charging",
        "",
        "<b>Unreachable</b>",
        "  <b>Laptop &amp; Co</b> — linux &lt;x86&gt; · connection refused &lt;ECONNREFUSED&gt;",
        "",
        "<b>Offline</b>",
        "  <b>Tablet</b> — android · last seen 1m 30s ago",
      ].join("\n"),
    );
  });

  it("renders the Telegram report with the bridge footer", () => {
    expect(
      telegramMesh(MESH, NOW, {
        ok: true,
        url: "https://host:8443/<bridge>",
        authRequired: true,
        token: "tok&en",
        fingerprint: "AA:BB",
      }),
    ).toEqual(
      [
        "<b>Mesh</b>",
        "3 devices · 1 responding · 1 unreachable · 1 offline",
        "",
        "<b>Responding</b>",
        "  <b>Pixel &lt;7&gt;</b> — android · 42 ms · 87% charging",
        "",
        "<b>Unreachable</b>",
        "  <b>Laptop &amp; Co</b> — linux &lt;x86&gt; · connection refused &lt;ECONNREFUSED&gt;",
        "",
        "<b>Offline</b>",
        "  <b>Tablet</b> — android · last seen 1m 30s ago",
        "",
        "<b>Bridge</b> <code>https://host:8443/&lt;bridge&gt;</code> · token required",
        "Token <code>tok&amp;en</code>",
        "Certificate <code>AA:BB</code>",
        "Run <code>/mesh link</code> for a one-tap pairing link.",
      ].join("\n"),
    );
  });

  it("renders the Telegram empty state with an unreachable bridge", () => {
    expect(telegramMesh([], NOW, { ok: false, text: "no <route>" })).toEqual(
      [
        "<b>Mesh</b>",
        "",
        "<i>No devices have registered yet.</i>",
        "",
        "<b>Bridge</b> — no &lt;route&gt;",
      ].join("\n"),
    );
  });
});

// ── /usage ──────────────────────────────────────────────────────────────────

describe("usage report", () => {
  it("renders the Discord report byte for byte", () => {
    expect(discordUsage(USAGE)).toEqual(
      [
        "**📊 Plan usage**",
        "",
        "🟢 **Claude <SDK> & co** · Max <20x> — **58% left** *(12m ago)*",
        "_All models_",
        "`5h  ████████░░░░░░░░░░░░  42%` resets 21:00",
        "`week █░░░░░░░░░░░░░░░░░░░   7%`",
        "_Fable only_",
        "`7d  ███████████████████░  96%` 🔴 resets in 5d 11h",
        "• You have **2** usage limit resets available",
        "",
        "🔴 **Antigravity** — **0% left** for gemini-4-argon<high>",
        "_Gemini: 4 Neon, 4 Argon, 3.8 Flash_",
        "`5h  ██░░░░░░░░░░░░░░░░░░  10%` resets in 40m",
        "`7d  ████████████████░░░░  81%` 🟡 resets in 2d",
        "_Gemini 4 <Argon> only_",
        "`7d  ████████████████████ 100%` 🔴",
        "",
        "🟢 **Codex** — **100% left**",
        "• You have **1** usage limit reset available (use by 22 Oct)",
        "",
        "⚪ **Kilo** — _no plan limits <here> & now_",
        "",
        "🟢 **bare** — **75% left** of its local budget",
      ].join("\n"),
    );
  });

  it("renders the Telegram report byte for byte", () => {
    expect(telegramUsage(USAGE)).toEqual(
      [
        "<b>📊 Plan usage</b>",
        "",
        "🟢 <b>Claude &lt;SDK&gt; &amp; co</b> · Max &lt;20x&gt; — <b>58% left</b> <i>(12m ago)</i>",
        "<i>All models</i>",
        "<code>5h  ████████░░░░░░░░░░░░  42%</code> resets 21:00",
        "<code>week █░░░░░░░░░░░░░░░░░░░   7%</code>",
        "<i>Fable only</i>",
        "<code>7d  ███████████████████░  96%</code> 🔴 resets in 5d 11h",
        "• You have <b>2</b> usage limit resets available",
        "",
        "🔴 <b>Antigravity</b> — <b>0% left</b> for gemini-4-argon&lt;high&gt;",
        "<i>Gemini: 4 Neon, 4 Argon, 3.8 Flash</i>",
        "<code>5h  ██░░░░░░░░░░░░░░░░░░  10%</code> resets in 40m",
        "<code>7d  ████████████████░░░░  81%</code> 🟡 resets in 2d",
        "<i>Gemini 4 &lt;Argon&gt; only</i>",
        "<code>7d  ████████████████████ 100%</code> 🔴",
        "",
        "🟢 <b>Codex</b> — <b>100% left</b>",
        "• You have <b>1</b> usage limit reset available (use by 22 Oct)",
        "",
        "⚪ <b>Kilo</b> — <i>no plan limits &lt;here&gt; &amp; now</i>",
        "",
        "🟢 <b>bare</b> — <b>75% left</b> of its local budget",
      ].join("\n"),
    );
  });
});

// ── /settings ───────────────────────────────────────────────────────────────

describe("settings text", () => {
  it("renders the Discord panel byte for byte", () => {
    expect(
      discordSettings("gpt-9", "high", true, 60_000, SETTINGS_DETAILS),
    ).toEqual(
      [
        "**🦅 Settings**",
        "",
        "**Model:** `gpt-9`",
        "Hint: use /model <name> to switch.",
        "Provider: A & B",
        "**Effort:** high",
        "**🔔 Pulse:** on (every 1m 0s)",
      ].join("\n"),
    );
  });

  it("renders the Discord panel with pulse off and no details", () => {
    expect(discordSettings("gpt-9", "adaptive", false)).toEqual(
      [
        "**🦅 Settings**",
        "",
        "**Model:** `gpt-9`",
        "**Effort:** adaptive",
        "**🔔 Pulse:** off (every 5m 0s)",
      ].join("\n"),
    );
  });

  it("renders the Telegram panel byte for byte", () => {
    expect(
      telegramSettings("gpt-9", "high", true, 60_000, SETTINGS_DETAILS),
    ).toEqual(
      [
        "<b>🦅 Settings</b>",
        "",
        "<b>Model:</b> <code>gpt-9</code>",
        "Hint: use /model &lt;name&gt; to switch.",
        "Provider: A &amp; B",
        "<b>Effort:</b> high",
        "<b>Pulse:</b> on (every 1m 0s)",
      ].join("\n"),
    );
  });

  it("renders the Telegram panel with pulse off and no details", () => {
    expect(telegramSettings("gpt-9", "adaptive", false)).toEqual(
      [
        "<b>🦅 Settings</b>",
        "",
        "<b>Model:</b> <code>gpt-9</code>",
        "<b>Effort:</b> adaptive",
        "<b>Pulse:</b> off (every 5m 0s)",
      ].join("\n"),
    );
  });
});
