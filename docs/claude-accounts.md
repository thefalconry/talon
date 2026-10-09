# Multiple Claude accounts

The `claude` backend uses the login of the `claude` CLI in one config
directory: `$CLAUDE_CONFIG_DIR` if it is set, otherwise `~/.claude`. That is
the **default account**, and nothing about it changes when you add more.

If you have more than one Claude subscription of your own, list the others
under `claudeAccounts`. Each one becomes a backend with its own id. It runs
the same Claude SDK driver, but every `claude` process it spawns gets
`CLAUDE_CONFIG_DIR=<that account's configDir>`, so it signs in with that
account's credentials and draws on that account's plan.

## Talon never switches accounts on its own

Which account runs a piece of work is always **your** choice:

- config: `backend`, `heartbeatBackend`, `dreamBackend`, `backendDefaults`;
- a chat switch: `/model` → backend, or `/model claude-2` (`/backend` on
  the native app);
- a tool argument: `spawn_agent`'s `backend`, a cron job's `provider`.

The plan-aware router ([backends.md](backends.md#plan-aware-routing))
never moves work from one Claude account to another, and never picks
between them. When `claude` runs out of headroom, unpinned background work
can still move to a *different provider* (Codex, say), but not to
`claude-2`. A spent `claude-2` doesn't fall back to `claude` either.

This rule is enforced in the code. Every Claude backend is in one
**account group** (`accountGroup: "claude"` on its factory), and the
router excludes the caller's own group from the alternates it considers.
Every extra account is also **explicit-only** (`explicitOnly: true`), so
work defaulting to another provider can't land on it either. The test
`src/__tests__/backend-router-accounts.test.ts` fails if the router ever
sends work defaulting to a spent `claude` to an idle `claude-2`.

Spreading load across your subscriptions automatically, so that you get
round a rate limit, is not a feature and won't become one. If you want
some work on the second account, say so in config or pick it per chat.

## Adding a second account

1. **Declare it** in `~/.talon/config.json`:

   ```json
   {
     "claudeAccounts": [
       {
         "id": "claude-2",
         "label": "Claude (account 2)",
         "configDir": "~/.talon/accounts/claude-2"
       }
     ]
   }
   ```

   - `id` must look like `claude-<name>`: lowercase letters, digits and
     hyphens, for example `claude-2` or `claude-work`. It is the backend
     id you use everywhere else.
   - `configDir` is the account's own Claude config directory. Give an
     absolute path or a `~/` one, and use a different directory for each
     account. It can't be the default account's directory. It doesn't
     need to exist yet.
   - `label` is optional (default `Claude (<id>)`). It is the name shown
     in `/model`, `/usage`, `/auth` and `/status`.

   If `enabledBackends` is set, add the id there too, or it won't be
   offered in `/model`.

2. **Restart Talon** (`talon restart`, or restart the service).
   Accounts are registered at startup, so adding, removing or editing one
   only takes effect after a restart. If config is invalid (a duplicate
   id, a shared `configDir`, or a backend field naming an undeclared
   account), Talon says so and refuses to start, and `talon doctor`
   reports the same problem.

3. **Sign the account in**, in either of two ways:
   - **From Telegram:** send `/auth`. The panel has a row for the new
     account; tap **Sign in to Claude (account 2)**, open the link, and
     reply with the code the page shows. The credentials go into the
     account's `configDir` and nowhere else.
   - **On the host:** run
     `CLAUDE_CONFIG_DIR=~/.talon/accounts/claude-2 claude auth login`
     as the user Talon runs as. Use `claude auth login` rather than an
     interactive `claude` session, so that the CLI doesn't create its own
     `projects/` directory there (see below).

   No restart is needed after signing in. The next run reads the new
   credentials.

4. **Check it:** run `talon doctor`. Each account gets three lines: its
   config dir exists, it is signed in, and its sessions are shared with
   the default account.

5. **Use it.** Switch a chat with `/model` → *Claude (account 2)*, set
   `"heartbeatBackend": "claude-2"`, pass `backend: "claude-2"` to
   `spawn_agent`, and so on.

## Sessions carry across accounts

The CLI keeps session transcripts in `<config dir>/projects`, and Talon
stores one session id per chat. So that a chat switched from `claude` to
`claude-2` (or back) keeps its conversation, each extra account's
`projects` is a **symlink to the default account's** `projects`. The
link is made when the account's backend starts, and after an `/auth`
sign-in. Everything else in the account's directory, above all
`.credentials.json`, belongs to that account alone.

If `projects` already exists there as a real directory (the account was
used directly, outside Talon), Talon **leaves it alone**. It logs a
warning and `talon doctor` flags it. Chats switched onto that account
then start fresh sessions. To share them, move the directory's contents
into the default account's `projects` and delete the empty directory.
Talon creates the link at the next start.

A switch between two Claude accounts says "Session kept". A switch to any
other backend still starts a fresh session, as before.

## Login status, expiry and usage

- `/auth` and the login-expiry alerts list each account separately, from
  its own credentials file. Each account has its own expiry warning and
  its own "expired" mark.
- `/usage`, `/status` and the `plan_usage` and `list_backends` tools
  report each account's rate-limit windows separately, each read with
  that account's token. Plan alerts (`planAlerts`) watch each running
  account and name it in the warning.
- `ANTHROPIC_API_KEY` overrides every account. With it set, the CLI bills
  the key rather than any subscription, so plan windows aren't shown.

## Backups

The sessions part of a backup captures the shared transcripts once, from
the default account's `projects`. Because the accounts' `projects` are
links to that same directory, nothing is captured twice. Backups never
include any Claude account's sign-in, the default account's included.
In a container, the boot storage check lists each account's directory,
so a sign-in on a non-persistent path is flagged.

## Removing an account

Delete its entry from `claudeAccounts`, along with any references to its
id in `backend`, `heartbeatBackend`, `dreamBackend` or `enabledBackends`,
then restart. Chats that were pinned to it go back to the default backend.
Its directory stays on disk. Its `projects` link points at the shared
store, so deleting the directory doesn't touch any transcripts.
