import { describe, expect, it } from "vitest";
import {
  RunKilledError,
  abortKind,
  abortKindOf,
  abortLogLine,
} from "../util/abort-reason.js";
import { IsolatedAgentTimeoutError } from "../core/background/isolated-agent.js";

describe("abort reason classification", () => {
  it("a kill is 'killed'", () => {
    const c = new AbortController();
    c.abort(new RunKilledError());
    expect(abortKind(c.signal)).toBe("killed");
    expect(abortLogLine(c.signal)).toBe("Run killed on request.");
  });

  it("timeouts are 'timeout' whatever produced them", () => {
    expect(abortKindOf(new IsolatedAgentTimeoutError(5))).toBe("timeout");
    expect(
      abortKind(AbortSignal.abort(new DOMException("x", "TimeoutError"))),
    ).toBe("timeout");
    expect(abortKindOf(new Error("Dream agent timed out"))).toBe("timeout");
    const c = new AbortController();
    c.abort(new IsolatedAgentTimeoutError(5));
    expect(abortLogLine(c.signal)).toBe("Run aborted by timeout.");
  });

  it("a bare abort() is just 'aborted', never blamed on a timeout", () => {
    const c = new AbortController();
    c.abort();
    expect(abortKind(c.signal)).toBe("aborted");
    expect(abortLogLine(c.signal)).toBe("Run aborted.");
    expect(abortKind(new AbortController().signal)).toBe("aborted");
  });

  it("a structurally-named reason from another realm still counts as a kill", () => {
    expect(abortKindOf({ name: "RunKilledError", message: "x" })).toBe(
      "killed",
    );
  });
});
