# Sub-agents

> Status: **implemented** (`src/core/agents/`). Talon's own delegation
> mechanism: any chat turn, on any backend, can spawn an isolated agent with
> its own backend and model, talk to it while it runs, and be woken with its
> report.

This is deliberately **not** the Claude SDK's sub-agent feature. Talon owns
the mechanism so it works identically on `claude`, `codex`, `kilo`,
`opencode` — anything with a `background` capability — and so a chat on one
backend can delegate to an agent on another.

## The model

A **sub-agent** is one isolated one-shot run (`runOneShotAgent`) that some
other agent work started. It has:

- an **id** (`agt_<8 hex>`) and a content-free **label**;
- a **brief** — the entire context it gets, because it has no conversation
  history and no shared scratchpad;
- a **parent**, which is either a chat or another sub-agent;
- its own **backend and model**. Unpinned, a child of another agent
  inherits its parent's backend _and_ model, so a tree stays where its root
  was put; a top-level spawn starts from the chat's backend (the router may
  move it to one with more headroom) and that backend's default model. An
  optional `agents.allowedBackends` allowlist bounds both;
- a **mailbox** its parent can put instructions in;
- an optional hard **timeout** (none by default), a **no-progress
  watchdog**, a **task-table** entry, and a per-run markdown log at
  `~/.talon/workspace/logs/agents/<id>.md`.

Spawning returns immediately with the id. The parent keeps working; the
report arrives later, through the wake turn (chat parent) or the mailbox
(agent parent). That is the shape Claude Code's background agents have, and
the reason it is worth having: delegation that does not block the delegator
and does not flood its context.

Three modules, one concern each:

| Module        | Owns                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `registry.ts` | identity, the lifecycle state machine, mailboxes, parent/child edges |
| `runner.ts`   | backend/model resolution, the isolated run, settlement, kills        |
| `delivery.ts` | getting text between an agent and its parent, in both directions     |

`context.ts` is a dependency-free leaf holding the `agent:<id>` vocabulary —
imported directly by `backend/claude-sdk` and the gateway, because routing
that knowledge through `index.ts` would drag the runner (and the backend
pool) into their import graphs.

## Lifecycle

```
queued → running → done | failed | killed | timed_out
```

`queued` lasts only as long as it takes to acquire the backend and resolve
the model; a spawn that fails there is discarded without trace (nothing ran,
so there is nothing to report on) and the tool returns the reason.

**Result precedence**, applied at settlement:

1. `report_result` — the agent's own summary/details. This is the channel.
2. the run's **last assistant text**, captured through
   `OneShotAgentParams.onAssistantText`, when the agent finished without
   reporting.
3. neither → the run settles `failed`. A sub-agent that says nothing has not
   done its job, and a parent is always told so.

A result reported before a kill or a timeout is kept: the parent gets the
partial answer plus the terminal state. **Every** terminal state is
delivered — silence is never an outcome.

**Work survives a cut-short run.** While an agent runs, Talon keeps a small
trail of it (`core/agents/trail.ts`): its last three `message_parent` notes,
its last three assistant texts, and the files it wrote or edited (scraped
from the run log — Claude-style `Write`/`Edit` tool calls and Codex file
changes; best-effort). When a run ends `killed`, `timed_out` or `failed`,
the parent's wake-up carries that trail under the error, so it can pick up
from where the agent stopped instead of starting over.

### Timeouts and the watchdog

There is **no hard timeout by default**: a run ends when it reports, is
killed, or stalls. A spawn may still pass `timeout_s` (floored at 30s), a
deployment may set `agents.defaultTimeoutMs` for spawns that pass none, and
`agents.maxTimeoutMs` caps every run when set.

What ends a run that has gone quiet is the **no-progress watchdog**
(`core/agents/watchdog.ts`). Any run-log line (a tool call, a tool result)
or assistant text is a sign of life. With `agents.stallTimeoutMs = N`
(default 15 min):

1. after **N** of silence the agent gets a `[Watchdog]` note in its mailbox;
2. after **2N** its parent gets an interim note (it can `send_to_agent` or
   `kill_agent`);
3. after **3N** the run is aborted and settles `timed_out` with
   `stalled: …` as its error, plus its trail.

Any activity starts the ladder over. `stallTimeoutMs: 0` disables it.

When an agent settles, its own still-running children are killed. Their
reports would have nowhere to go, so leaving them running only spends tokens.

## Communication

| Direction             | Tool             | Mechanism                                           |
| --------------------- | ---------------- | --------------------------------------------------- |
| agent → parent        | `report_result`  | settles the run; delivered on settlement            |
| agent → parent        | `message_parent` | interim note, delivered immediately, run continues  |
| parent → agent        | `send_to_agent`  | bounded FIFO mailbox (32), drained by `check_inbox` |
| agent → its own inbox | `check_inbox`    | drains everything waiting, exactly once             |

A **chat parent** is woken with a synthetic turn —
`execute({ source: "agent", senderName: "Agent", prompt: "[System: AGENT
FINISHED …]" })` — exactly as a trigger fires one. The turn resumes the
chat's own session, so the model reads the report with full conversational
context and decides for itself whether the user hears about it.

An **agent parent** gets a mailbox push. If it has already settled, the
message is logged and dropped: reviving a finished run to hear late news is
worse than losing the news. A mailbox push past the cap is _refused_, not
silently dropped, so `send_to_agent` can tell the parent it did not land.

`wait_for_agent` exists for the case where the very next thing the parent
does depends on the answer. It is bounded (≤120s, with a 180s bridge budget
above it) so an MCP tool-call timeout can never trip, and it is **not** the
completion channel — the wake turn is, and it fires whether or not anyone
is waiting.

## Tools

Parent-side (available in every chat, and inside an `agent:*` run):

- `spawn_agent({ brief, label, backend?, model?, effort?, timeout_s?, preflight? })` →
  `{ agent_id, backend, model }` — `preflight` see [Pre-flight lane](#pre-flight-lane)
- `list_agents()` — this chat's agents, descendants included
- `agent_status({ agent_id })` — everything but the brief
- `wait_for_agent({ agent_id, timeout_s ≤ 120 })`
- `send_to_agent({ agent_id, text })`
- `kill_agent({ agent_id })`

Agent-side (refused anywhere but an `agent:*` context):

- `report_result({ summary, details? })` — exactly once per run
- `message_parent({ text })`
- `check_inbox()`

Visibility is scoped the way triggers are scoped to their chat: a chat sees
the agents rooted in it, an agent sees its own descendants, and an id from
another chat is simply "not found".

## Pre-flight lane

Agents that open PRs run the light CI suite locally and push only when it is
green, so GitHub Actions becomes the confirmer of a change rather than the
first compiler it meets.

**The lane** is `scripts/preflight.sh` (`npm run preflight`). It mirrors the
`lint` job in `ci.yml` plus the unit tests touched by the diff:

| step            | what                                                      |
| --------------- | --------------------------------------------------------- |
| `typecheck`     | `tsc --noEmit`                                            |
| `lint`          | oxlint                                                    |
| `format`        | `prettier --check`                                        |
| `depcruise`     | architecture boundaries                                   |
| `knip`          | dead code                                                 |
| `ratchets`      | ratchet gates                                             |
| `function-size` | function-size ratchet                                     |
| `tree`          | tree ratchet                                              |
| `only-skip`     | no `.only()` / `.skip()` left in tests                    |
| `tests`         | `vitest related <changed src>` — tests importing the diff |
| `gitleaks`      | secrets in `<base>..HEAD`; skipped with a note if absent  |

Every step runs even after one fails, so one pass shows everything red. It
prints one verdict line (`preflight: GREEN in 94s …` / `RED — failed: knip,
tests`) and writes `.preflight/last.json` (verdict, per-step status and
duration, failing steps) plus one `.preflight/<step>.log` per step; exit 0 is
green, 1 is red. `PREFLIGHT_BASE` (default `origin/main`) is the diff base,
`PREFLIGHT_SKIP=knip,tests` skips steps, `PREFLIGHT_QUIET=1` keeps step
output in the logs only. It needs a `node_modules` in the checkout — make
the worktree with `scripts/worktree.mjs` (below) rather than `npm ci`.

The changed set is everything since the merge-base with the base, plus
staged, unstaged and untracked work. A change to `package-lock.json`,
`vitest.config.ts` or the test harness (`src/__tests__/setup/`) runs the whole
unit suite; a change with nothing under `src/` runs no tests. Tests under
`src/__tests__/integration/` are left to CI (some reach live services). A hub module
(e.g. `core/types.ts`) makes `vitest related` pick up most of the suite, so
the lane is slower there — which is exactly when it is worth waiting for.

It is not the whole of CI: functional/integration suites, native builds,
coverage and the Windows/macOS matrix still only run on GitHub.

### Worktrees with shared node_modules

A plain `git worktree add` + `npm ci` costs ~1.2 GB per checkout (about
500 MB of it the bundled claude and codex binaries); four agents doing that
at once once filled the host disk. `scripts/worktree.mjs` (`npm run
worktree --`) gives each worktree a `node_modules` made of hardlinks into one
shared store per lockfile:

```sh
node scripts/worktree.mjs add /tmp/fix-foo fix/foo   # new branch off origin/main
node scripts/worktree.mjs add /tmp/fix-foo fix/foo --base origin/release
node scripts/worktree.mjs link [dir] [--force]       # existing checkout
node scripts/worktree.mjs remove /tmp/fix-foo        # remove + prune the store
node scripts/worktree.mjs prune [--max-age-days 3] [--dry-run]
```

The store lives at `~/.cache/talon-node-modules/<hash>/node_modules`
(`TALON_NM_STORE` overrides), keyed by the sha256 of `package-lock.json` plus
platform, arch and Node major. The first worktree for a lockfile builds the
entry once: a real copy (reflink when the filesystem supports it) of any
worktree of the repo whose lockfile hashes the same, else `npm ci` into the
store. Every later worktree is `cp -al` of it — about 15 MB of directory
entries and seconds instead of 1.2 GB and a minute. `prune` drops entries no
worktree uses that have not been linked for `--max-age-days`.

Safety: a hardlink shares the inode, so an in-place write through one link
would change every worktree.

- Store files are `chmod a-w`, so an in-place write fails with `EACCES`
  instead of corrupting other worktrees. Unlink, rename and
  `rm -rf node_modules` still work, because each worktree's directories are
  its own.
- Mutable state is never shared. `node_modules/.cache`, `.vite`,
  `.vite-temp` and `.vitest` (vitest, vite, prettier and babel caches) are left
  out of the store and get created fresh per worktree. npm's hidden lockfile
  `node_modules/.package-lock.json` is copied, not linked.
- The store never shares inodes with the prod checkout: it is seeded by a
  copy, so a worktree cannot reach the running daemon's dependencies.
- The pre-flight lane itself writes nothing into existing `node_modules`
  files: tsc runs `--noEmit`, there is no prettier or knip cache, and vitest's
  results cache goes to a fresh `node_modules/.vite`. The package has no
  `postinstall`/`prepare` script and no workspaces or `file:` links.
- Changing dependencies in a worktree: run `npm ci` (or `npm install <pkg>`).
  npm removes and re-extracts packages instead of writing into them, so the
  store is untouched. The worktree then has a private `node_modules`.
- Root ignores file modes, so do not run agents' builds as root against a
  store.

**Wiring into sub-agents.** `spawn_agent` takes `preflight?: boolean`. Unset,
it defaults on for any brief that mentions a PR (`PR`, `PRs`, "pull
request") and off otherwise. When on, the activation prompt ends with a
standing instruction: before every `git push`, run `npm run preflight` (or
call `run_preflight`), push only when green, and if a red step is genuinely
out of scope say which one and why in the PR body.

**`run_preflight({ cwd? })`** runs the lane in the checkout that contains
`cwd` (its git root; default the workspace) on the daemon host, capped at
10 minutes, and returns the verdict, the step table and the last 30 lines of
every failing step's log. A red lane is a successful tool call with a red
verdict; the tool errors only when it could not run (no such directory, no
`scripts/preflight.sh` in that checkout, the lane died without a summary, or
it timed out). It is callable from a chat and from inside an agent run.

## Tool surface inside an agent

A sub-agent's run carries `contextLabel: "agent:<id>"`. That one string does
three jobs:

1. each backend's one-shot treats it as a **background tool context**
   (`isBackgroundToolContext`, shared with `heartbeat`) and wires the full
   surface — every frontend's tools with an explicit `chat_id`, plus every
   loaded plugin, plus the agent tools;
2. the **MCP hub** binds a per-agent tool session at
   `/mcp/talon/<frontend>/agent:<id>`;
3. the **bridge** sends it back to the gateway as `_chatId`, so
   `Gateway.dispatchWithoutChat` recognises the caller as that agent and
   routes its agent-family actions with the key as the chatKey. That is how
   `report_result` knows who reported, without the model ever naming itself.

Sub-agents are told not to message the user's chat directly unless their
brief says to: their report goes to whoever spawned them, and that is where
the decision to talk to a human is made.

## Caps and config

```json
"agents": {
  "maxConcurrent": 6,
  "maxDepth": 2,
  "stallTimeoutMs": 900000,
  "maxTimeoutMs": 7200000,
  "allowedBackends": ["claude", "codex"]
}
```

- `maxConcurrent` (default 6, 1–64) — live agents daemon-wide, children
  included. Each is a real backend run, so this is the token-spend lever.
  Claimed synchronously at registration, so concurrent spawns cannot both
  slip past it. A refused spawn's error names `agents.maxConcurrent`.
- `maxDepth` (default 2) — `0` = chats only, `2` = chat → agent → agent.
- `defaultTimeoutMs` (optional, unset = none) — hard timeout for a spawn
  that passes no `timeout_s`. Per-spawn values are floored at 30s.
- `maxTimeoutMs` (optional, unset = none) — global ceiling on every run's
  hard timeout, including spawns that set none.
- `stallTimeoutMs` (default 15 min, 0 = off) — the watchdog step: ping at
  N, warn the parent at 2N, kill at 3N.
- `allowedBackends` (optional, unset = any) — backend ids a sub-agent may
  run on. `spawn_agent` refuses a backend outside it, whether named or
  inherited, with an error naming the list; a routed choice outside it
  falls back to the inherited backend instead of failing.

There is no on/off switch: a deployment that wants no fan-out sets
`maxConcurrent: 1, maxDepth: 0`.

## Surfaces

- **HTTP (gateway, 127.0.0.1)** — `GET /agents` returns
  `{ ok, agents: [...] }`, the registry minus every brief. Same content-free
  contract as `/tasks`.
- **`talon ps`** — every run is a task of kind `agent`, killable, labelled
  with the agent's label.
- **`talon events`** — `agent.spawned`, `agent.settled`, `agent.message`
  (ids, states, counts; never text). The journal persists them, so
  `talon events --history` answers across restarts.
- **Run logs** — `~/.talon/workspace/logs/agents/<id>.md`, one per run, with
  the brief in its header and the full tool transcript below. A resumed
  run appends to the same log under a `resumed after daemon restart` rule.

## Surviving a daemon restart

A restart does not kill a sub-agent. Every spawn is mirrored to the
`agents` table in `talon.db` (brief, parent, backend, model, effort,
timeout, cwd, backend session id, undrained inbox, report, state) and kept
current on every lifecycle change.

- **Shutdown parks, it does not kill.** The first step of a graceful
  shutdown — before the frontends and the backend pool go down — stamps
  every live agent as interrupted (charging its elapsed time against its
  timeout). The abort that follows leaves the row `running` and does not
  wake the parent. A crash leaves the row `running` too.
- **Boot resumes.** Once the frontends are listening,
  `resumeAgentsAfterRestart` walks every `queued`/`running` row, parents
  before children, and brings each back under its original id (so its
  tool session, run log and parent edges are unchanged):
  - on a backend that can resume a conversation (Claude SDK session id,
    Codex thread id — `BackgroundRunner.supportsResume`) with a recorded
    session, the run continues that conversation with a short note: it was
    interrupted at _time_, check the state of anything that was
    mid-flight, drain `check_inbox`, report once;
  - otherwise it starts a fresh conversation with the original brief plus
    the tail of its previous run log, told to continue rather than redo.
- **Bounds.** A run with a hard timeout gets what it had left (at least 10
  minutes); an uncapped run stays uncapped. An agent whose report had already landed is settled and
  delivered without rerunning. An agent interrupted more than
  `MAX_AGENT_RESUMES` (3) times, or down for more than 24 hours, or whose
  backend is gone, settles as `failed` and its parent is told why.
  Settled rows are pruned after 7 days.

## Deliberately not done

- **No batching or coalescing of wake-ups.** Several settlements arriving
  while a chat is busy become several queued turns, and the weaver
  serialises per chat. Triggers already behave this way and the model
  handles it.
- **No interrupt channel.** `send_to_agent` queues; it does not preempt.
  An agent that never calls `check_inbox` never sees its messages, which is
  why its system prompt tells it to check at milestones.
- **No cross-chat visibility.** An agent belongs to the chat its ancestry
  roots in, full stop.
