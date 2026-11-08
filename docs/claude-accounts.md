# Multiple Claude accounts

The `claude` backend uses the login of the `claude` CLI in one config
directory: `$CLAUDE_CONFIG_DIR` if it is set, otherwise `~/.claude`. That is
the **default account**, and nothing about it changes when you add more.

If you have more than one Claude subscription of your own, add the others
as extra accounts: from `/auth` in Telegram, with `talon accounts add`, or
by listing them under `claudeAccounts` in config.json. Each one becomes a
backend with its own id. It runs the same Claude SDK driver, but every
`claude` process it spawns gets `CLAUDE_CONFIG_DIR=<that account's
configDir>`, so it signs in with that account's credentials and draws on
that account's plan.

## Talon never switches accounts on its own

Which account runs a piece of work is always **your** choice:

- config: `backend`, `heartbeatBackend`, `dreamBackend`, `backendDefaults`;
- a chat switch: **Use in this chat** on `/auth`, `/model` → backend, or
  `/model claude-2` (`/backend` on the native app);
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

1. **Add it**, in any of three ways. The first two apply at once, with no
   restart.
   - **From Telegram:** send `/auth` and tap **➕ Add Claude account**.
     Talon adds the next free `claude-2`, `claude-3`, … and goes straight
     into its sign-in (step 2). To pick the name yourself, send
     `/auth add work`. That adds `claude-work`, labelled `Claude (work)`.
   - **On the host:** run `talon accounts add` (or
     `talon accounts add work`). With Talon running, the daemon adds it
     live. With Talon stopped, the command edits config.json and the
     account appears at the next start.
   - **By hand** in `~/.talon/config.json`, then restart Talon
     (`talon restart`, or restart the service). Talon reads a hand-edited
     file only at startup.

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
     offered in `/model`. If config is invalid (a duplicate id, a shared
     `configDir`, or a backend field naming an undeclared account), Talon
     says so and refuses to start, and `talon doctor` reports the same
     problem.

   `/auth` and `talon accounts` write the same entry for you, with
   `configDir` under `~/.talon/accounts/<id>`, and add the id to
   `enabledBackends` when that list is set. They run the same checks
   first and refuse, saying why, rather than write a config Talon
   wouldn't start with. There can be at most 16 extra accounts.

2. **Sign the account in**, in either of two ways:
   - **From Telegram:** send `/auth`. The panel has a row for the new
     account; tap **Sign in to Claude (account 2)**, open the link, and
     reply with the code the page shows. The credentials go into the
     account's `configDir` and nowhere else.
   - **On the host:** run `talon accounts login claude-2` as the user
     Talon runs as. It runs `claude auth login` with the account's
     `CLAUDE_CONFIG_DIR`, after linking its `projects` (see below), so the
     CLI doesn't create a `projects/` directory of its own there.

   No restart is needed after signing in. The next run reads the new
   credentials.

3. **Check it:** `talon accounts` lists every Claude account with its
   sign-in state. `talon doctor` gives each account three lines: its
   config dir exists, it is signed in, and its sessions are shared with
   the default account.

4. **Use it.** Pin a chat to it (see below), set
   `"heartbeatBackend": "claude-2"`, pass `backend: "claude-2"` to
   `spawn_agent`, and so on.

## One account per chat

Each chat runs on one backend, and each Claude account is a backend of its
own, so different chats can run on different accounts at the same time:
one chat on `claude`, another on `claude-2`.

To pin the chat you're in, send `/auth` and tap **💬 Use in this chat**
under the account's row; the row the chat uses now says *this chat*. Or
use `/model` → backend, which does exactly the same switch. A chat keeps
its account until you switch it again. Picking the account the chat would
use anyway drops the pin instead.

A chat's account is the only one its work runs on. The router still never
moves work between Claude accounts: if the pinned account runs out of
headroom, its chat doesn't spill onto another one. Switch the chat
yourself if you want it to carry on elsewhere.

## Sessions carry across accounts

The CLI keeps session transcripts in `<config dir>/projects`, and Talon
stores one session id per chat. So that a chat switched from `claude` to
`claude-2` (or back) keeps its conversation, each extra account's
`projects` is a **symlink to the default account's** `projects`. The
link is made when the account is added, when its backend starts, and
after a sign-in. Everything else in the account's directory, above all
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

From Telegram, send `/auth` and tap **🗑 Remove** under the account's row.
On the host, run `talon accounts remove claude-2`. Either way it applies
at once, with no restart:

- Every chat pinned to the account goes back to the default backend.
  When that is the default Claude account, the chats keep their sessions,
  since the transcripts are shared. The `/auth` confirmation tells you
  how many chats move before you tap **Remove**.
- The entry leaves `claudeAccounts` (and `enabledBackends`) in
  config.json, and the backend leaves `/model`, `/auth` and `/usage`.
- If Talon made the account's directory (it is under
  `~/.talon/accounts/`), the directory is deleted, sign-in included. Pass
  `--keep-credentials` to keep it. A directory you chose yourself is
  always left where it is, and Talon tells you the path.
  Its `projects` link points at the shared store. Deleting the directory
  removes the link, not the transcripts behind it.

Talon refuses to remove the default `claude` account, and any account that
`backend`, `heartbeatBackend` or `dreamBackend` still names. Point that
field at another backend first.

With Talon stopped, `talon accounts remove` only edits config.json. At the
next start, chats pinned to the account move to the default backend with
a fresh session, as they do for any backend that has gone; remove it while
Talon runs to keep their sessions. To remove an account by hand,
delete its entry from `claudeAccounts`, along with any references to its
id in `backend`, `heartbeatBackend`, `dreamBackend` or `enabledBackends`,
then restart.
