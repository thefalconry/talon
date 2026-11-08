# Memory & Persona — rollout

Execution plan for `memory-persona-plan.md`. Fifteen PRs in seven stages. Each PR
is independently shippable, lands its own runtime consumer (no repeats of the soul's
mistake), and is reviewable on its own.

**Net line count: roughly +3,400 / −4,700.** The codebase gets _smaller_ while
gaining a memory system that works.

Repo conventions every PR here obeys:

- Storage: `sql/<store>.sql` → `npm run build:sql` → committed
  `statements.generated.ts` (`sql-embed.test.ts` fails on drift) →
  `repositories/<store>-repo.ts` (execution + row↔domain mapping, no SQL) →
  `storage/<store>.ts` (domain API, **zero SQL**). DDL goes in `schema.sql`,
  idempotent, applied on every open.
- `storage/` never imports `core/`, `backend/`, or `frontend/` (dependency-cruiser
  `storage-below-the-engine`). **So: the store lives in `storage/`, the policy —
  ranking, retrieval, projection — lives in `core/memory/`.** That split is already
  anticipated by the existing `core/memory/retrieval.ts` seam.
- Prompt text lives in `prompts/`, never in TS. New prompt assets need
  `npm run build:prompts` (`prompts-embed.test.ts` fails on drift).
- Tools are two files: `core/tools/<group>/<area>.ts` (zod schema + `bridge("action")`) and
  `core/engine/gateway-actions/<area>.ts` (the action).
- Every PR ships consumers, or `knip` flags the unused exports. That gate is doing
  real work here — respect it rather than suppressing it.
- Validation is CI, not local (`gh pr checks`): `test`, `typecheck`, `lint`,
  `depcruise`, `ratchets`, `knip`, `format:check`.
- Engine-touching PRs (6, 7, 9, 10) need Discord verified — it breaks quietly.

One flag gates the whole new path: **`TALON_MEMORY_STORE`**, default off until
both read tiers are measured — the static core view (PR 9) and per-turn
retrieval (PR 8). Removed during Stage 6.

---

## Stage 0 — Measure, and stop the bleeding

No new architecture. Ships this week. Independent of everything below, and worth
doing even if the rest is deferred.

### PR 1 — `fix(prompt): rank memory sections instead of head-slicing` ✅ done

The single highest value-per-line change in the plan.

**Landed.** On the live 23,396-char file the view emits 9,461 chars: every live
section present (`## Active Investigations` with its root-cause analysis,
`## Revisions`, `## Branches to clean up` — all previously below the cut), the
newest CI-watch snapshot kept, the two stale duplicates dropped and named. That
is 21% _smaller_ than the old 12k head-slice, so it also cuts the per-turn
cache-write cost. 14 tests; full suite green.

- **New** `core/prompt/memory-view.ts`: split `memory.md` on `##` headings;
  classify each section into a priority tier; collapse "state families" (headings
  sharing a prefix before `(as of` / `(Run #`) to the newest member only; order by
  tier; then cap.
- Tier order: directives/preferences → people & facts → active investigations and
  open items → newest state snapshot → remainder.
- **Edit** `assemble.ts` §4: `capMemory(memory)` → `renderMemoryView(memory)`.
- Tests: a sanitized fixture of the live file, asserting `## Active Investigations`
  survives the cap and exactly one `Inbox / CI Watch` section is retained. Plus:
  **output is byte-identical when the file is under the cap** — keeps the
  prompt-cache tests honest.
- Not wasted work when PR 5 lands: this parser becomes the importer.

### PR 2 — `fix(prompts): write discipline + state/memory split` ✅ done

- `prompts/heartbeat.md`: heartbeat **stops writing `memory.md`**. It writes
  `memory/state.md` — fully rewritten each run, one keyed section per domain — plus
  today's daily note. This is where "heartbeat dead since 07-10" belongs.
- `prompts/dream.md`: replace-in-place for status topics; a new dated section for an
  existing topic is forbidden; hard size target for `memory.md` (~10 k chars);
  replace _"do NOT remove entries just because they're old"_ with a decay rule;
  removals append to `memory/archive/YYYY-MM.md` rather than vanishing. New stage:
  daily notes older than 14 days collapse into a monthly summary and the originals
  are deleted.
- `assemble.ts`: inject `state.md` as its own capped section (~2 k).
- `prompts/system/workspace.md` + `persistent-memory.md`: document the split and
  who owns which file.
- `npm run build:prompts`, commit the regenerated embed.

**Landed** as #694.

### PR 3 — `feat(metrics): per-turn cache read:write telemetry` ✅ done

Prerequisite for the whole usage conversation — see plan §3.6, which now records
what the 2026-07-30 investigation settled: **the Agent SDK exposes no cache-TTL
knob**, so the 1-hour TTL is an upstream ask and prompt size is the only lever
Talon controls. No behaviour change in this PR.

**Landed** as `backend/runtime/cache/cache-telemetry.ts` (25 tests). The accounting
line now carries `xturn=hit|miss|none reqs=N rw=R`, derived from the result message's
per-request `usage.iterations` — `xturn` is the field that tracks cost, since the
turn's first request is the only one that reports whether the previous turn's
prefix survived. Plus mid-session tool-set change warnings that name the delta,
a lookback-window flag, and a sub-minimum check on the one-shot paths.

**Read `xturn` first when the data comes in.** Mostly `miss` → the prefix is
dying between turns and the fix is a smaller prefix (or the upstream TTL ask);
mostly `hit` → caching is working and the cost is elsewhere; any `none` → that
prompt isn't cacheable at all.

- `stream.ts` already captures `cache_read_input_tokens` /
  `cache_creation_input_tokens`, and `sessions` already persists the totals. Surface
  the **per-turn** ratio in the post-turn accounting line and persist to `turn_meta`
  (table exists, currently 0 rows).
- Distinguish **within-turn** from **cross-turn** hits — the measured 8:1 ratio is
  ~11 model requests inside one user turn, which tells you nothing about whether the
  _next_ turn hit. Cross-turn is the number that matters.
- Log a hash of the registered tool-name array per turn; warn when it changes
  _within_ a session.
- Count content blocks per turn and flag turns over 20 — that is the cache
  lookback-window limit, and Talon's tool-heavy turns are the shape that trips it.
- Check the one-shot paths (dream, heartbeat, cron) against the model's cacheable
  minimum — 4096 tokens on Opus 4.6 / Haiku 4.5. Below it nothing caches, silently.

---

## Stage 1 — The store

### PR 4 — `feat(storage): typed memory store with FTS5` ✅ done

- `sql/schema.sql`: `memory` table; `memory_fts` (external-content FTS5 + the three
  `ai`/`ad`/`au` triggers — copy `history_fts` exactly, it is the established
  pattern); `memory_history`; indexes on `(kind, subject)`, `(key)`, `(salience)`.
- `sql/memory.sql`: named statements.
- `repositories/memory-repo.ts`: statement execution, row↔domain mapping.
- `storage/memory-store.ts`: `assert`, `supersede`, `drop`, `merge`, `pin`,
  `search`, `listByKind`, `replaceStateKey`. Validation. Zero SQL, no core imports.
- `npm run build:sql`; commit both files.
- Tests: CRUD; FTS search; **keyed-state replacement semantics**; supersede writes
  history; drop lands in the graveyard; `TALON_DB_PATH` isolation.
- Fold PR 5 in if `knip` objects to the API landing without consumers.

**Landed** as #937. The store is `storage/memory.ts` (not `memory-store.ts`) and
the API is `assertMemory` / `supersedeMemory` / `dropMemory` / `mergeMemory` /
`pinMemory` / `unpinMemory` / `replaceStateKey` / `touchMemory` / `getMemory` /
`listMemories` / `searchMemories` / `memoryHistory`, per the naming settled in
#929. `assertMemory` returns the bm25-ranked near-duplicates of the same kind +
subject alongside the new id, so PR 6 can offer supersede-instead-of-append
without the store ever auto-superseding. knip took `talon memory` (list /
search / show / remember / forget / state) as the consumer, so PR 5 stayed
separate. 36 tests.

### PR 5 — `feat(memory): import memory.md, render it back` ✅ done

- `core/memory/import.ts`: `memory.md` + daily notes → rows, reusing PR 1's parser.
  Idempotent via content hash. Original files preserved.
- `core/memory/render.ts`: rows → `memory.md`, ranked and budgeted. Supersedes PR 1's
  ranker as the production path.
- CLI: `talon memory import` / `talon memory render`.
- `/memory` (telegram + native): top rows, search, `/memory why <id>` for provenance.
  **Landed** as #941 — read-only on both surfaces (`/memory`, `/memory <query>`,
  `/memory why <id>`, `/memory kind <kind>`; `GET /memory` + `GET /memory/why` on the
  bridge). The write path stays with PR 6.
- With the flag on, the store is authoritative and `memory.md` is rendered output.
  Hand-edits to the file are folded back as an inbox on next import.

**Landed** as #940. `core/memory/import.ts` exports `importMemoryFile` /
`importDailyNotes` / `importAll`, all returning `{ inserted, superseded, skipped }`;
`core/memory/render.ts` exports `renderMemoryMarkdown` / `writeRenderedMemory`.
PR 1's parser is reused rather than reimplemented — `parseSections`,
`collapseFamilies`, `classify`, `TIER_ORDER`, `familyKey` and `headingTitle` became
exports of `prompt/memory-view.ts`, unchanged in behaviour — and the store
re-exports the repo's hash as `memoryContentHash`. Kind follows the heading tier:
`directives`→`directive`, `people`→`relationship`, `status`→`state` (keyed on a slug
of the family key, written through `replaceStateKey`), `historical`→`episode`,
`active`/`general`→`fact`; a bare `YYYY-MM-DD` heading is an `episode`, which is what
makes a rendered daily note read back as the episode it came from. Idempotency is by
content hash over `kind|subject|key|text` against the live row with
`source.actor = "import"`: same hash skips, a different hash supersedes (that is the
hand-edit fold-back), nothing else inserts. Sections over the store's 4000-char cap
split at blank lines into ` (n/N)` rows, which the render regroups, so
import → render → import is a fixed point. CLI: `talon memory import` and
`talon memory render [--write]` (`--write` archives the current file to
`memory-before-render-<date>.md` first, once a day). `assemble.ts` is untouched; the
flag flip and the core view stay PR 8/9.

---

## Stage 2 — Write path

### PR 6 — `feat(tools): remember / forget / recall` ✅ done

- `core/tools/content/memory.ts` + `core/engine/gateway-actions/memory.ts`.
- `remember(kind, text, subject?, key?)` — on assert, FTS near-dupe check turns a
  near-match into a **supersede candidate** instead of a second row. Mechanically the
  highest-leverage reconciliation in the plan, and it lives in the write path.
- `recall(query)` — explicit pull when the model wants more than was auto-injected.
- `forget(id, reason)` — to the graveyard.
- `prompts/system/memory.md`: the norm only (when to remember, what never to store).
  No protocol prose duplicating tool descriptions.
- **Required test: the memory gateway actions never reach
  `notifyPromptInputsChanged`.** This is the cache invariant from plan §3.6, and it
  is the mistake someone will otherwise make on purpose.
- Verify Discord.

**Landed** as #948. `core/tools/content/memory.ts` + `core/engine/gateway-actions/memory.ts`
export three actions: `remember(kind, text, subject?, key?, confidence?,
replace_id?, force?)` → `{ ok, id, line }`, `recall(query, kind?, limit?)` →
`{ ok, rows[] }` (limit capped at 20, each returned row touched so `hit_count`
feeds PR 8's ranking), `forget(id, reason)` → the graveyard, reason required so
every removal is auditable. The store gained `findSimilarMemories(kind, subject,
text, limit)` — the near-duplicate probe `assertMemory` already ran, now exposed
without inserting and shared by both, so there is one definition of
"near-duplicate". **Supersede-candidate rule:** `remember` probes first, and a
live near-match with no `replace_id` writes nothing — it returns
`{ ok: false, error: "Near-duplicate of #<id>", similar: [...], hint }`; the
caller answers with `replace_id` (→ `supersedeMemory`, old row kept and linked)
or `force: true`. `state` skips the probe because `replaceStateKey` already
replaces the live row for its key. **Trust rule:** `trustForChat` reads the
canonical chat-id grammar through a new `chatScope` in
`core/frontend-runtime/chat-id.ts` —
`discord_guild_…` / `wa_group_…` / a negative Telegram id are groups, `…_dm_…` /
positive Telegram / `t_…` / `d_…` are DMs, and `teams_chat_…` names 1:1 and group
chats alike, so it is "unknown". Group *or* unknown → `group_chat` trust (fail
closed: never pinnable, never in the core view, plan §5); a `directive` from a
group context is refused outright. The tier also gates *overwrites*: a claim may
only be superseded (`replace_id`) or forgotten from a context at its own tier or
stronger, because `supersedeMemory` inherits the old row's trust and `dropMemory`
drops whatever id it is handed — without it, both are escalation paths out of a
group chat. Operator rows can never be retired from a chat at all (`talon memory
forget <id>` instead). **`recall` stays global and unfiltered** — whether an
explicit pull should be trust-filtered the way `filterAutoInjectable` filters
auto-injection is a **PR 8 decision**, taken with the retriever rather than ahead
of it. Every store error surfaces as
`{ ok: false, error }` — nothing throws through `handleSharedAction`. The cache
invariant is a test: the module never imports `core/prompt/invalidation.js`, and
`memory-actions.test.ts` mocks it with a spy and asserts all three actions leave
it untouched. Norm in `prompts/system/memory-recall.md` (a "Remembering"
section), not protocol prose. **Reads are still flag-gated** behind
`TALON_MEMORY_STORE` until PR 9 flips it; **writes through these tools are
always live**, so the store fills up and becomes measurable before the read path
turns on.

### PR 7 — `refactor(soul): taps into the shared engine seam` ✅ done

The PR that makes persona learning frontend-agnostic — what the soul never got.

- Move directive/correction classification out of
  `frontend/telegram/handlers/messages.ts` into the engine's inbound path, so every
  frontend feeds it.
- Generalize reaction attribution beyond Telegram to native and discord.
- Taps write `directive` / `correction` rows to the store. The soul kernel call
  stays behind its own flag until Stage 6.
- Verify Discord.

**Landed** as #953, folded into PR 15 — there was no reason to keep the
kernel alive for one release when the only thing feeding it was moving out.
`core/memory/taps.ts` exports `classifyMessage` (the `DIRECTIVE_PATTERNS` /
`CORRECTION_PATTERNS` regexes, verbatim from the soul) and
`recordMessageSignal({ text, chatKey, actor? })`, which writes to the store:
a directive becomes `{ kind: "directive", subject: "operator" }` and a
correction `{ kind: "episode", subject: "correction" }`, both with
`source.actor = "tap"`. Trust is read off the chat id with `chatScope` — a DM
is `operator` (a human typed it, which is *stronger* than `remember`'s `agent`),
anything else is `group_chat`, and a **directive from a group is classified and
dropped**, the same rule `remember` enforces. A near-duplicate probe
(`findSimilarMemories` as the FTS prefilter, then an 0.8 Jaccard threshold —
needed because every directive shares one subject) keeps a repeated phrase to
one row, and any store error is one warning, never a failed turn.

The call site is `dispatcher.execute`, guarded on `source === "message"`: every
frontend (Telegram, Discord, WhatsApp, Teams, native, terminal) now feeds it,
and Talon's own pulse / cron / trigger prompts do not. **The reaction tap was
not generalized — it was deleted**: emoji valence only ever meant anything to
the Hebbian lattice, which is gone. That took `BOT_MESSAGE_ACTIONS` /
`noteBotMessage` out of `gateway.ts` and both frontends' reaction listeners with
it, plus `message_reaction` from Telegram's `allowed_updates`.

---

## Stage 3 — Read path

### PR 8 — `feat(memory): turn-time retrieval from the store` ✅ done

**The PR where memory starts working.** The core view (PR 9, #943) is the
session-frozen tier; this is the per-turn one, and the two together are plan
§3.4's pair.

- `core/memory/turn-retrieval.ts`: FTS match on the inbound message + recency
  decay + salience + `hit_count`. Sub-millisecond, no model call, no MCP round
  trip.
- Gated on `TALON_MEMORY_STORE`; trust policy per plan §5.
- Retrieved rows bump `hit_count` / `last_seen_at` — the ranking feedback loop.
- Tests: relevance; trust filtering; **fail-closed on any db error**; budget cap;
  prompt byte-identical when nothing is retrieved.

**Landed** as #952, still default-off. `core/memory/turn-retrieval.ts` exports
`retrieveForTurn({ chatId, text, isGroup })` and `TURN_MEMORY_MAX_CHARS`
(3 000 chars). The Weaver resolves it once per turn in `executeInner`, before
`runChatTurn`, and passes the rendered block as `retrievedMemory`.

**The seam is one field, one renderer, and one producer** — which is what #639's
`retrievedMemory` lacked. That field was read by two backends out of six and
silently dropped by the other four ("a latent divergence that would have become
a real bug the day a retriever was installed"), so #639 deleted the plumbing
rather than finish it. The rebuild routes everything through
`formatUserPrompt` — the ONE helper all four backends already call for their
time tag, sender label and `msg_id` framing — so a backend cannot drop the block
without also losing the framing its tests pin:

| layer                                       | change                                                       |
| ------------------------------------------- | ------------------------------------------------------------ |
| `core/agent-runtime/capabilities.ts`        | `ChatRunParams.retrievedMemory?: string`                     |
| `core/weaver/weaver.ts`                     | the only producer: `resolveTurnMemory` before `runChatTurn`  |
| `backend/runtime/turn/handler-to-events.ts` | `turnFields()` carries the data half of the params verbatim  |
| `backend/runtime/prompt/prompt-format.ts`   | the only renderer: appends the block after the message text  |
| the four handlers                           | pass `retrievedMemory` into `formatUserPrompt`, nothing else |

Rendered as `\n\n[Recalled from memory — verify before relying on it]\n<rows>`,
appended **after** the user's text, one `formatMemory` line per row. With the
field absent, blank, or whitespace the prompt is byte-identical to the
pre-retrieval one — asserted, alongside a contract clause
(`ChatBackend.carriesRetrievedMemory`) every shipped `BackendId` passes and a
source-level check that all four `formatUserPrompt` call sites forward the
field.

**Trust policy (plan §5, #373): only `operator` and `agent` rows are ever
auto-injected.** A `user_claim` or `group_chat` row that matches the query
perfectly is still left out — auto-injecting one turns anything said in a group
chat into a standing prompt injection. They stay reachable through the explicit
`recall` tool. `reflection` is excluded too (the diary is never a fact source,
plan §3.5); `episode` is _not_, which is what gives episodes a home now that the
core view excludes them. The trust filter runs after the bm25 cut, so a query
whose twenty best matches are all low-trust injects nothing — the conservative
direction.

Ranking is bm25 order from the store, re-weighted over the top 20 hits:
relevance 0.4 (bm25 position, the only signal that knows what was asked),
salience 0.3, `hitCount` affinity 0.2 (log-scaled, saturating at 20), recency
0.1 (linear to zero at 30 days). Ties break on id, so the order is stable. The
block is capped at `TURN_MEMORY_MAX_CHARS` **whole rows only** — a truncated
memory is a misquoted memory. Each injected row is `touch`ed, which is the
feedback loop the affinity term reads.

**Fail-closed:** any store error logs once per process at warn level and the
turn runs without memory, exactly as if the flag were off. A broken store never
blocks chat delivery.

**Cache invariant (plan §3.6):** retrieval touches the user turn only. Tests
assert the assembled system prompt is byte-identical across a retrieval hit and
that nothing on this path reaches `notifyPromptInputsChanged()` — the per-turn
version of that mistake would force a full-prompt cache write on every live
session on every turn.

`searchMemories` grew a `match: "all" | "any"` option (default `"all"`,
unchanged for `/memory` and the CLI). Turn retrieval uses `"any"`: the query is
a sentence somebody wrote as a _message_, not as a search, and AND-ing its every
word matches nothing. The expression is the one near-duplicate detection already
builds.

**The flag stays off** until `turn.memory_chars` and `prompt.memory_chars` are
read from a real run — the per-turn tier's cost next to the static tier's is the
number Decision 4 is waiting on. Both are process-lifetime histograms in
`storage/metrics.ts`; a `memory` turn phase joins `queueWait` / `warpResolve` /
`firstToken` / `stream` / `delivery`, so `turn.memory_ms` says what retrieval
costs in wall-clock.

**Open decision — should `recall` apply the same trust filter?** The explicit
tool is the documented escape hatch for `user_claim` / `group_chat` rows, so
today it does not, and a model asking for them by name is a different act from
the harness injecting them unasked. But a model that has been talked into
calling `recall` has the same poisoning surface auto-injection has, minus the
one-step deniability. Not decided here; not implemented either way.

### PR 9 — `feat(prompt): core view replaces the head-slice` ✅ done

- `assemble.ts` §4 renders the store's core view: pinned directives + top facts for
  the chat's subject + fresh `state`. Budgeted ~2 k tokens.
- Assert the core view is only ever computed inside the session-frozen build.
- Record the prompt-size delta before/after, against PR 3's baseline.
- Flag flips to default-on here, once the numbers are in.
- Verify Discord.

**Landed** as #943, still default-off. `core/memory/core-view.ts` exports
`selectCoreRows` / `renderCoreView` / `CORE_VIEW_MAX_CHARS` (8 000 chars, ~2 k
tokens); `core/memory/flag.ts` exports `memoryStoreEnabled()`
(`TALON_MEMORY_STORE === "1"`). Selection is one `listMemories` call per build,
ranked in memory: pinned rows first (any eligible kind), then `directive`, then
`relationship`, then `fact` by salience DESC / `last_seen_at` DESC, then `state`
rows seen inside a 7-day window; `episode` and `reflection` never enter the core
view (plan §3.1), not even pinned, and stale unpinned `state` is left out. The
ordered rows go through `renderMemoryMarkdown({ rows, budget })`, so the prompt and
the rendered `memory.md` projection read identically, and the block is _budgeted_
rather than truncated — whole sections drop from the bottom of the ranking and the
tail is named. New wrapper `prompts/system/memory-core-view.md` points at
`talon memory list` / `/memory` for the rest.

`assemble.ts` §4 is now `coreViewSection() ?? memoryFileSection()`: with the flag
off, or on but with an empty store, the file path runs exactly as before — a test
asserts the assembled `staticText`/`dynamicText` are byte-identical with the flag
absent and with `TALON_MEMORY_STORE=0`. The core view lands in `staticText` only
(tested), and the store is read exactly once per build (tested with a `listMemories`
spy), because the prompt is frozen per `(chatId, sessionEpoch)` — nothing here may
call `notifyPromptInputsChanged()` (plan §3.6).

Both paths record the injected block's size as the `prompt.memory_chars` histogram
(`storage/metrics.ts` grew a real process-lifetime histogram sink for it — the old
`recordHistogram` was a no-op stub swept in #820). **The flag stays off until those
two populations are compared**: file-path chars vs core-view chars is the
prompt-size delta Decision 4 is waiting on. Turn retrieval — the per-turn tier to
this one's frozen tier — landed above as PR 8, and its `turn.memory_chars` is the
second half of that comparison.

---

## Stage 4 — Reconciliation

### PR 10 — `feat(memory): op-based reconciliation`

- `core/memory/ops.ts`: op types, validator, transactional applier. Every op writes
  a `memory_history` row.
- Guards: unknown id rejected; dropping a pinned row needs an explicit reason;
  budget enforced; ops per run capped.
- `prompts/dream.md` rewritten: the dream **emits ops** and never rewrites files. It
  receives a _worklist_ — FTS near-dupe candidates, stale state keys, the
  over-budget tail — instead of 23 KB of prose to re-author.
- Tests: every op; each rejection case; rollback on partial failure.
- Verify Discord.

### PR 11 — `feat(memory): diff / undo / audit`

The trust layer. You will only let it forget things once you can see and revert what
it forgot.

- `/memory diff` (last reconcile), `/memory undo <op_id>`, `/memory graveyard`.
- Each dream run reports what it changed.

---

## Stage 5 — Persona

### PR 12 — `feat(prompts): identity.md as voice + stances` ✅ done

Prompt-only; independent of every other PR; could ship at any point.

- Replace the adjective list with concrete stances on concrete situations — bad
  plan, don't know, someone's upset, third time the same question — each with
  **anti-examples**.
- Strip voice out of `telegram.md` / `discord.md` / `teams.md` / `native.md` /
  `terminal.md`; they keep capability docs only.
- `identity.md` stays **seeded and user-editable** — a shipped rewrite updates the
  package default; a local edit wins and is never clobbered. (Settled: Ada does not
  need their live copy preserved.)

**Landed** as #691.

### PR 13 — `feat(persona): relationship block`

- The lens as a query: `relationship` / `directive` / `preference` rows for the
  current subject, ranked, quoted verbatim. ~60 lines replacing `soul/lens.ts`.
- Rendered inside the session-frozen core view.
- Group chats: subject is whoever is speaking; trust rules keep subjects from
  contaminating each other.

### PR 14 — `feat(persona): critic as an output guard`

- `soul/critic.ts` → `core/persona/critic.ts`, logic unchanged; its tests come with
  it.
- Wire post-draft: **log-only first** (flag rate per failure mode), then a single
  targeted retry on the strongest classifier, behind a flag.
- Optional: bounded diary read-back, marked as self-reflection, structurally
  excluded from the fact retriever.

---

## Stage 6 — Teardown ✅ done

### PR 15 — `refactor(soul): remove the kernel` ✅ done

Pure deletion, easy review. Everything worth keeping was relocated by PRs 7, 13, 14.

- Delete ~4,300 lines and ~26 test files: `dag` `hash` `delta` `hdc` `associative`
  `centrality` `forgetting` `drift` `valence` `emergent-critic` `governance`
  `cluster` `consolidate` `reflect` `compiler` `kernel` `lattice` `retrieve`
  `embedder` `talon-embedder` `projector` `service` `reflex` `signals` `types`
  `settings` `index`.
- Remove `TALON_SOUL_ENABLED`, the `assemble.ts` soul section, `getSoul().dream()`
  in `background/dream/index.ts`, and the `/soul` admin command (repoint at `/memory`).
- Remove the `TALON_MEMORY_STORE` flag in the same window.
- `knip` + `depcruise` + `ratchets` confirm nothing dangles.

**Landed** as #953, together with PR 7. All 29 modules went, plus
`README.md` / `RESEARCH.md` and all 30 `soul-*` test files — 4,869 source lines
and 2,859 test lines. `critic.ts` and `lens.ts` went with them: PRs 13 and 14
will re-express both against the store rather than port the kernel's versions,
and keeping 270 lines of dead code as a reference that git already holds is not
worth a knip suppression.

Three things deviate from the sketch above:

- **The `TALON_MEMORY_STORE` flag stays**, because the core view is still
  default-off pending Decision 4's prompt-size comparison. Removing it is the
  flag flip, not the teardown.
- **`/soul` is deleted, not repointed.** `/memory` already exists on Telegram,
  Discord and the native bridge (PR 5), so there is nothing to repoint.
- **`config.soul` survives as `z.unknown().optional()`.** The root schema is
  `.strict()`, so a key that simply vanished would make every existing
  `config.json` fail to load. It parses, it is ignored, and the loader warns
  once. Removing it for real is a future breaking release.

**The prompt cache is untouched** (plan §3.6). The soul's `assemble.ts` §1.5
block only ever emitted with `TALON_SOUL_ENABLED` on — off by default — so the
default `staticText` / `dynamicText` are byte-identical before and after;
`memory-core-view.test.ts` keeps the surviving assertion from
`soul-prompt-injection.test.ts`. The new tap writes rows and nothing else: it
never imports `core/prompt/invalidation.js`, asserted by spy.

---

## Stage 7 — Surfaces (optional)

`talon://memory/` mount on the existing VFS namespace; a Companion memory view.
A memory you can see and correct by hand is a memory you will trust.

---

## Sequencing

**Critical path:** 4 → 5 → 8 → 9. That is the spine; everything else hangs off it.

**Ships immediately, in parallel, no dependencies:** ~~PR 1~~, PR 2, ~~PR 3~~, and
PR 12.

**Done:** PR 1 and PR 3. PR 1 was the biggest quality win per line in the plan;
PR 3 buys the week of cache data needed before anyone reasons about usage.
Neither touched architecture, so neither can be invalidated by a later design
change.

**Next:** PR 2 (writer discipline — heartbeat stops writing `memory.md`, dream
gets a size target and permission to forget) and PR 12 (identity.md as voice +
stances), both still dependency-free. Then the spine, 4 → 5 → 8 → 9.

Rough sizing: Stage 0 ≈ 600 lines · Stage 1 ≈ 900 · Stage 2 ≈ 500 · Stage 3 ≈ 400 ·
Stage 4 ≈ 600 · Stage 5 ≈ 400 · Stage 6 ≈ −4,300.

## Decisions

1. ~~`identity.md` reseed policy~~ — **settled.** Stays user-editable; local edits
   win, package default updates. PR 12 unblocked.
2. ~~1-hour cache TTL~~ — **settled by investigation.** The Agent SDK
   (`0.3.212`) exposes no cache-control surface, so this is an upstream ask, not a
   config change. Prompt size is the lever we control. See plan §3.6.
3. **`state.md` — file or kind?** _(open)_ PR 2 makes it a file (cheap, immediate);
   PR 4 could absorb it as a `state` kind instead. Recommend the file first, absorb
   later — it de-risks Stage 0 from Stage 1's schedule.
4. **Default-on timing for `TALON_MEMORY_STORE`** _(open)_ — proposed at PR 9, after
   the prompt-size delta is measured against PR 3's baseline. PR 9 landed
   **default-off** and instrumented instead: both the file path and the core view
   record `prompt.memory_chars`, so the flag flips once those two populations have
   been compared on a real deployment.
