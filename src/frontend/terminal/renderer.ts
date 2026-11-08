/**
 * Terminal renderer — minimal, clean output.
 *
 * The renderer NEVER touches readline. It only writes to stdout.
 * The caller (index.ts) is responsible for pausing/resuming readline.
 * Spinner uses atomic \r overwrite — single write call, zero flicker.
 */

import pc from "picocolors";
import { formatTokenCount, formatUsd } from "../presentation/format.js";

// ── Types ────────────────────────────────────────────────────────────────────

type StatusBarInfo = {
  model: string;
  sessionName?: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitPct?: number;
  costUsd: number;
};

export type Renderer = {
  readonly cols: number;
  writeln(text?: string): void;
  writeSystem(text: string): void;
  writeError(text: string): void;
  renderAssistantMessage(text: string): void;
  renderToolCall(toolName: string, input: Record<string, unknown>): void;
  renderStatusLine(
    durationMs: number,
    tools: number,
    info: StatusBarInfo,
  ): void;
  startSpinner(label?: string): void;
  updateSpinnerLabel(label: string): void;
  stopSpinner(): void;
};

// ── Constants ────────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const HIDDEN_TOOLS = new Set(["TodoRead", "TodoWrite"]);

// ── Helpers (exported for testing) ───────────────────────────────────────────

export function wrap(text: string, indent: number, maxWidth: number): string {
  const width = maxWidth - indent;
  if (width <= 20) return text;
  const pad = " ".repeat(indent);
  return text
    .split("\n")
    .map((line) => {
      if (line.length <= width) return pad + line;
      const words = line.split(" ");
      const wrapped: string[] = [];
      let cur = "";
      for (const w of words) {
        if (cur.length + w.length + 1 > width && cur) {
          wrapped.push(pad + cur);
          cur = w;
        } else {
          cur = cur ? cur + " " + w : w;
        }
      }
      if (cur) wrapped.push(pad + cur);
      return wrapped.join("\n");
    })
    .join("\n");
}

export function extractToolDetail(
  input: Record<string, unknown>,
  maxLen: number,
): string {
  if (input.command) {
    const s = String(input.description || input.command);
    return s.length > maxLen ? s.slice(0, maxLen - 3) + "..." : s;
  }
  if (input.file_path) return String(input.file_path);
  if (input.pattern && input.path) return `${input.pattern} in ${input.path}`;
  if (input.pattern) return String(input.pattern);
  if (input.action) return String(input.action);
  if (input.query) return String(input.query).slice(0, maxLen);
  if (input.url) return String(input.url).slice(0, maxLen);
  if (input.type) return String(input.type);
  if (input.name) return String(input.name);
  if (input.model) return String(input.model);
  if (input.package_url) return String(input.package_url);
  if (input.build_number) return `#${input.build_number}`;
  if (input.packages) return (input.packages as string[]).join(", ");
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (k === "_chatId") continue;
    if (typeof v === "string" && v.length > 0)
      parts.push(`${k}=${v.length > 30 ? v.slice(0, 30) + "..." : v}`);
    else if (typeof v === "number" || typeof v === "boolean")
      parts.push(`${k}=${v}`);
  }
  return parts.join(", ").slice(0, maxLen);
}

export function cleanToolName(name: string): string {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts[parts.length - 1] || name;
  }
  return name;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createRenderer(cols?: number, displayName = "Talon"): Renderer {
  const COLS = cols ?? Math.min(process.stdout.columns || 100, 120);
  const botName = displayName;

  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;
  let spinnerLabel = "thinking";
  let spinnerLineLen = 0;
  let hasToolOutput = false;

  // ── Output primitives ──

  function writeln(text = ""): void {
    process.stdout.write(`\x1b[2K\r${text}\n`);
  }

  function writeSystem(text: string): void {
    writeln(`  ${pc.dim(text)}`);
  }

  function writeError(text: string): void {
    writeln();
    writeln(`  ${pc.red("✖")} ${pc.red(text)}`);
  }

  // ── Messages ──

  function renderAssistantMessage(text: string): void {
    writeln();
    writeln(`  ${pc.cyan("▍")} ${pc.bold(pc.cyan(botName))}`);
    for (const line of wrap(text, 2, COLS).split("\n")) {
      writeln(`  ${pc.cyan("▍")}${line}`);
    }
  }

  function renderToolCall(
    toolName: string,
    input: Record<string, unknown>,
  ): void {
    const clean = cleanToolName(toolName);
    if (HIDDEN_TOOLS.has(clean)) return;
    if (!hasToolOutput) {
      hasToolOutput = true;
      writeln();
    }
    const display = clean.replace(/_/g, " ");
    const maxD = COLS - display.length - 16;
    const detail = extractToolDetail(input, maxD);
    writeln(
      `    ${pc.dim("→")} ${pc.yellow(display)}${detail ? `  ${pc.dim(detail)}` : ""}`,
    );
  }

  function renderStatusLine(
    ms: number,
    tools: number,
    info: StatusBarInfo,
  ): void {
    const p = [`${(ms / 1000).toFixed(1)}s`, info.model];
    if (info.sessionName) p.push(`"${info.sessionName}"`);
    p.push(
      `${info.turns} turn${info.turns !== 1 ? "s" : ""}`,
      `${formatTokenCount(info.inputTokens + info.outputTokens)} tok`,
    );
    if (typeof info.cacheHitPct === "number") {
      p.push(`${info.cacheHitPct}% cache`);
    }
    if (info.costUsd > 0) p.push(formatUsd(info.costUsd));
    if (tools > 0) p.push(`${tools} tool${tools > 1 ? "s" : ""}`);
    writeln();
    writeln(`  ${pc.dim(p.join("  ·  "))}`);
    hasToolOutput = false;
  }

  // ── Spinner ──
  // Pure stdout. Never touches readline.

  function startSpinner(label = "thinking"): void {
    stopSpinner();
    spinnerLabel = label;
    spinnerFrame = 0;
    spinnerLineLen = 0;
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % FRAMES.length;
      const line = `    ${pc.dim(FRAMES[spinnerFrame]!)}  ${pc.dim(spinnerLabel)}`;
      const pad =
        spinnerLineLen > line.length
          ? " ".repeat(spinnerLineLen - line.length)
          : "";
      spinnerLineLen = line.length;
      process.stdout.write(`\r${line}${pad}`);
    }, 80);
  }

  function updateSpinnerLabel(label: string): void {
    spinnerLabel = label;
  }

  function stopSpinner(): void {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
      process.stdout.write("\x1b[2K\r");
      spinnerLineLen = 0;
    }
  }

  return {
    cols: COLS,
    writeln,
    writeSystem,
    writeError,
    renderAssistantMessage,
    renderToolCall,
    renderStatusLine,
    startSpinner,
    updateSpinnerLabel,
    stopSpinner,
  };
}
