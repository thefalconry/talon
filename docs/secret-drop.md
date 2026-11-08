# Secrets: the drop and inbound redaction

## Secret drop

`/secret <name> [purpose]` (admin, DMs only; Telegram, native, Discord, WhatsApp) or the agent
tool `request_secret(name, purpose)` mints a single-use HTTPS link on the
native bridge. The link expires after 15 minutes and serves a one-field paste
form. The value is written to `~/.talon/secrets/<name>` (mode 600, atomic)
and the chat is told `stored ✓ as <name>`. The value never enters a chat,
prompt, log or the database.

## Inbound redaction

Before a user's message is saved (history DB, interaction logs, traces) or
shown to the model, `src/core/secrets/redact.ts` replaces credentials with
`[REDACTED:<kind>]`:

| kind          | what                                                                   |
| ------------- | ---------------------------------------------------------------------- |
| `stored`      | any value (≥ 6 chars) already in `~/.talon/secrets`                    |
| `private-key` | a PEM `-----BEGIN … PRIVATE KEY-----` block                            |
| `api-key`     | `sk-…`, `AKIA…`, `AIza…`, Stripe `sk_live_…`                           |
| `token`       | GitHub, Slack, Telegram bot tokens, JWTs, `api_key=` / `token:` values |
| `password`    | the value after password / passwd / passphrase / passcode / pwd / pw   |
| `pin`         | 4–8 digits after pin / pin code                                        |

It is deliberately conservative. After `:` or `=` any token counts. After a
bare "is" or a space, the value must look like a credential: at least six
characters with a digit or a symbol, or 4–8 digits for a PIN. So
"my password is wrong" and "pin the message" pass through untouched.

The chat is told once per daemon run to use `/secret` instead.

```jsonc
"redaction": {
  "enabled": true,          // default
  "deleteOriginal": "dm"    // "dm" (default) | "always" | "never"
}
```

`deleteOriginal` deletes the platform's copy of the message where the bot is
able to: Telegram (in groups only when the bot is an admin) and Discord.
WhatsApp, Teams and the native app redact but can't delete.
