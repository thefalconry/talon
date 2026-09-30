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
- its own **backend and model**, defaulting to the parent's backend and that
  backend's default model;
- a **mailbox** its parent can put instructions in;
- a hard **timeout**, a **task-table** entry, and a per-run markdown log at
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
output in the logs only. It needs `npm ci` done in the checkout.

The changed set is everything since the merge-base with the base, plus
staged, unstaged and untracked work. A change to `package-lock.json`,
`vitest.config.ts` or the test harness (`src/__tests__/setup/`) runs the whole
unit suite; a change with nothing under `src/` runs no tests. Tests under
`src/__tests__/integration/` are left to CI (some reach live services). A hub module
(e.g. `core/types.ts`) makes `vitest related` pick up most of the suite, so
the lane is slower there — which is exactly when it is worth waiting for.

It is not the whole of CI: functional/integration suites, native builds,
coverage and the Windows/macOS matrix still only run on GitHub.

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
  "defaultTimeoutMs": 900000
}
```

- `maxConcurrent` (default 6, 1–64) — live agents daemon-wide, children
  included. Each is a real backend run, so this is the token-spend lever.
  Claimed synchronously at registration, so concurrent spawns cannot both
  slip past it. A refused spawn's error names `agents.maxConcurrent`.
- `maxDepth` (default 2) — `0` = chats only, `2` = chat → agent → agent.
- `defaultTimeoutMs` (default 15 min) — per-spawn `timeout_s` is clamped to
  [30s, 60min] at the tool boundary.

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
  the brief in its header and the full tool transcript below.

## Restarts

A graceful shutdown — `/restart`, `/update`, `talon restart`, SIGTERM — does
not end running agents, it suspends them. First thing in shutdown,
`suspendAgents` writes each live agent's run spec (brief, parent, backend,
model, effort, remaining time budget, undrained inbox) to the
`suspended_agents` table, stops delivery and new spawns, and aborts the runs.
At boot, `resumeSuspendedAgents` claims those rows (read + delete in one
transaction) and relaunches each agent **under the same id**, parents before
children, so `send_to_agent`, `list_agents` and the parent's wake-up keep
working with no model involvement.

- **A fresh run, not a reattached session.** Backends expose no resumable
  one-shot session, so the brief runs again, prefixed with a note that the
  run was interrupted and must check what it already did — its run log (the
  same `<id>.md`, appended to) and the workspace — before continuing.
- **Time budget.** The resumed run gets what was left of its cap, never
  less than 2 minutes.
- **Bounded.** A row is claimed once per boot, so a crash-looping successor
  never replays it; an agent is resumed at most 3 times; only within an hour
  of the shutdown; and only inside `maxConcurrent`. An agent that can't be
  resumed settles as `killed` with the reason, and its parent is told.
- **Crashes are not covered.** A process that dies without running graceful
  shutdown persists nothing; its agents are gone as before.

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
