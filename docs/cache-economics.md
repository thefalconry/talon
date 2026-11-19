# Cache economics — sharing the prefix across chats, and compacting cold sessions

Status: plan, 2026-09-18. Ada's brief: "keep caching front of mind in
everything; never invalidate cache", "reuse the cached system prompt and
tools from an existing chat when a new session starts", "when caching runs
out, auto-compact so the next message costs less". This document turns
those into three PRs, measurement first.

## What the API actually does

- Prompt caching is a **prefix match**, scoped to the organization and
  model. Render order is `tools → system → messages`; a byte change
  anywhere invalidates everything after it.
- There is no "reuse chat A's cache in chat B" call. Two requests with a
  byte-identical `tools + system` prefix share the cache automatically,
  whichever session sends them, for as long as the TTL lasts. So
  "smarter caching across sessions" means exactly one thing: **make the
  prefix identical across chats and prove it is.**
- The Claude Agent SDK owns `cache_control` placement and the TTL
  (`cache_ttl: '5m' | '1h'` in its hook inputs; Talon's sparse chats want
  `1h`). Talon's levers are prefix bytes, prefix size, and what it sends
  after the boundary. `backend/runtime/cache/cache-telemetry.ts` (#PR 3 of the
  memory rollout) already computes the per-turn verdict; it is not yet
  rolled up anywhere an operator can read.
- After the TTL lapses, the next turn re-writes the whole prefix **and
  the whole transcript** at write cost. A long, idle chat is the
  expensive case: the resume costs the full conversation, and every later
  turn re-reads it (cheaply, but it is still there).
- The SDK can compact a session (`SDKCompactBoundaryMessage`, `trigger:
'manual' | 'auto'`, `pre_tokens`/`post_tokens`; `PreCompact`/`PostCompact`
  hooks; `isAutoCompactEnabled`). Auto-compaction triggers on context
  size, not on cache temperature — the wrong signal for cost.

## PR A — measure (no behaviour change)

**Landed: #954.** The metric names below are live; `/status` carries the
`Cache: <verdict> last turn · idle <duration>` line and `talon metrics`
shows the rollups.

1. Roll the existing per-turn verdict up: counters
   `cache.first_request.{hit,miss,none}` and histograms
   `cache.first_request.read_tokens` / `write_tokens` (the turn's FIRST
   request is the only one that says whether the previous prefix
   survived). Record the same for the first turn of a fresh session under
   `cache.session_start.*` — that is the cross-chat sharing signal: a hit
   on a brand-new session means another chat warmed the prefix.
2. Tool-set fingerprint per chat (already computed by
   `noteToolFingerprint`) surfaced as a metric label / log line at session
   start, so two chats on the same frontend can be compared: identical
   fingerprint + identical `staticText` ⇒ shared cache.
3. Parse `SDKCompactBoundaryMessage` in `claude-sdk/stream.ts`: counter
   `session.compacted.{manual,auto}`, histogram `session.compact.pre_tokens`
   / `post_tokens`. Today it is dropped on the floor.
4. Per-chat `lastTurnEndedAt` in the session record (or the Thread), so
   cache temperature can be inferred locally: warm iff
   `now − lastTurnEndedAt < ttl`.
5. Surface: `/status` (all frontends via `collectSessionStatus`) shows the
   chat's last-turn cache verdict and age; `talon metrics` shows the
   rollups. No prompt bytes change.

## PR B — one prefix per frontend

Audit `assembleSystemPrompt` for anything in `staticText` that differs
between two chats on the same frontend (plugin prompt additions, per-chat
MCP servers → tool array, anything keyed by chat). Rule: **`staticText`
and the tool array are a function of (frontend, config) only.** Anything
per-chat moves after the boundary (`dynamicText`) or into the user turn.
Tests: two chats on one frontend assemble byte-identical `staticText`;
`composeTools` output order is deterministic (sorted, not insertion order);
the MCP server list for a chat is ordered. This is what makes PR A's
`cache.session_start.hit` non-zero.

## PR C — compact a big chat before its cache goes cold

**Implemented** (`feat/idle-compaction`): `core/weaver/idle-compact.ts`
(policy, timers, precompute hand-off), `storage/prompt-cache.ts` (what the
last request said about the cache), `backend/claude-sdk/session/compact.ts`
(the SDK mechanism), `SessionBackend.compactChat` / `discardSession` (the
capability slots). Off by default.

The original plan here was a cold check before each turn (`now −
lastTurnEndedAt > TTL && big` → compact, then run the turn). It was built
and then removed: a cold compaction reads the whole transcript uncached to
write the summary, which costs about what the cold resume it replaces
would, and it puts a long model pass in front of the user's reply. What
pays is compacting while the transcript is still cached — "Where the money
goes" below, point 1 — which is what the Claude CLI itself does.

### As built

Config — a `cache` block in `~/.talon/config.json`, read at boot:

```json
"cache": {
  "idleCompact": true,
  "idleCompactMinContextTokens": 200000,
  "idleCompactMode": "precompute",
  "idleCompactOnTurn": "wait"
}
```

| Key                           | Default               | Meaning                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idleCompact`                 | `false`               | Turn the policy on.                                                                                                                                                                                                                                                                                                                     |
| `idleCompactMinContextTokens` | `200000`              | Only sessions whose context fill (`session.usage.contextTokens`) is at least this are compacted. Floor `100000`: a lower value is raised to it (below it the pass costs more than the cold write it saves). 200 k is the CLI's own default.                                                                                             |
| `idleCompactMode`             | `"precompute"`        | `"precompute"`: compact a fork, switch to it at the next turn only if the cache has expired by then. `"in-place"`: compact the session itself when the timer fires.                                                                                                                                                                     |
| `idleCompactOnTurn`           | `"wait"`              | A user turn arriving after the pass's `/compact` request is sent (input billed). `"wait"`: the turn waits, a precompute is adopted even on a warm cache. `"abort"`: abort it. `"ask"`: two buttons (Telegram), `"wait"` after 30 s. Before the request, a turn always aborts the pass.                                                  |
| `promptCacheTtl`              | unset (CLI automatic) | `"5m"` or `"1h"`: pins the Claude CLI's `promptCacheTtl` setting for chat turns (`CLAUDE_CODE_PROMPT_CACHE_TTL` in the daemon's env still wins). A pass-through: idle compaction arms on the TTL it **observes**, not on this. Unset, the CLI picks 1 h on a subscription within its limits and 5 min on an API key / Bedrock / Vertex. |

What Claude Code does (2.1.319, read from its bundle), and what Talon
copies:

- **Timer** at `lastActivity + 0.9 × (expiry − lastActivity)`, anchored on
  the last cached API request (its send time), not on the end of the turn.
- **Gates:** context ≥ 200 k (floor 100 k); a 1 h TTL observed from the
  response usage (`ephemeral_5m_input_tokens > 0` means 5 min, else
  `ephemeral_1h_input_tokens > 0` means 1 h; inherited when a request wrote
  nothing); the cache still warm and the timer < 60 s
  late; no newer request; same model and prefix; rate-limit status
  `allowed` (all in the timer's gate function, `Srr`). When the REPL's
  conversation host is attached — the in-place path; the precompute path
  has no host — the timer then asks the host's own `refusal()`, which adds:
  the session is held by another process (`held_elsewhere`), the
  transcript moved past the request (`transcript_advanced`), a turn or
  prompt is active (`busy`), and the user interacted in the last 60 s
  (`present`). Talon has no host, so no `present` check; a turn arriving
  mid-pass is handled instead (below).
- **The summary request** forks the exact last request with the cache
  marker at the fork point (a full read, no write), on the chat's model,
  tools denied, one attempt, keeping the last assistant group verbatim.
- **Precompute:** the summary is computed ahead and applied at the next
  turn only if `now ≥` the cache expiry; otherwise it is discarded with
  reason `returned_early`.
- None of it runs under the SDK (entrypoint `sdk-ts`): it is wired into the
  interactive REPL only. Talon's SDK subprocess also exits on `result`, so
  a timer inside it could never fire anyway. Hence Talon's own.

Talon's version:

1. **Observe.** The turn handler records, per chat and in memory
   (`storage/prompt-cache.ts`, surfaced as `SessionInfo.promptCache`), the
   last **main-session** request (sub-agent sidechains are ignored): when
   it was sent (the turn's start, then each main-thread tool result —
   never later than the server's clock), the TTL its cache write carried
   (the CLI's rule: 5 min when any `ephemeral_5m_input_tokens` were
   written, else 1 h when `ephemeral_1h_input_tokens` were; inherited on a
   request that wrote nothing; unknown until a write is seen, and again
   after a write that carried no breakdown), whether it
   touched the cache at all, the model id the turn was built with, whether
   it was a guest turn, and the last `rate_limit_event` status.
2. **Arm** when a turn settles (`Weaver.runTurn`'s `finally`): only on a
   cached request with an observed 1 h TTL, a non-guest prefix and
   context ≥ the threshold; the
   timer fires at `lastRequestAt + 0.9 × TTL` (54 min). A new turn cancels
   it.
3. **Fire.** The pass is queued on the chat's Thread, so it never overlaps
   a turn, and runs only if: no turn ended and no request was sent since
   the arm; the timer is ≤ 60 s late (a suspended host is skipped); `now <
lastRequestAt + TTL`; the context is still ≥ the threshold; the chat's
   next turn would run on the same model; the last rate-limit status (if
   any) is `allowed`. Skips are counted as `session.idle_compact.skipped.<reason>`.
4. **Compact** with the backend's `compactChat`. The Claude backend
   (`session/compact.ts`) resumes the session in streaming-input mode with
   the turn's own options builder (`buildSdkOptions` + the frozen
   `prepareChatSystemPrompt`), on the model the last request used, waits
   for the frontend's MCP server exactly as the turn handler does (the tool
   list is part of the cached prefix), checks `supportedCommands()` for
   `compact` BEFORE sending anything (an older CLI would take `/compact` as
   a user message and answer it), and sends `/compact`. The bundled CLI
   registers it with `supportsNonInteractive: true`; it answers with
   `SDKCompactBoundaryMessage {trigger: 'manual', pre_tokens,
post_tokens}`, or `SDKStatusMessage {compact_result: 'failed'}`. The
   pass's `cache_read` / `cache_write` are recorded; a write over 5 % of
   `pre_tokens` is logged as a cache miss (the prefix did not match). 5-min
   cap.
5. **Precompute (default).** The pass runs with `forkSession: true`: the
   CLI copies the transcript under a new session id and compacts the copy;
   the chat's own session is not written. The fork id waits in memory (and
   in the `kv` row `idle-compact.pending-forks`, so a fork a restart
   orphaned is deleted at the chat's next turn). At
   the next turn, right before the backend runs it, the Weaver switches the
   chat to the fork only once the source session's cache has expired (the
   compacted session is then the cheaper resume). That is one TTL after the
   pass's own `/compact` request, not after `lastRequestAt`: the request
   read the source's cached prefix, and a cache hit refreshes the TTL, so
   the source stays warm until about 1 h 54 min after the last turn's
   request (the pass's send time + TTL; a pass whose usage shows no cache
   read keeps `lastRequestAt + TTL`). It
   discards it — `returned_early` — when the user came back while the
   cache was still warm (a warm full transcript beats a re-written
   summary), and also on a newer request or turn, a model change, or a
   reset session; a discarded fork's transcript is deleted on the backend
   and account that made it (`deleteSession` for the default account; an
   extra account's `<configDir>/projects/*/<id>.jsonl` directly). A fork
   pass that does not end compacted (aborted, failed, timed out) deletes
   its fork itself. A CLI that did not honour the
   fork (same session id back) is recorded as an in-place compaction.
6. **In place** (`idleCompactMode: "in-place"`): the session itself is
   compacted at fire time and the next turn resumes the compacted session.
7. **A turn arriving mid-pass** — the pass has two phases.
   - **Pre-request** (subprocess spawn, the MCP wait, the
     `supportedCommands` check — before `/compact` is sent; the backend
     reports the end of it with `onRequestSent`): the turn always aborts
     the pass (the subprocess is killed) and runs at once; nothing is
     billed yet. A turn queued while the pass is still resolving its model
     id stops it before it starts.
   - **In flight** (the request is sent, so its input is already billed):
     `idleCompactOnTurn` decides.
     - `"wait"` (default): the pass is not aborted. The turn, queued
       behind it on the chat's Thread, waits until it finishes, and the
       chat gets one status message ("Compacting this chat, I'll reply in
       a moment…"). A precompute that finishes is marked `adoptEvenIfWarm`
       and that turn switches to it even though the cache has not expired
       — no `returned_early`; the session-changed, model-changed and
       newer-request/newer-turn checks still apply. An in-place pass just
       completes.
     - `"abort"`: abort it — a precompute always; an in-place pass until
       its `compact_boundary` has arrived, after which it finishes and the
       turn waits for it (seconds: the closing `result`, capped at 10 s).
     - `"ask"`: the chat gets "This chat is being compacted (~1–2 min).
       Wait for it or stop it?" with [Wait] / [Stop] inline buttons (core
       `engine/inline-choice.ts`, sent through the frontend's
       `send_message_with_buttons` action; the click is routed by the
       `ichoice:` callback prefix, today on Telegram only). [Stop]
       aborts as `"abort"` does; no click in 30 s, or a frontend without
       buttons, applies `"wait"`. The message is then edited to the
       outcome (and its buttons dropped).

   Only a user's message gets the status message or the question. A
   background turn (trigger wake, sub-agent report, pulse, device job)
   arriving mid-pass waits silently under `"wait"` and `"ask"` (counted as
   `session.idle_compact.turn_background_wait`); `"abort"` aborts as for
   any turn.

   The 5-minute cap on a pass stays; a pass that fails or times out leaves
   the waiting turn on the unchanged session. The CLI only rewrites a
   session once the summary is in, so an aborted pass leaves it untouched.

Failure never costs the reply: a failed, aborted or throwing pass leaves
the session as it was. Timers, running passes, precomputes and the
prompt-cache observation are in-memory: a restart drops them and nothing is
armed until the chat's next turn re-observes the cache. Only a precomputed
fork's id is persisted, for the cleanup above.

Differences from the CLI, and why: the anchor is the request's send time
as Talon sees it (turn start or the preceding tool result — slightly
earlier than the CLI's own send stamp, so the timer errs early). A cache
write the CLI reported without the 5m/1h breakdown leaves the TTL unknown,
so nothing is armed on it (the CLI falls back to the TTL it asked for, else
5 min; Talon does not see what was asked for, so it takes the side that
never arms on a guess). A turn arriving before the pass's request is
sent aborts it. After that, the CLI makes the user wait for an in-place
pass (the REPL holds the turn guard) and discards a precompute when the
user returns early — before the cache expired, or before the summary was
ready. Talon's default (`idleCompactOnTurn: "wait"`) waits for either and
adopts the precompute even on a warm cache, on purpose: the summary
request's input is already billed, so aborting or discarding it throws
away tokens that were paid for, and the warm cache it would keep is
about to be left anyway. `"abort"` is the CLI-like choice. Talon does not shape
the summary request — `/compact` is the CLI's own. In the bundled 2.1.289
its compaction requests already fork the conversation with tools denied
and `skipCacheWrite` (marker at the fork point), as the idle path does;
what Talon cannot set is the single API attempt, and whether a fresh
subprocess's request is byte-identical to the turn's is measured, not
assumed — the cache-write histogram and the miss warning are the check. The
"user active in the last 60 s" gate is the Thread: any turn queued since
the arm cancels the timer, settles a running pass (above), and fails the
newer-turn/newer-request checks. The prefix check is the guest flag (a
guest turn's tool list differs) plus the same-model gate and the shared
options builder.

Who triggers it: every turn that runs in the chat's own session goes
through `Weaver.runTurn` — user messages, pulse, cron `message` jobs,
trigger and sub-agent wake-ups — so each arms, cancels and hands off the
same way. Heartbeat, dream and cron `query` jobs run isolated one-shot
sessions with their own prefixes; they never compact the chat and are
never compacted.

Metrics: `session.idle_compact` (compactions that took effect: in place,
or a precompute applied), `.in_place`, `.precomputed`, `.applied`,
`.discarded` and `.discarded.<reason>`, `.aborted`, `.failed`,
`.turn_wait` / `.turn_ask` (an in-flight pass a turn waited for or asked
about), `.turn_ask_abort` (a [Stop] click), `.turn_background_wait` (a
background turn that waited silently), `.skipped.<reason>` (`.skipped.backend`
when the backend found nothing to resume), `.unsupported` (the backend has
no compaction: the Weaver stops arming it for that backend until a
restart); histograms `session.idle_compact.saved_tokens`
(pre − post), `.duration_ms`, and the pass's own `.cache_read_tokens` /
`.cache_write_tokens` — a warm pass should be nearly all read. A
compaction that changes the chat's session also bumps PR A's
`session.compacted.manual` and `session.compact.{pre,post}_tokens`: an
in-place pass when it lands, a precomputed fork only when a turn adopts it
(a discarded fork is not counted). The pass's billed tokens and cost are
added to the session's totals (`recordSessionCompaction`) without counting
as a turn, so `lastTurnEndedAt` still means "last real turn".

Cache TTL. For a sparse chat 1 h wins: a 5-min TTL re-writes the context
at 1.25× after every gap over five minutes, a 1 h TTL pays 2× once and
0.1× per read after — the extra 0.75× on new tokens is repaid by the first
5–60-minute gap. Idle compaction only runs on an observed 1 h TTL; on
5 min it would compact live conversations at every pause, which is also
why the CLI refuses it there.

Versions. CLI 2.1.319 ships "Compacted while idle, before the prompt cache
expired" (`idleCompaction` setting; `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`).
The SDK-bundled CLI Talon ships (2.1.289, `@anthropic-ai/claude-agent-sdk`
0.3.289) already contains it too, flag-gated (`tengu_sunny_locket`) and
interactive-only, beside the REPL hint "new task? /clear to save N tokens"
(`CLAUDE_CODE_IDLE_THRESHOLD_MINUTES`, default 75). Neither version runs
it under the SDK.

Open: whether a forked session's first request reads the source session's
cache. The API cache is keyed on the request bytes, not the session id,
and the fork copies the transcript verbatim (only entry UUIDs, which are
not sent, are remapped), so it should; it has not been measured live. If
`session.idle_compact.cache_write_tokens` shows precompute passes writing
the transcript, set `idleCompactMode: "in-place"`.

## Where the money goes on one turn

Every request the SDK makes for a turn sends `tools → system(static |
dynamic) → history → this user turn`. Prices (Opus 5): cache read is
0.1× input, a 5-minute cache write is 1.25×, a 1-hour write is 2×. So:

| Situation | What is billed |
| --- | --- |
| Warm chat, next turn | prefix + history at 0.1×; only the new user turn and the model's output at full price. Cheap. |
| Same frontend, different chat, warm | `tools + static system` at 0.1× (shared), that chat's own history at full price the first time, then cached. This is the cross-chat reuse Ada asked for — it already happens whenever the bytes match. |
| Cold chat (idle > TTL), next turn | the whole prefix **and the whole transcript** re-written at 2× (1h TTL). A 60 k-token idle chat costs ~120 k-token-equivalents to wake up, before the model says a word. |
| Model switch | a separate cache per model; the first turn after a switch is a cold start. |
| Background agents (heartbeat, dream, cron) | their own system prompts, so their own prefixes — they never warm the chat prefix and the chat never warms theirs. |

Two consequences the plan turns into work:

1. **Compact while the cache is still warm, not after it has gone cold.**
   Compacting reads the transcript once. If that read happens inside the
   TTL it is a 0.1× cache read plus a short summary; if it happens on the
   next message after expiry it is the full 2× re-write we were trying to
   avoid. So PR C's policy runs on a timer, not on the next message: as
   built, a per-chat timer at `lastRequestAt + 0.9 × TTL` for chats with
   `contextTokens ≥ minContext` (see "As built"). The user's return then
   re-writes only
   the compacted context. If the user never returns, the compaction cost
   a cache read and ~1–2 k output tokens — small, bounded, and only paid
   for chats that were big enough to matter.
2. **Infer the TTL from data instead of assuming it.** As built, from
   each response's usage: `cache_creation.ephemeral_1h_input_tokens > 0`
   means the write was 1 h, otherwise 5 min, and a request that wrote
   nothing inherits the last one's (the CLI's own rule). PR A's
   `cache.first_request.{hit,miss}` next to the idle age at that turn
   still gives the empirical check (hits at 50 min idle, misses at 70 min
   ⇒ 1 h).

## Things to verify in PR B, not assume

- The SDK exports `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` and Talon splits its
  prompt on it (`backend/claude-sdk/options.ts`). Confirm from the
  telemetry that a change in `dynamicText` (the daily-note pointer at
  midnight, a skill install) leaves `cache.first_request` a **hit**, not
  a miss. If it misses, the boundary is cosmetic and the dynamic block
  must move into the user turn.
- The tool array: `composeTools` per frontend plus per-chat MCP servers.
  Two chats on one frontend must produce the same fingerprint; if MCP
  servers differ per chat, that is a per-chat prefix and the sharing
  win is gone for those chats — measure how many.
- `/reset` and a Companion "new chat" start a fresh session: same prefix,
  so a hit if any chat on that frontend was active within the TTL. This
  is the concrete case Ada described; PR A's `cache.session_start.hit`
  is the number that proves it.

## Considered and parked

- **Keep-warm pings.** Re-reading the prefix every ~55 min costs 0.1× of
  the prefix per hour (≈ 2 k tokens/h for a 20 k prefix). Cheap, but it
  only pays off for a chat that would otherwise cold-start _more_ than
  once an hour, which a bot with a human on the other end rarely does.
  Decide from PR A's cold-start counts, not up front.
- **Sharing the chat prefix with the heartbeat/dream agents.** They would
  need the chat's tools and system prompt, which is not what they are
  for. Not worth distorting them to warm a cache.
- **Client-side `cache_control`.** The SDK owns it; there is nothing to
  place.

## Non-goals

No client-side `cache_control` (the SDK owns it). No second TTL. No
per-chat system prompts to "personalize" caching — that is the opposite
of sharing. Nothing here changes a prompt byte on the default path.
