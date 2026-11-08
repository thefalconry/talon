/**
 * `parseCronSpec` — the one schedule parser behind create_cron_job and
 * edit_cron_job.
 *
 * The gateway tests (cron-gateway.test.ts) drive the actions end to end and
 * pin the error strings the model sees. These pin the parser's own contract:
 * the create/edit absence semantics (absent → default vs absent → untouched,
 * blank → clear), the `updates` key set an edit emits (it becomes the
 * "Fields changed" list and the Object.assign write), and the cross-field
 * rules judged on the merged job rather than on the touched fields.
 */

import { describe, it, expect } from "vitest";
import { parseCronSpec } from "../core/background/cron/spec.js";
import type { CronJob } from "../storage/cron.js";

const HOUR = 60 * 60_000;
const future = (hours: number) => new Date(Date.now() + hours * HOUR);

const stored = (over: Partial<CronJob> = {}): CronJob => ({
  id: "cron_1",
  chatId: "42",
  schedule: "0 9 * * *",
  type: "message",
  content: "hello",
  name: "Morning",
  enabled: true,
  createdAt: 1_000,
  runCount: 0,
  catchup: "once",
  ...over,
});

const okOf = (r: ReturnType<typeof parseCronSpec>) => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r;
};
const errorOf = (r: ReturnType<typeof parseCronSpec>) =>
  r.ok ? null : r.error;

describe("parseCronSpec — create", () => {
  it("fills defaults and returns the full spec as both updates and effective", () => {
    const r = okOf(parseCronSpec({ content: "hi", schedule: "*/5 * * * *" }));
    expect(r.updates).toEqual({
      name: "Unnamed job",
      type: "message",
      content: "hi",
      schedule: "*/5 * * * *",
      catchup: "once",
    });
    expect(r.effective).toEqual(r.updates);
  });

  it("normalises an interval to everyMs and never emits the other cadence key", () => {
    const r = okOf(parseCronSpec({ content: "hi", every_seconds: 90 }));
    expect(r.updates.everyMs).toBe(90_000);
    expect("schedule" in r.updates).toBe(false);
  });

  it("treats blank fields as absent", () => {
    const r = okOf(
      parseCronSpec({
        content: "hi",
        schedule: "0 9 * * *",
        timezone: "",
        start_at: "",
        max_runs: null,
        catchup: "",
      }),
    );
    expect(r.updates).toEqual({
      name: "Unnamed job",
      type: "message",
      content: "hi",
      schedule: "0 9 * * *",
      catchup: "once",
    });
  });

  it("requires content and a cadence", () => {
    expect(errorOf(parseCronSpec({ schedule: "0 9 * * *" }))).toBe(
      "Missing content",
    );
    expect(errorOf(parseCronSpec({ content: "x".repeat(10_001) }))).toBe(
      "Content too long (max 10,000 chars)",
    );
    expect(errorOf(parseCronSpec({ content: "hi" }))).toBe(
      "Provide either 'schedule' (a cron expression) or 'every_seconds' (a fixed interval).",
    );
  });

  it("parses the lifecycle bounds and once/max_runs", () => {
    const start = future(1);
    const end = future(2);
    const r = okOf(
      parseCronSpec({
        content: "hi",
        schedule: "0 9 * * *",
        start_at: start.toISOString(),
        end_at: String(end.getTime()),
        once: true,
      }),
    );
    expect(r.updates.startAt).toBe(start.getTime());
    expect(r.updates.endAt).toBe(end.getTime());
    expect(r.updates.maxRuns).toBe(1);
  });

  it("carries the create-only hints in the interval and instant errors", () => {
    expect(errorOf(parseCronSpec({ content: "hi", every_seconds: 5 }))).toBe(
      "'every_seconds' must be a number >= 60 (the scheduler ticks once a minute).",
    );
    expect(
      errorOf(
        parseCronSpec({ content: "hi", schedule: "0 9 * * *", start_at: "?" }),
      ),
    ).toBe(
      "Could not parse 'start_at' (use an ISO-8601 timestamp or epoch ms).",
    );
  });

  it("only allows query overrides on query jobs, and provider needs a model", () => {
    expect(
      errorOf(
        parseCronSpec({ content: "hi", schedule: "0 9 * * *", model: "m" }),
      ),
    ).toBe("Model/provider/instructions only apply to 'query' jobs.");
    expect(
      errorOf(
        parseCronSpec({
          content: "hi",
          schedule: "0 9 * * *",
          type: "query",
          provider: "p",
        }),
      ),
    ).toBe("A 'provider' override also requires a 'model'.");
  });

  it("parses timeout_seconds into timeoutMs for query jobs, within bounds", () => {
    const ok = okOf(
      parseCronSpec({
        content: "wait for CI then merge",
        schedule: "0 9 * * *",
        type: "query",
        timeout_seconds: 2700,
      }),
    );
    expect(ok.updates.timeoutMs).toBe(2_700_000);

    const base = { content: "x", schedule: "0 9 * * *", type: "query" };
    expect(errorOf(parseCronSpec({ ...base, timeout_seconds: 10 }))).toBe(
      "'timeout_seconds' must be a number between 60 and 14400.",
    );
    expect(errorOf(parseCronSpec({ ...base, timeout_seconds: 99_999 }))).toBe(
      "'timeout_seconds' must be a number between 60 and 14400.",
    );
    expect(
      errorOf(
        parseCronSpec({
          content: "hi",
          schedule: "0 9 * * *",
          timeout_seconds: 600,
        }),
      ),
    ).toBe("'timeout_seconds' only applies to 'query' jobs.");
  });
});

describe("parseCronSpec — edit", () => {
  it("sets and clears a query job's timeout", () => {
    const job = stored({ type: "query", timeoutMs: 1_200_000 });
    expect(okOf(parseCronSpec({ timeout_seconds: 3600 }, job)).updates).toEqual(
      { timeoutMs: 3_600_000 },
    );
    const cleared = okOf(parseCronSpec({ timeout_seconds: null }, job));
    expect("timeoutMs" in cleared.updates).toBe(true);
    expect(cleared.updates.timeoutMs).toBeUndefined();
  });

  it("emits only the touched fields, in body order", () => {
    const r = okOf(
      parseCronSpec(
        { name: "Renamed", enabled: false, catchup: "all" },
        stored(),
      ),
    );
    expect(Object.keys(r.updates)).toEqual(["name", "enabled", "catchup"]);
    expect(r.effective).toMatchObject({
      name: "Renamed",
      enabled: false,
      catchup: "all",
      schedule: "0 9 * * *",
    });
  });

  it("leaves absent fields untouched but clears blank ones", () => {
    const job = stored({ startAt: 5, timezone: "UTC", maxRuns: 3 });
    const r = okOf(
      parseCronSpec({ start_at: null, timezone: "", max_runs: "" }, job),
    );
    expect(r.updates).toEqual({
      timezone: undefined,
      startAt: undefined,
      maxRuns: undefined,
    });
    expect(Object.keys(r.updates)).toEqual(["timezone", "startAt", "maxRuns"]);
    expect(r.effective.name).toBe("Morning");
  });

  it("switching cadence clears the other mode explicitly", () => {
    const toInterval = okOf(parseCronSpec({ every_seconds: 120 }, stored()));
    expect(toInterval.updates).toEqual({
      everyMs: 120_000,
      schedule: undefined,
    });

    const toCron = okOf(
      parseCronSpec(
        { schedule: "0 12 * * *" },
        stored({ schedule: undefined, everyMs: 120_000 }),
      ),
    );
    expect(toCron.updates).toEqual({
      schedule: "0 12 * * *",
      everyMs: undefined,
    });
  });

  it("validates the new expression against the effective timezone", () => {
    const withTz = parseCronSpec(
      { schedule: "0 9 * * *", timezone: "Not/Real" },
      stored(),
    );
    expect(errorOf(withTz)).toMatch(/^Invalid cron expression: /);
    expect(
      errorOf(
        parseCronSpec(
          { schedule: "0 9 * * *" },
          stored({ timezone: "Not/Real" }),
        ),
      ),
    ).toMatch(/^Invalid cron expression: /);
  });

  it("uses the shorter edit-mode error texts", () => {
    expect(errorOf(parseCronSpec({ every_seconds: 5 }, stored()))).toBe(
      "'every_seconds' must be a number >= 60.",
    );
    expect(errorOf(parseCronSpec({ end_at: "never" }, stored()))).toBe(
      "Could not parse 'end_at'.",
    );
  });

  it("judges the window and the overrides on the merged job", () => {
    const start = future(5).getTime();
    expect(
      errorOf(
        parseCronSpec(
          { end_at: new Date(start - 60_000).toISOString() },
          stored({ startAt: start }),
        ),
      ),
    ).toBe("'end_at' must be after 'start_at'.");

    // Flipping a query job with a model back to "message" is rejected even
    // though the edit never mentions the model.
    expect(
      errorOf(
        parseCronSpec(
          { type: "message" },
          stored({ type: "query", model: "m" }),
        ),
      ),
    ).toBe("Model/provider/instructions only apply to 'query' jobs.");

    // Clearing the model while a provider stays behind is rejected too.
    expect(
      errorOf(
        parseCronSpec(
          { model: "" },
          stored({ type: "query", model: "m", provider: "p" }),
        ),
      ),
    ).toBe("A 'provider' override also requires a 'model'.");
  });
});
