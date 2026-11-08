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

## PR C — compact when the cache has gone cold

Policy, evaluated in the Weaver before a turn runs, off by default until
PR A's numbers say the threshold:

```
cold      = now − lastTurnEndedAt > cacheTtl            (default 1h)
big       = session.usage.contextTokens > minContext    (default 40k)
if cold && big: compact the session first, then run the turn
```

Mechanism, in order of preference:
1. SDK compaction on the resumed session (a `/compact` prompt through
   `query()` with `resume`, or the SDK's manual compaction surface — verify
   which the installed version supports; look for `SDKCompactBoundaryMessage`
   with `trigger: 'manual'` in the reply). One model pass over the cold
   transcript — the same tokens the resume would have re-written anyway —
   and every later turn runs on the compacted context.
2. Fallback when the SDK can't: summarize via the backend's one-shot seam
   (`runOneShotAgent`) into ≤ 2 k chars, `performSessionReset`, and seed
   the summary into the **first user turn** of the new session (never the
   system prompt — the invariant in `docs/memory-persona-plan.md` §3.6).

Config (`cache` block): `idleCompactAfterMs`, `idleCompactMinContextTokens`,
`idleCompact: boolean` (default false until measured). Metrics:
`session.idle_compact` counter, `session.idle_compact.saved_tokens`
(pre − post). The heartbeat's "cold big chat" list can show up in
`/status` before the policy is on, so the numbers are visible first.

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
   avoid. So PR C's policy runs on a timer, not on the next message: a
   sweep every few minutes finds chats with `contextTokens > minContext`
   whose `lastTurnEndedAt` is inside `[ttl − margin, ttl)` (default margin
   10 min) and compacts them then. The user's return then re-writes only
   the compacted context. If the user never returns, the compaction cost
   a cache read and ~1–2 k output tokens — small, bounded, and only paid
   for chats that were big enough to matter.
2. **Infer the TTL from data instead of assuming it.** The SDK reports
   `cache_ttl` only in model-switch hook inputs. PR A's
   `cache.first_request.{hit,miss}` next to the idle age at that turn
   gives the empirical TTL (hits at 50 min idle, misses at 70 min ⇒ 1 h).
   `/status` shows both; PR C's timer reads the measured value with 1 h
   as the fallback.

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
  only pays off for a chat that would otherwise cold-start *more* than
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
