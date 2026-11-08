/**
 * CompanionPairStore — one-time grants that connect a phone to this bridge
 * without anyone typing a host, a port, or a bearer token.
 *
 * The problem it removes: a companion joins the mesh by being told the
 * bridge's address, its bearer token, and (over TLS) the certificate
 * fingerprint to pin. Reading those off a terminal and typing them into a
 * phone is the single worst step in setting Talon up, and a mistyped token
 * fails in a way that looks like a network problem.
 *
 * So the daemon mints a grant and hands out ONE link. The bridge serves it
 * on a route that must work pre-auth — the phone holds no credential yet, so
 * the grant token IS the authorization, the same trust model as node
 * provisioning (node-provision.ts) and streamed transfers (transfers/transfers.ts):
 * random 192-bit, single-use, expiring unused.
 *
 *   GET /pair?grant=<token>              → the pairing page (once)
 *   GET /pair?grant=<token>&format=json  → the same payload as JSON
 *
 * Opening the link on the phone lands on a page whose button is a
 * `talon://pair` deep link carrying the credentials, so the companion fills
 * its own connection form. The page also prints the values for anyone who
 * would rather type them, because a deep link is exactly the thing that
 * silently does nothing when the app isn't installed.
 *
 * The grant is consumed by whichever leg is served first, and both legs
 * render the same claimed grant — by the time a page has rendered, the
 * credentials are already on the phone, so a second serve would only widen
 * the window for someone else to replay the URL.
 */

import { randomBytes } from "node:crypto";

/** Unclaimed grants die after this long. A pairing link is used at once. */
export const PAIR_GRANT_TTL_MS = 10 * 60 * 1000;

export type CompanionPairGrant = {
  token: string;
  /** Bridge base URL as reachable from the phone. */
  bridgeUrl: string;
  /** Bearer token the companion will authenticate with. */
  bearerToken: string;
  /** Bridge TLS certificate fingerprint to pre-pin (absent over plain HTTP). */
  fingerprint?: string;
  /** What this daemon calls itself, so the phone can label the connection. */
  label?: string;
  createdAt: number;
  used: boolean;
};

/** What the phone needs to connect, as served to the companion. */
export type CompanionPairPayload = {
  url: string;
  token: string;
  fingerprint?: string;
  label?: string;
};

export class CompanionPairStore {
  private readonly grants = new Map<string, CompanionPairGrant>();

  constructor(private readonly ttlMs = PAIR_GRANT_TTL_MS) {}

  create(
    grant: Omit<CompanionPairGrant, "token" | "createdAt" | "used">,
  ): CompanionPairGrant {
    this.sweep();
    const full: CompanionPairGrant = {
      ...grant,
      // The label is interpolated into generated HTML and a URL query —
      // keep it to characters that can't carry markup out of either.
      ...(grant.label
        ? { label: grant.label.replace(/[^\w .-]+/g, "").slice(0, 64) }
        : {}),
      token: randomBytes(24).toString("base64url"),
      createdAt: Date.now(),
      used: false,
    };
    this.grants.set(full.token, full);
    return full;
  }

  /** Resolve a live grant — once. */
  claim(token: string): CompanionPairPayload | null {
    this.sweep();
    const grant = this.grants.get(token);
    if (!grant || grant.used) return null;
    grant.used = true;
    this.grants.delete(token);
    return {
      url: grant.bridgeUrl,
      token: grant.bearerToken,
      ...(grant.fingerprint ? { fingerprint: grant.fingerprint } : {}),
      ...(grant.label ? { label: grant.label } : {}),
    };
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [token, grant] of this.grants) {
      if (grant.createdAt < cutoff) this.grants.delete(token);
    }
  }
}

/** The link a human opens on the phone. */
export function pairLink(grant: CompanionPairGrant): string {
  return `${grant.bridgeUrl}/pair?grant=${grant.token}`;
}

/**
 * The `talon://pair` deep link the companion registers for. Carries the
 * credentials themselves rather than the grant, because the grant is spent
 * by the time this reaches the phone — and because a deep link that needed
 * another round trip would fail on exactly the flaky first connection it
 * exists to make painless.
 */
export function pairDeepLink(payload: CompanionPairPayload): string {
  const q = new URLSearchParams({ u: payload.url, t: payload.token });
  if (payload.fingerprint) q.set("f", payload.fingerprint);
  if (payload.label) q.set("n", payload.label);
  return `talon://pair?${q.toString()}`;
}

/** Minimal HTML escape for the values interpolated into the pairing page. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The page the phone lands on. Deliberately one self-contained file with no
 * external assets: it is served by a bridge the browser has usually just
 * warned about (self-signed cert), often over a LAN with no internet route,
 * and a page that half-loads there is worse than no page at all.
 */
export function pairPage(payload: CompanionPairPayload): string {
  const deep = pairDeepLink(payload);
  const fp = payload.fingerprint;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Talon</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 24px; font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  p.sub { margin: 0 0 1.5rem; opacity: .7; }
  a.go { display: block; text-align: center; padding: 14px; border-radius: 10px;
         background: #2f6fed; color: #fff; text-decoration: none; font-weight: 600; }
  dl { margin: 1.5rem 0 0; }
  dt { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; opacity: .6; margin-top: 1rem; }
  dd { margin: .2rem 0 0; font-family: ui-monospace, monospace; font-size: .85rem; word-break: break-all; }
  footer { margin-top: 2rem; font-size: .8rem; opacity: .6; }
</style>
</head>
<body>
<main>
  <h1>Connect to Talon</h1>
  <p class="sub">${payload.label ? esc(payload.label) : "This daemon"} is ready to pair.</p>
  <a class="go" href="${esc(deep)}">Open in Talon</a>
  <dl>
    <dt>Bridge</dt><dd>${esc(payload.url)}</dd>
    <dt>Token</dt><dd>${esc(payload.token)}</dd>
    ${fp ? `<dt>Certificate</dt><dd>${esc(fp)}</dd>` : ""}
  </dl>
  <footer>
    If the button does nothing, the companion isn't installed yet — install it,
    then enter the values above by hand. This link is single-use and is now spent.
  </footer>
</main>
</body>
</html>
`;
}
