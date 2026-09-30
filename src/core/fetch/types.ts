/**
 * Shared shapes for the fetch ladder (see ladder.ts and docs/fetch-ladder.md).
 */

/** One HTTP request as a rung sees it. */
export type RungRequest = {
  url: URL;
  /** Extra headers on top of whatever the rung's browser profile sends. */
  headers: Record<string, string>;
  timeoutMs: number;
  /** Hard body cap; a rung must fail rather than buffer more. */
  maxBytes: number;
  /**
   * When the SSRF guard is on: the public addresses the host was checked
   * against. A rung that can pin the connection to them (curl `--resolve`)
   * should, closing the DNS-rebinding race the guard otherwise leaves.
   */
  pinnedAddresses?: readonly string[];
  /** Cookie jar shared across the redirect hops of one attempt (curl rungs). */
  cookieJar?: string;
};

/** What a rung got back for one hop. */
export type RawResponse = {
  status: number;
  headers: Headers;
  body: Buffer;
  /** Final URL (differs from the request only for rungs that follow redirects). */
  url: string;
};

export type Rung = {
  /** Shown to the model and in logs: "impersonate:safari184", "plain", … */
  readonly name: string;
  /**
   * True for rungs whose bytes cross somebody else's link (SOCKS exits, a
   * mesh device) — they count against `fetch.dailyByteCap`.
   */
  readonly relayed: boolean;
  /**
   * True when the rung follows redirects itself (a browser, a remote curl).
   * Otherwise the ladder follows them hop by hop so the guard sees each one.
   */
  readonly followsRedirects: boolean;
  /**
   * True for rungs that make no sense for a private/loopback target (a
   * home-lab page has no bot wall, and an exit can't reach it anyway).
   */
  readonly publicOnly: boolean;
  /** Per-attempt timeout override (a browser needs longer than curl). */
  readonly timeoutMs?: number;
  /**
   * Whether the rung can run right now (binary present, endpoint set,
   * device online). May do one-time setup such as a binary download.
   * Returning a string means "no" with a reason worth reporting.
   */
  available(): Promise<true | string>;
  request(req: RungRequest): Promise<RawResponse>;
};

/**
 * How a response is judged:
 *  - ok: usable content.
 *  - blocked: a bot wall (403/429/503/999 or a challenge page) — climb on.
 *  - network: no HTTP answer at all (timeout, reset, DNS) — climb on.
 *  - not-found: 404/410 — the URL is wrong, not blocked; stop climbing.
 *  - http-error: any other definitive HTTP failure — stop climbing.
 */
export type Verdict = "ok" | "blocked" | "network" | "not-found" | "http-error";

/** One rung's outcome, as recorded in the attempt log. */
export type RungOutcome = {
  via: string;
  ok: boolean;
  verdict: Verdict | "skipped";
  status?: number;
  bytes?: number;
  /** Why the rung failed or was skipped. */
  detail?: string;
};

type LadderSuccess = {
  ok: true;
  via: string;
  status: number;
  headers: Headers;
  body: Buffer;
  url: string;
  attempts: RungOutcome[];
  /** Set when the result deserves a caveat (see FetchLadder.fetch). */
  note?: string;
};

type LadderFailure = {
  ok: false;
  /** The verdict that ended the climb (last rung's, or the definitive one). */
  verdict: Verdict | "skipped";
  status?: number;
  via?: string;
  /** Human-readable, honest summary for the tool result. */
  error: string;
  attempts: RungOutcome[];
};

export type LadderResult = LadderSuccess | LadderFailure;
