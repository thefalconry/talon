/**
 * Timezone-aware time formatting utilities.
 *
 * Every helper formats in the IANA timezone set via `setTimezone`
 * (e.g. "Europe/Warsaw"), falling back to the system default.
 */

let configuredTz: string | undefined;

/** Set the global timezone used by all formatting helpers. */
export function setTimezone(tz: string | undefined): void {
  configuredTz = tz;
}

/** Get the active timezone (configured or system default). */
export function getTimezone(): string {
  return configuredTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// ── Formatting helpers ──────────────────────────────────────────────────────

/** Format a Date in the configured timezone as HH:MM. */
function toHHMM(date: Date): string {
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: getTimezone(),
  });
}

/** Format a Date in the configured timezone as YYYY-MM-DD. */
export function toYMD(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: getTimezone() }); // en-CA gives YYYY-MM-DD
}

/** Get "today" and "yesterday" date strings in the configured timezone. */
export function todayAndYesterday(): { today: string; yesterday: string } {
  const now = new Date();
  const today = toYMD(now);
  const yd = new Date(now.getTime() - 86_400_000);
  const yesterday = toYMD(yd);
  return { today, yesterday };
}

/**
 * Smart timestamp for message display.
 *
 * - Today:     "14:32"
 * - Yesterday: "Yesterday 14:32"
 * - This year: "Mar 19 14:32"
 * - Older:     "2025-12-19 14:32"
 */
export function formatSmartTimestamp(ts: number): string {
  const date = new Date(ts);
  const time = toHHMM(date);
  const dateStr = toYMD(date);
  const { today, yesterday } = todayAndYesterday();

  if (dateStr === today) return time;
  if (dateStr === yesterday) return `Yesterday ${time}`;

  const now = new Date();
  const thisYear = now
    .toLocaleDateString("en-CA", { timeZone: getTimezone() })
    .slice(0, 4);
  const msgYear = dateStr.slice(0, 4);

  if (msgYear === thisYear) {
    const month = date.toLocaleString("en-US", {
      month: "short",
      timeZone: getTimezone(),
    });
    const day = date.toLocaleString("en-US", {
      day: "numeric",
      timeZone: getTimezone(),
    });
    return `${month} ${day} ${time}`;
  }

  return `${dateStr} ${time}`;
}

/**
 * Human-readable relative age: "just now", "5m ago", "3h ago", "2d ago".
 * Used for user-facing displays where a precise timestamp isn't needed.
 */
export function formatRelativeAge(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Full datetime for system prompt injection.
 * Example: "2026-03-21 14:32 Fri (Europe/Warsaw)"
 */
export function formatFullDatetime(): string {
  const now = new Date();
  const tz = getTimezone();
  const dateStr = toYMD(now);
  const time = toHHMM(now);
  const weekday = now.toLocaleString("en-US", {
    weekday: "short",
    timeZone: tz,
  });
  return `${dateStr} ${time} ${weekday} (${tz})`;
}
