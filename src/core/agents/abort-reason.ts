/**
 * Why a run's AbortSignal fired — so logs and results can say "killed" for
 * a deliberate kill_agent instead of blaming a timeout that never happened.
 *
 * Abort sites pass a typed reason (`controller.abort(reason)`); consumers
 * read it back with `abortKind(signal)`. A bare `abort()` carries the
 * runtime's default AbortError reason and reads as a plain "aborted".
 */

/** Reason passed when an operator/agent deliberately kills a run. */
export class RunKilledError extends Error {
  constructor(message = "run killed on request") {
    super(message);
    this.name = "RunKilledError";
  }
}

export type AbortKind = "killed" | "timeout" | "aborted";

/** Classify an abort reason (typically `signal.reason`). */
export function abortKindOf(reason: unknown): AbortKind {
  if (reason instanceof RunKilledError) return "killed";
  const r = reason as { name?: unknown; message?: unknown } | null;
  const name = typeof r?.name === "string" ? r.name : "";
  const message = typeof r?.message === "string" ? r.message : "";
  if (name === "RunKilledError") return "killed";
  if (/timeout/i.test(name) || /timed out/i.test(message)) return "timeout";
  return "aborted";
}

/** Classify why `signal` fired ("aborted" when it has not, or gave no reason). */
export function abortKind(signal: AbortSignal): AbortKind {
  return signal.aborted ? abortKindOf(signal.reason) : "aborted";
}

/** One-line run-log sentence for an aborted run. */
export function abortLogLine(signal: AbortSignal): string {
  switch (abortKind(signal)) {
    case "killed":
      return "Run killed on request.";
    case "timeout":
      return "Run aborted by timeout.";
    default:
      return "Run aborted.";
  }
}
