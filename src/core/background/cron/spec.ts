/**
 * The schedule half of a cron job — cadence, lifecycle bounds, run cap,
 * catch-up policy, and the query overrides — parsed and validated once for
 * both `create_cron_job` and `edit_cron_job`.
 *
 * The two actions read the same body fields but with different absence
 * semantics: on create an absent field takes its default, on edit an absent
 * field is left alone and a blank one (`null` / `""`) clears the stored
 * value. `parseCronSpec` folds both into one pass: pass `existing` to parse
 * as an edit. Cross-field rules (end after start, provider needs model,
 * overrides only on query jobs) are checked against the *effective* job —
 * the merge of what's stored and what's changing — so a partial edit is
 * judged on the job it produces, not the fields it touches.
 */

import {
  validateCronExpression,
  type CatchupPolicy,
  type CronJob,
  type CronJobType,
} from "../../../storage/cron.js";

/** The scheduler ticks once a minute, so sub-minute intervals are meaningless. */
const MIN_INTERVAL_SECONDS = 60;
const MAX_CONTENT_LENGTH = 10_000;
const CATCHUP_POLICIES = new Set<CatchupPolicy>(["skip", "once", "all"]);
/** Per-job run timeout bounds (seconds). The scheduler default is 10 minutes. */
const MIN_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 4 * 60 * 60;

/** The job fields the spec covers; everything else is identity or telemetry. */
type CronSpec = Pick<CronJob, "name" | "type" | "content" | "catchup"> &
  Partial<
    Pick<
      CronJob,
      | "enabled"
      | "timezone"
      | "schedule"
      | "everyMs"
      | "startAt"
      | "endAt"
      | "maxRuns"
      | "model"
      | "provider"
      | "instructions"
      | "timeoutMs"
    >
  >;

/**
 * The fields an edit touches, in body order. A key present with value
 * `undefined` clears that field (`updateCronJob` has Object.assign
 * semantics), so key *presence* is the signal — not truthiness.
 */
type CronSpecUpdates = Partial<CronSpec>;

export type ParsedCronSpec =
  | {
      ok: true;
      /** What to write: the full spec on create, the touched fields on edit. */
      updates: CronSpecUpdates;
      /** The job as it will be after the write — what the cross-field rules saw. */
      effective: CronSpec;
    }
  | { ok: false; error: string };

/** True for a body field that was actually supplied (not absent/blank). */
function provided(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

/**
 * Parse an instant given as an ISO-8601 string or epoch-ms number into epoch
 * ms. Returns undefined when the field is absent or unparseable — callers
 * distinguish the two via `provided()`.
 */
function parseInstant(v: unknown): number | undefined {
  if (!provided(v)) return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const d = Date.parse(s);
  return Number.isFinite(d) ? d : undefined;
}

/** What one parse pass works on; each section parser fills `updates`. */
type Parse = {
  body: Record<string, unknown>;
  existing: CronJob | undefined;
  editing: boolean;
  /** On create a blank is absent; on edit it is a request to clear. */
  touched: (key: string) => boolean;
  updates: CronSpecUpdates;
};

/** A section parser returns an error message, or null when its fields are fine. */
type Section = (p: Parse) => string | null;

/**
 * The job the write produces. On create `updates` is the whole spec (name,
 * type, content and catchup are always filled in), so the cast only papers
 * over what the parse order already guarantees.
 */
const merge = (p: Parse) => ({ ...p.existing, ...p.updates }) as CronSpec;

const parsePayload: Section = ({ body, editing, touched, updates }) => {
  if (editing) {
    if (touched("name")) updates.name = String(body.name);
    if (touched("content")) updates.content = String(body.content);
    if (touched("enabled")) updates.enabled = Boolean(body.enabled);
    if (touched("type")) updates.type = String(body.type) as CronJobType;
  } else {
    updates.name = String(body.name ?? "Unnamed job");
    updates.type = (body.type as CronJobType) ?? "message";
    updates.content = String(body.content ?? "");
    if (!updates.content) return "Missing content";
    if (updates.content.length > MAX_CONTENT_LENGTH)
      return "Content too long (max 10,000 chars)";
  }
  if (touched("timezone"))
    updates.timezone = body.timezone ? String(body.timezone) : undefined;
  return null;
};

/**
 * Exactly one of `schedule` (cron expression) or `every_seconds` (fixed
 * interval). On edit, setting one switches mode and clears the other.
 */
const parseCadence: Section = ({
  body,
  existing,
  editing,
  touched,
  updates,
}) => {
  const schedule = provided(body.schedule) ? String(body.schedule) : undefined;
  const hasEvery = provided(body.every_seconds);
  if (!editing && !schedule && !hasEvery)
    return "Provide either 'schedule' (a cron expression) or 'every_seconds' (a fixed interval).";
  if (schedule && hasEvery)
    return "Provide only one of 'schedule' or 'every_seconds', not both.";
  if (schedule) {
    const timezone = touched("timezone")
      ? updates.timezone
      : existing?.timezone;
    const validation = validateCronExpression(schedule, timezone);
    if (!validation.valid)
      return `Invalid cron expression: ${validation.error}`;
    updates.schedule = schedule;
    if (editing) updates.everyMs = undefined;
  }
  if (hasEvery) {
    const everySeconds = Number(body.every_seconds);
    if (!Number.isFinite(everySeconds) || everySeconds < MIN_INTERVAL_SECONDS)
      return `'every_seconds' must be a number >= ${MIN_INTERVAL_SECONDS}${
        editing ? "" : " (the scheduler ticks once a minute)"
      }.`;
    updates.everyMs = Math.round(everySeconds * 1000);
    if (editing) updates.schedule = undefined;
  }
  return null;
};

/** Lifecycle bounds; on edit pass null/"" to clear one. */
const parseBounds: Section = (p) => {
  const { body, editing, touched, updates } = p;
  const hint = editing ? "" : " (use an ISO-8601 timestamp or epoch ms)";
  if (touched("start_at")) {
    const startAt = parseInstant(body.start_at);
    if (provided(body.start_at) && startAt === undefined)
      return `Could not parse 'start_at'${hint}.`;
    updates.startAt = startAt;
  }
  if (touched("end_at")) {
    const endAt = parseInstant(body.end_at);
    if (provided(body.end_at) && endAt === undefined)
      return `Could not parse 'end_at'${hint}.`;
    updates.endAt = endAt;
  }
  const { startAt, endAt } = merge(p);
  if (startAt !== undefined && endAt !== undefined && endAt <= startAt)
    return "'end_at' must be after 'start_at'.";
  if (updates.endAt !== undefined && updates.endAt <= Date.now())
    return "'end_at' is in the past — the job would never run.";
  return null;
};

/** Run cap. `once: true` is sugar for max_runs = 1 (one-shot). */
const parseRunCap: Section = ({ body, touched, updates }) => {
  if (body.once === true) {
    updates.maxRuns = 1;
    return null;
  }
  if (!touched("max_runs")) return null;
  if (!provided(body.max_runs)) {
    updates.maxRuns = undefined;
    return null;
  }
  const m = Number(body.max_runs);
  if (!Number.isInteger(m) || m < 1)
    return "'max_runs' must be a positive integer.";
  updates.maxRuns = m;
  return null;
};

/**
 * Missed-run catch-up policy. New jobs default to "once": a run that came
 * due while Talon was down (or while the scheduler was wedged) replays a
 * single time at startup instead of being lost silently — a live audit
 * found one-shot reminders that missed their date under the old "skip"
 * default and quietly rolled over a full year. Explicit "skip" remains
 * available for jobs where a late run is worthless.
 */
const parseCatchup: Section = ({ body, editing, touched, updates }) => {
  if (!touched("catchup")) {
    if (!editing) updates.catchup = "once";
    return null;
  }
  const catchup = String(body.catchup) as CatchupPolicy;
  if (!CATCHUP_POLICIES.has(catchup))
    return "'catchup' must be one of: skip, once, all.";
  updates.catchup = catchup;
  return null;
};

/**
 * Model / provider / instructions / timeout only make sense for "query" jobs
 * (a "message" job just sends text — no model runs), and a provider override
 * needs a model to pick on it.
 */
const parseOverrides: Section = (p) => {
  const { body, touched, updates } = p;
  for (const key of ["model", "provider", "instructions"] as const) {
    if (touched(key))
      updates[key] = provided(body[key]) ? String(body[key]) : undefined;
  }
  if (touched("timeout_seconds")) {
    if (!provided(body.timeout_seconds)) {
      updates.timeoutMs = undefined;
    } else {
      const secs = Number(body.timeout_seconds);
      if (
        !Number.isFinite(secs) ||
        secs < MIN_TIMEOUT_SECONDS ||
        secs > MAX_TIMEOUT_SECONDS
      )
        return `'timeout_seconds' must be a number between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}.`;
      updates.timeoutMs = Math.round(secs * 1000);
    }
  }
  const { type, model, provider, instructions, timeoutMs } = merge(p);
  if (type !== "query" && (model || provider || instructions))
    return "Model/provider/instructions only apply to 'query' jobs.";
  if (type !== "query" && timeoutMs !== undefined)
    return "'timeout_seconds' only applies to 'query' jobs.";
  if (provider && !model)
    return "A 'provider' override also requires a 'model'.";
  return null;
};

const SECTIONS: Section[] = [
  parsePayload,
  parseCadence,
  parseBounds,
  parseRunCap,
  parseCatchup,
  parseOverrides,
];

/**
 * Validate a create/edit body's schedule fields and normalise them into job
 * fields. Without `existing` this is a create: cadence is required, blanks
 * are absent, defaults fill in. With `existing` it is an edit of that job:
 * only supplied fields are emitted, blanks clear.
 */
export function parseCronSpec(
  body: Record<string, unknown>,
  existing?: CronJob,
): ParsedCronSpec {
  const editing = existing !== undefined;
  const p: Parse = {
    body,
    existing,
    editing,
    touched: (key) => (editing ? body[key] !== undefined : provided(body[key])),
    updates: {},
  };
  for (const section of SECTIONS) {
    const error = section(p);
    if (error) return { ok: false, error };
  }
  return { ok: true, updates: p.updates, effective: merge(p) };
}
