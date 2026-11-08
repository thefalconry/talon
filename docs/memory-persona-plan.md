# Memory & Persona — architecture plan

Status: proposal. Supersedes the Phase-A/Phase-B memory notes and settles the
question of what happens to the Soul Kernel.

---

## 1. What is actually broken

Not speculation — this is the live deployment's `~/.talon/workspace/memory/memory.md`
(23,633 chars, 113 lines) read against `assemble.ts`.

**1.1 The model never sees the useful half.** `MEMORY_INJECT_MAX_CHARS = 12_000`
slices the *head* of the file. On the live file that cut lands at **line 46 of 113**.
Above the line: one user-facts block, one infra-health block, and three
near-duplicate `## Inbox / CI Watch (as of …, Run #N)` snapshots. Below the line,
invisible: `## Active Investigations` (including a root-cause analysis), `##
Revisions`, `## Branches to clean up`. Truncation is positional; content is not
priority-ordered. So the *least* durable content systematically evicts the most
durable.

**1.2 Ephemeral state is stored in the durable layer.** Those three CI-watch
sections are hourly status snapshots with a shelf life of ~60 minutes, ~4 KB each,
describing the same recurring failures. They are a feed, not a memory. Nothing in
the system distinguishes "true forever" from "true right now."

**1.3 Reconciliation is annotation, not supersession.** One real bullet, abridged:

> v1.29.4 FAILED 07-03 … **RESOLVED 07-08 (Run #235)** … **CONFIRMED reliable
> 07-08 10:27Z (Run #236)** …

Three layers of amendment on a single line, ~700 chars, describing a *closed*
issue. Facts get annotated because there is no unit of memory that can be
*replaced*: no id, no timestamp, no source, no confidence — just prose in a file.
An LLM asked to "merge" 23 KB of prose will always append and annotate; deleting
is the risky move from its position. The dream prompt even mandates it: *"Do NOT
remove entries just because they're old."* Combined with append-only growth, that
guarantees monotonic bloat.

**1.4 Three uncoordinated writers, one file, no protocol.** The live chat agent
(`Write`, mid-conversation), the dream agent (12 h), and the heartbeat agent
(hourly) all read-modify-write the same file with different instructions and no
schema, lock, or ownership. Last writer wins, silently.

**1.5 Daily notes are write-only.** 323 KB across 16 files (~20 KB/day), surfaced
only as *"Use the Read tool to check recent daily notes when you need context"* —
with no index, so in practice never read. They are also the **only** surviving
record of 07-04 → 07-10 (raw logs rotated). Write-only memory is worse than none:
it costs tokens and creates the illusion of continuity.

**1.6 Retrieval never landed.** `core/memory/retrieval.ts` is a clean, trust-aware,
fail-closed seam wired end-to-end into the Weaver and both backends — populated
with `noopMemoryRetriever`. The doc it cites
(`docs/memory-phase-b-pre-retrieval.md`) no longer exists. MemPalace and mem0 are
real but *model-invoked*: their prompts open with "BEFORE RESPONDING … call search
FIRST, every session," which is the least reliable mechanism available and costs a
round trip per turn. Net effect: the model's entire memory is the truncated head of
one markdown file.

**1.7 Persona is an adjective list.** `prompts/identity.md` opens with "Sharp,
witty, and warm." That describes ten thousand assistants. It never changes, never
differs per person, and — decisively — is not connected to memory. The evolving
file that *could* personalize (`workspace/identity.md`) is six lines of work-project facts
with no voice at all. Meanwhile voice is duplicated and drifting across
`telegram.md` / `discord.md` / `teams.md` / `terminal.md` / `native.md`.

---

## 2. Verdict on the Soul Kernel: repurpose ~10%, delete the rest

**Landed as #953** — the kernel is gone and the taps write to the store.

**The ideas are right. The implementation is ~30× oversized for the signal it is
fed.** That is the whole judgement, and it is measurable.

What it is: 4,797 lines across 31 modules, 30 test files — content-addressed Merkle
DAG, Hebbian value lattice, salience with a predictive-coding delta rule, FSRS/DSR
forgetting, ADWIN drift detection, PageRank centrality, modern-Hopfield associative
recall, VSA/HDC compositional episodic memory, per-interlocutor lens compilation,
frozen critic classifiers, a governance approval queue.

What it is fed: **three taps, Telegram only.** Emoji reactions on bot messages;
eight regexes for "directive" (`/\bfrom now on\b/`…); eight for "correction"
(`/^\s*(no|nope|nah)\b/`…). That is the entire input stream.

So: Hebbian co-activation needs many co-activations to mean anything — it gets one
event per emoji. ADWIN needs a stream — it gets maybe a directive a week. PageRank
over ~15 nodes is noise. And the *best case* output of the whole pipeline is

```
- [conf +0.42] "verbatim quote"
```

— a few things Ada once said, ranked by an arithmetic score, formatted as a
debug dump. `SELECT text FROM directives ORDER BY recency * weight LIMIT 8` gets
you 95% of that in one line.

It is also **off by default** (`TALON_SOUL_ENABLED`), and its two best entry points
are unreachable: `SoulService.renderPromptSection()` calls bare `kernel.project()`,
so `projectFor(embedder, {context, lens})` — relevance conditioning and
per-interlocutor refraction, the genuinely valuable parts — never runs in
production. This is precisely the failure mode already recorded as a project rule:
*native bricks need runtime consumers in the same PR, not just tests.* The soul is
the canonical violation of it.

**The structural argument for merging rather than either keeping or ripping:** the
soul is a *parallel memory system*. Its content — directives, corrections,
per-person relationship — is memory of a particular kind. It has its own store, its
own decay, its own projector, its own persistence, fed by its own pipe. Once a real
typed memory store exists, "the soul" is a **view over rows of kind
`directive`/`correction`/`preference` filtered by subject, rendered by the same
ranker that renders facts.** Merging it is a net *deletion of concepts*, not a
migration.

### Keep (≈460 lines, absorbed into the memory subsystem)

| Keep | Why |
| --- | --- |
| **The thesis** — "the model never writes its own soul" | The best idea in the repo. Generalize it to *all* memory: the model **proposes** claims, the harness **decides** what survives. |
| **Selection, never generation** (`projector.ts` principle) | Prompt surfaces assembled by ranking + verbatim quoting. Directly fixes 1.1 and 1.3. Keep the principle; the 240-line implementation becomes a ranked SQL query. |
| `critic.ts` (162 lines) | Model-free wall-of-text / sycophancy / emoji-overload classifiers. The only mechanical voice enforcement anywhere in Talon — and currently dead code. |
| `taps.ts` (199 lines) | Crude but real, and it is the *input* to everything. Keep, move out of Telegram, extend to every frontend. |
| `lens.ts` (110 lines) | Per-interlocutor refraction — the highest-value persona feature. Re-express as ~60 lines of query. |
| Decay math (~40 of `salience.ts`) | One exponential decay + a reinforcement counter. Everything else in that file is unfeedable. |

### Delete (≈4,300 lines + ~26 test files)

`dag` · `hash` · `delta` · `hdc` · `associative` · `centrality` · `forgetting` ·
`drift` · `valence` · `emergent-critic` · `governance` · `cluster` · `consolidate` ·
`reflect` · `compiler` · `kernel` · `lattice` · `retrieve` · `embedder` ·
`talon-embedder` · `projector` · `service` · `reflex` · `signals` · `types` ·
`settings` · `index`, and the `TALON_SOUL_ENABLED` gate.

Content addressing to dedup ~50 rows, and a Merkle commit chain to version them,
is work SQLite already does. Reflexes overlap the critic-as-guard and go with it.

**Teardown lands last** (Phase 6) — the old thing is removed only once the new
thing does its job. But the *decision* is now: no further investment in the kernel.

---

## 3. Target architecture

Five ideas, in dependency order.

### 3.1 One typed store; markdown becomes a view

The substrate already exists and is good: SQLite at `~/.talon/data/talon.db`,
`sql/<store>.sql` → `statements.generated.ts` → `repositories/<store>-repo.ts` →
`<store>.ts` (zero SQL above the repo), FTS5 available, `node:sqlite`/`bun:sqlite`
with no native addon. There is no `memory` table. Add one.

Every row: `id, kind, subject, key?, text, source{frontend,chat,actor,turn}, trust,
confidence, created_at, last_seen_at, hit_count, salience, pinned, superseded_by`.

**Kinds are lifecycles, not labels** — this is the fix for 1.1 and 1.2:

| kind | lifecycle | injection |
| --- | --- | --- |
| `directive` | durable, human-authored intent | **pinned — never truncated away** |
| `fact` | durable, supersedable, slow decay | ranked into the core view |
| `state` | **keyed; a write REPLACES the row for that key**, has an explicit staleness horizon | injected while fresh, queryable after |
| `episode` | timestamped, fast decay, consolidates into `fact` or drops | retrieval only |
| `relationship` | per-subject: tone, working style, history | persona layer, subject-scoped |
| `reflection` | first-person diary; **never a fact source** | persona layer only, bounded |

The keyed-`state` rule alone kills the CI-watch accretion: `heartbeat.health` is
one row, overwritten, not a new dated section per run.

`memory.md` stops being the source of truth and becomes a **rendered projection** —
regenerated after each reconcile, still human-readable and `Read`-able. Because the
store is ranked, truncation becomes *selection under a budget* instead of slicing.
Hand-edits to the file are treated as an inbox and folded back on change, so it
stays human-editable without being authoritative.

### 3.2 Writes are cheap, in-band, single-claim

Today, learning something means either the model calling `Write` on a 23 KB file
mid-conversation (expensive, race-prone — so it doesn't) or waiting up to 12 hours
for the dream. Add `remember` / `forget` / `recall`: one typed claim, ~50 tokens,
transactional. On `assert`, FTS-match against existing rows of the same
`kind`+`subject`; a near-duplicate becomes a **supersede candidate** rather than a
second row. That is MemPalace's `check_duplicate` idea moved into the write path
and made automatic — mechanically, the highest-leverage reconciliation in the plan.

The live agent stops writing `memory.md` directly. That resolves 1.4 by
construction.

### 3.3 Reconciliation is mechanical ops, model-proposed

The dream agent stops re-authoring prose and emits **operations only**:

```
assert(kind, subject, key?, text, confidence)   supersede(id, text, reason)
merge(ids[], text)                              drop(id, reason)
promote(episode_ids[] → fact)                   pin(id) / unpin(id)
```

The harness validates (ids exist, budget respected, pinned rows need an explicit
reason), applies transactionally, and writes a `memory_history` row for every
change; drops go to a graveyard, not oblivion. The model gets a **worklist** —
contradiction candidates, over-budget tails, stale `state` rows — instead of the
whole file. A bad model turn can no longer clobber 23 KB, and every change is
diffable and revertible (`/memory diff`, `/memory undo`).

Consolidation gets what it has never had: a **hard target size** and a **decay
policy**. Over budget → lowest-ranked non-pinned rows are merged into a parent or
dropped to the graveyard. Never annotated in place.

### 3.4 Retrieval is harness-driven

Fill the seam that already exists. A real `MemoryRetriever` over the store: FTS5
match on the incoming message + recency decay + salience + `hit_count`, trust-
filtered (the #373 policy is already written and enforced in two places). No model
call, no MCP round trip — sub-millisecond. MemPalace/mem0 stay as *optional deep
archives*; they stop being the primary path.

Two tiers, and the boundary between them is a prompt-cache invariant:

- **Core view** — pinned directives + top facts/relationship for the current
  interlocutor + fresh relevant `state`, computed **once per session build** and
  living in `staticText` (~1.5–2 k tokens, budgeted).
- **Turn retrieval** — keyed to the incoming message, injected via the existing
  `formatPromptWithRetrievedMemory` in the *user turn*, never in
  `prepareSystemPrompt()`. The 3 k-char cap is already implemented.

### 3.5 Persona is three layers, and the first one is memory

Persona-without-memory is cosplay; the strongest personality signal available is
unprompted, accurate callback ("you said the same thing about the last refactor").
That is why memory ships before persona, not beside it.

- **Voice** — authored, human-owned, stable. `identity.md` rewritten from
  adjectives into *concrete stances on concrete situations*: what you do when
  someone's plan is bad, when you don't know, when someone is upset, when the same
  question arrives a third time. With **anti-examples** — "don't do X, here's what
  X looks like" constrains far harder than any positive adjective. One file, shared
  by every frontend; the frontend prompts keep capability docs only, ending the
  voice drift in 1.7.
- **Relationship** — derived, per-subject, mechanical. The lens as a query over
  `relationship` + `directive` + `preference` rows for whoever is talking, rendered
  verbatim. "How I show up with Ada" ≠ "how I show up with a stranger in a
  group."
- **Stance** — per-turn, enforced. Run `critic.ts` on drafted output: log-only
  telemetry first, then a single targeted retry on the strongest classifier.
  Mechanical restraint does more for perceived personality than any adjective, and
  the classifiers already exist.
- **Continuity** — a bounded slice of recent `reflection` rows, explicitly marked
  as self-reflection. A diary that is written and never read is a log, not
  interiority. Hard rule: **the diary is never a retrieval source for facts.**

### 3.6 The prompt-cache invariant

This is already solved, and the plan must not un-solve it.

`prepareSystemPrompt` (`backend/runtime/prompt/system-prompt.ts`) freezes the **entire**
prepared prompt — static *and* dynamic — per `(chatId, sessionEpoch)`. So within a
session the system prompt is byte-stable, and `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` makes
the static prefix cacheable *across* sessions on top of that. The docstring records
what getting this wrong cost: **60–90 k cache-write tokens on turns that should
write 2–8 k.** Only plugin reload and native-extension changes invalidate
(`notifyPromptInputsChanged`), which is correct — both are rare and deliberate.

**Invariant: nothing on the memory write path may ever call
`notifyPromptInputsChanged()`.** A `remember` that invalidated snapshots would
force a full-prompt cache write across every live session, on every learned fact.
This is the single most expensive mistake available in this plan, and it is also the
*obvious* one — someone will notice that a mid-session `remember` doesn't appear in
the core view and reach straight for invalidation.

**The consequence is a design constraint, not a bug to fix.** A fact learned at
turn 3 cannot enter that session's core view; it reaches the model through **turn
retrieval**, which runs per turn and lands in the user message *after* all cached
history. So: core view = frozen, session-scoped. Anything learned mid-session =
retrieval-only until the next session. That is the cache-correct design, and it is
exactly what the Phase-B seam already does.

**Investigated 2026-07-30 — the TTL lever does not exist.** The hypothesis was that
the dominant cost is the 5-minute cache TTL versus a chat bot's minutes-to-hours
cadence, fixable with a 1-hour TTL. It is not fixable from here:
`@anthropic-ai/claude-agent-sdk@0.3.212` exposes **no cache-control surface at
all** — a full grep of `sdk.d.ts` + `agentSdkTypes.d.ts` for cache/ttl identifiers
returns only `cacheCreationInputTokens` / `cacheReadInputTokens` (read-only usage
reporting). The SDK owns `cache_control` placement internally. A 1-hour TTL is an
**upstream ask**, not a config change.

Two things the SDK docs do settle:

- **Talon's static/dynamic split is correct**, per `sdk.d.ts` on `systemPrompt`:
  *"include `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` as a standalone element to mark the
  split between the static (globally-cacheable) prefix and the dynamic
  (session-specific) suffix. Blocks before the marker are eligible for
  cross-session prompt caching; blocks after it are not."* That is exactly what
  `toSdkSystemPrompt` builds.
- **`excludeDynamicSections` doesn't apply to us.** It strips per-user dynamic
  sections for cross-user cache hits, but *"has no effect when `systemPrompt` is a
  string (custom prompt)"* — Talon always passes a custom array.

**Measured, from the live DB's `sessions` rows:**

| session | cache_read | cache_write | ratio | hit |
| --- | --- | --- | --- | --- |
| sonnet, 1 API call | 242,847 | 30,326 | **8.01** | 100% |
| default, 4 API calls | 111,959 | 43,635 | 2.57 | 94.9% |
| haiku, 1 API call | 19,091 | 20,384 | **0.94** | 97.2% |
| (one session) | 0 | 0 | — | 0% |

**Within a turn, caching works well** — the 8:1 row is ~11 model requests inside one
user turn all reading the same ~22 k prefix. **Across turns is where it goes** — the
0.94 row is the cold-start shape: write the prefix, read it once, pay ~1.25× for the
write. Caveat: four short sessions on a dev instance, and 93% of the log's 696
usage lines are test-harness chats. This characterises the *shape*; it does not
quantify production cost. That is what PR 3 is for.

**So the only lever Talon controls is prompt size** — which reframes this plan's
economics in its favour. If most turns miss the cross-turn cache, cost is
`cache-write volume × prompt size`, and every write here is 20–44 k tokens at
1.25×. Cutting ~10 k chars of stale CI-watch content out of the static prompt
(§1.1) saves ~2.5 k tokens × 1.25 on **every cold turn** — a bigger, more reliable
win than hit-rate tuning, and it lands in PR 1.

Remaining suspects, in order:

- **The 20-block lookback window.** A cache breakpoint walks back at most 20
  content blocks to find a prior entry. Talon's agentic turns emit many
  tool_use/tool_result pairs, so a turn with >20 blocks can silently stop the
  *next* turn's breakpoint from finding the prior cache. The 8:1 row shows
  within-turn is fine; cross-turn after a tool-heavy turn is unverified.
- **Tool-definition churn.** Tools render *before* the system prompt, so any change
  to the tool array invalidates everything after it. Lazily-discovered plugin tools
  (see `base.md`) are exactly that shape. A stable prompt behind an unstable tool
  list buys nothing.
- **The cacheable minimum is model-dependent and non-monotonic** — 512 tokens
  (Opus 5), 1024 (Opus 4.8 / Sonnet 5 / 4.6), 2048 (Opus 4.7), **4096 (Opus 4.6,
  Haiku 4.5)**. Below it, nothing caches and there is no error. Talon's ~20 k chat
  prompts clear every threshold, but the one-shot paths (dream, heartbeat, cron) may
  not — and the zero-cache session above is consistent with exactly that.
- **Compaction** rewrites history and re-writes cache (visible via
  `notificationHook`); **restarts** cost one re-freeze per session (accepted).

**This plan's own cache cost**, stated plainly: core view ≈ 2 k tokens in
`staticText` — one write per session, then free reads. Turn retrieval ≤ 3 k chars in
the user turn — **uncached by definition, every turn** (~750 tokens). That recurring
cost is the price of retrieval that actually works, and it should be budgeted
deliberately rather than discovered later.

One future option worth knowing: **mid-conversation system messages**
(`{"role": "system"}` inside `messages[]`) are supported on Opus 5 / Opus 4.8 /
Fable 5 with no beta header, sit *after* the cached history, and carry
non-spoofable operator authority — the ideal channel for a directive learned
mid-session. Whether the Agent SDK will let Talon inject one is unverified; noting
it, not planning on it.

---

## 4. Phases

PR-by-PR execution plan: **`memory-persona-rollout.md`**.

**Phase 0 — Stop the bleeding.** Small diffs, no new architecture, ships this week.
Rank-based truncation in `assemble.ts` (priority-ordered sections, newest-only per
`state`-family heading) instead of head-slicing. Rewrite the dream/heartbeat
prompts: forbid a new dated section for an existing topic, require replace-in-place
for status, set a hard size target, and replace *"do not remove entries just
because they're old"* with a real decay rule. Route status snapshots to a
separately-owned `memory/state.md` that is fully rewritten each run. Split writer
ownership: heartbeat → state + daily note; dream → memory; live agent → an inbox
file. Rotate/consolidate daily notes and give them an index. **This roughly doubles
effective memory quality for a few hundred lines.**

Also in Phase 0, independent of memory: **instrument the cache read:write ratio per
turn** from the figures `stream.ts` already captures, and check whether the tool
array is byte-stable per session. Both are prerequisites for reasoning about usage —
see 3.6. Do this before any structural change, or the plan's cost will be
indistinguishable from the TTL problem it sits next to.

**Phase 1 — The store.** `memory.sql` + `memory-repo.ts` + `memory.ts` + FTS5.
One-time idempotent importer for the existing `memory.md` and daily notes (file
kept as backup). Render `memory.md` from the store. Tests.

**Phase 2 — Write path.** `remember` / `forget` / `recall`. Auto-dupe-check on
assert. Move directive/correction classification out of the Telegram frontend into
a shared engine seam so every frontend feeds it; generalize reaction attribution to
every frontend that has reactions (telegram, native, discord).

**Phase 3 — Read path.** Real `MemoryRetriever` against the store; core view
replaces the head-slice; per-interlocutor block. Measure token cost against the
prompt-cache invariant in 3.4.

**Phase 4 — Reconciliation.** Op-based dream, worklists, history + graveyard,
budget enforcement, `/memory` inspect/diff/undo.

**Phase 5 — Persona.** Rewrite `identity.md` as voice + stances + anti-examples.
Relationship block. Critic as guard (log-only → enforce). Bounded diary read-back.
De-duplicate voice out of the frontend prompts.

**Phase 6 — Soul teardown.** One mostly-deletion PR: ~4,300 lines and ~26 test
files out, `TALON_SOUL_ENABLED` removed, the six survivors already living in the
memory subsystem.

**Phase 7 — Surfaces (optional).** `talon://` mount for memory (fits the existing
VFS namespace) and a Companion memory view. A memory you can see and correct by
hand is a memory you will trust.

---

## 5. Risks

| Risk | Mitigation |
| --- | --- |
| **Prompt-cache regression** — the trap most likely to bite. See 3.6 in full. | Core view computed once per session build, in `staticText`. Turn retrieval only ever enters via the user-turn wrapper. **A test that fails if the memory write path reaches `notifyPromptInputsChanged`.** |
| **Memory poisoning** in group chats — a poisoned pinned row is a permanent prompt injection. | #373 trust levels enforced **at the store**, not just the retriever. `user_claim` / `group_chat` can never reach the pinned or core tier. |
| **Token cost** | Core view budgeted (~2 k), retrieval capped (3 k chars, already implemented). Both measured. |
| **Model doesn't call `remember`** | Cheap single-claim tool + explicit norm; instrument call rate and iterate on the prompt, not the schema. |
| **Over-eager forgetting** | Graveyard + `memory_history` + `/memory undo`. Nothing is unrecoverable. |
| **Diary contaminating facts** | Structural: `reflection` rows are excluded from the fact retriever, not merely discouraged. |

## 6. How we will know it worked

- **Reachable memory**: share of durable content that actually enters the prompt.
  Today ≈ 51% by chars — and the wrong 51%.
- **Store size over time**: must plateau. Today it grows monotonically.
- **Supersessions per reconcile**: currently zero; annotation instead.
- **Duplicate/stale rate** in the store.
- **Callback rate**: unprompted, accurate references per week (sampled).
- **Critic flag rate** on Talon's own output: should fall once the guard is live.
- **Daily-note read rate**: should approach zero — retrieval replaces it.

## 7. Non-goals

No cloud memory. No vector database (FTS5 + recency + salience is enough, and the
local-only constraint is deliberate). No second identity system — the soul's
function is absorbed, not reimplemented. The model is never the reconciler of
record. No per-frontend persona.
