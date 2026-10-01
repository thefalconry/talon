/**
 * Secret drop: single-use, expiring grants that let the operator paste a
 * password into a form served by the native bridge instead of into a chat.
 *
 * Same trust model as companion pairing (mesh/links/companion-pairing.ts):
 * the bridge serves the grant pre-auth, and the random 192-bit grant in the
 * query is the whole authorization. Differences:
 *
 *   - GET only shows the form and does NOT spend the grant. Chat apps
 *     fetch links to build previews, and a preview must not burn the link
 *     before the human opens it.
 *   - POST spends it, once, whether or not the write then succeeds — a
 *     failed write asks for a fresh link rather than leaving a live one
 *     open to retries.
 *
 * The grant records which chat asked, so the receipt ("stored ✓ as <name>")
 * goes back there. The value itself never leaves `consume` except into the
 * file.
 */

import { randomBytes } from "node:crypto";

/** Unused grants die after this long. */
export const SECRET_GRANT_TTL_MS = 15 * 60 * 1000;

export type SecretDropGrant = {
  token: string;
  /** Validated secret name — the file under ~/.talon/secrets. */
  name: string;
  /** Shown on the form so the operator knows what is being asked for. */
  purpose?: string;
  /** Chat that asked, for the receipt. */
  chatKey: string;
  /** Frontend that chat lives on. */
  frontend: string;
  createdAt: number;
};

export class SecretDropStore {
  private readonly grants = new Map<string, SecretDropGrant>();

  constructor(
    private readonly ttlMs = SECRET_GRANT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  create(grant: Omit<SecretDropGrant, "token" | "createdAt">): SecretDropGrant {
    this.sweep();
    const full: SecretDropGrant = {
      ...grant,
      ...(grant.purpose ? { purpose: cleanPurpose(grant.purpose) } : {}),
      token: randomBytes(24).toString("base64url"),
      createdAt: this.now(),
    };
    this.grants.set(full.token, full);
    return full;
  }

  /** A live grant, without spending it (the GET form). */
  peek(token: string): SecretDropGrant | null {
    this.sweep();
    return this.grants.get(token) ?? null;
  }

  /** Spend a live grant (the POST). Null when unknown, expired or used. */
  consume(token: string): SecretDropGrant | null {
    this.sweep();
    const grant = this.grants.get(token);
    if (!grant) return null;
    this.grants.delete(token);
    return grant;
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [token, grant] of this.grants) {
      if (grant.createdAt <= cutoff) this.grants.delete(token);
    }
  }
}

/** Purposes come from the model: one line, no markup, bounded. */
function cleanPurpose(purpose: string): string {
  return purpose
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Minimal HTML escape for values interpolated into the pages. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `:root { color-scheme: light dark; }
  body { margin: 0; padding: 24px; font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  p.sub { margin: 0 0 1.25rem; opacity: .7; }
  textarea { box-sizing: border-box; width: 100%; min-height: 6rem; padding: 10px;
             font: 14px ui-monospace, monospace; border-radius: 8px; }
  button { margin-top: 12px; width: 100%; padding: 14px; border: 0; border-radius: 10px;
           background: #2f6fed; color: #fff; font-weight: 600; font-size: 1rem; }
  footer { margin-top: 1.5rem; font-size: .8rem; opacity: .6; }`;

/**
 * One self-contained page, no script and no external assets. `no-referrer`
 * keeps the grant out of any Referer and makes the browser send
 * `Origin: null` on the POST; the bridge also accepts its own origin there.
 */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
  ${STYLE}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

/** The paste form for a live grant. */
export function secretDropForm(grant: SecretDropGrant): string {
  const minutes = Math.round(SECRET_GRANT_TTL_MS / 60_000);
  return page(
    "Talon secret drop",
    `  <h1>Store a secret</h1>
  <p class="sub">Saved as <b>${esc(grant.name)}</b> on the Talon host.${
    grant.purpose ? `<br>For: ${esc(grant.purpose)}` : ""
  }</p>
  <form method="post" action="?grant=${esc(grant.token)}" autocomplete="off">
    <textarea name="value" required autofocus spellcheck="false"
      autocapitalize="off" autocorrect="off" aria-label="Secret value"></textarea>
    <button type="submit">Store</button>
  </form>
  <footer>The value goes straight to a file readable only by Talon's user. It is
  not posted to the chat or shown to the model. This link works once and expires
  ${minutes} minutes after it was made.</footer>`,
  );
}

/** What the browser sees after a POST. */
export function secretDropResult(
  ok: boolean,
  name: string | null,
  error?: string,
): string {
  return ok && name
    ? page(
        "Stored",
        `  <h1>Stored ✓</h1>
  <p class="sub">Saved as <b>${esc(name)}</b>. You can close this page.</p>`,
      )
    : page(
        "Not stored",
        `  <h1>Not stored</h1>
  <p class="sub">${esc(error ?? "This link is unknown, expired, or already used.")}</p>
  <footer>Ask for a fresh link with /secret &lt;name&gt;.</footer>`,
      );
}
