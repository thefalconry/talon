/**
 * Frontend-agnostic display formatters shared by all chat frontends.
 *
 * One definition here keeps the frontends in lockstep — per-frontend copies
 * drift (parseInterval once accepted days on Discord but not Telegram).
 */

import { resolveModel } from "../../core/models/catalog.js";

export const DEFAULT_PULSE_INTERVAL_MS = 5 * 60 * 1000;

/** Parse a duration string like "30m", "2h", "1d", "1h30m", "1d6h" into ms. */
export function parseInterval(input: string): number | null {
  const match = input.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const days = parseInt(match[1] || "0", 10);
  const hours = parseInt(match[2] || "0", 10);
  const minutes = parseInt(match[3] || "0", 10);
  const ms = (days * 24 * 60 + hours * 60 + minutes) * 60 * 1000;
  return ms > 0 ? ms : null;
}

export function formatDuration(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  if (safeMs < 1000) return `${safeMs}ms`;
  const s = Math.floor(safeMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Keep small model costs legible without making larger totals noisy. */
export function formatUsd(cost: number): string {
  const safeCost = Number.isFinite(cost) && cost > 0 ? cost : 0;
  return `$${safeCost > 0.5 ? safeCost.toFixed(2) : safeCost.toFixed(4)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Resolve a model ID to its backend-registered display name. */
export function formatModelLabel(modelId: string): string {
  return resolveModel(modelId)?.displayName ?? modelId;
}
