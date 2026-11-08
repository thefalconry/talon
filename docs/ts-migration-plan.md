# Long-term plan: migrating Talon off TypeScript

Status: **proposal** (2026-08). Owner: Ada. Nothing below is committed
until its phase's entry gate is met.

## Why, and why carefully

Motivation is performance headroom and long-term control over the
runtime. The constraint is that Talon is a live, actively-developed
170k-LOC daemon whose load-bearing dependencies are npm packages, so a
big-bang rewrite is off the table. The shape of this plan is a
**strangler migration**: measure, shrink the JS surface, harden the
process boundaries we already have, then move subsystems one at a time —
with a checkpoint after every phase where "stop here" is a legitimate
outcome.

Two facts keep the plan honest:

1. **Talon is I/O-bound.** Turns are dominated by LLM latency and
   Telegram round-trips; `tsc --noEmit` over the whole tree is ~3s; the
   recent perf defects (blind 600s retries, per-turn MCP respawns) were
   architectural, not linguistic. Every phase therefore has a _measured_
   entry gate — we do not migrate on vibes.
2. **The repo already runs four languages behind stable boundaries.**
   `protocol/` holds one fixture-verified wire definition with three
   independent implementations (TS daemon, Dart companion, Go
   talon-node), and `native/` holds Rust/Zig/Gleam cores. The migration
   machinery — conformance fixtures per boundary, CI per implementation
   — already exists and just gets extended.

## Target architecture

```
┌────────────────────────────────────────────────────────┐
│ core daemon (target language — see decision below)     │
│ dispatcher/weaver · queues · storage · cron · triggers │
│ bridge protocol server · watchdog · frontends          │
└──────┬──────────────┬──────────────┬───────────────────┘
       │ HTTP         │ stdio NDJSON │ stdio MCP
┌──────▼─────┐ ┌──────▼───────┐ ┌────▼─────────┐
│ opencode / │ │ JS sidecars  │ │ MCP children │
│ kilo / etc │ │ (npm-only    │ │ (unchanged)  │
│ (already   │ │  deps live   │ └──────────────┘
│  external) │ │  here)       │
└────────────┘ └──────────────┘
```

The key insight: most of Talon's "npm dependencies" are already spoken
to over language-neutral boundaries (HTTP servers, spawned CLIs, stdio
MCP). The genuinely npm-only surface is small, and it lives behind
**sidecars** — thin supervised JS processes exposing one dependency each
over a versioned NDJSON-over-stdio protocol, exactly like MCP hub
children are supervised today.

## Dependency inventory (35 runtime deps)

| Disposition                                  | Packages                                                                                                                                                                                                                                                                                                                                                                      | Notes                                                                                                                                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sidecar (npm-only, no native equivalent)** | `@anthropic-ai/claude-agent-sdk`                                                                                                                                                                                                                                                                                                                                              | The agent loop host. Wraps the Claude Code runtime; no non-JS equivalent. Becomes the `talon-agent-host` sidecar speaking `AgentEvent` NDJSON — the internal event union in `core/agent-runtime/events.ts` is already the exact contract. |
| **Sidecar initially, native later**          | `telegram` (GramJS) + `big-integer`                                                                                                                                                                                                                                                                                                                                           | MTProto userbot. Go `gotd` / Rust `grammers` exist but session-format migration is risky — sidecar first, evaluate native port last.                                                                                                      |
| **Already language-neutral**                 | `@opencode-ai/sdk`, `@kilocode/sdk`, `@openai/codex-sdk`, `@playwright/mcp`, `@brave/brave-search-mcp-server`, `mem0ai`                                                                                                                                                                                                                                                       | HTTP servers, spawned CLIs, or stdio MCP servers. The core talks protocols, not packages.                                                                                                                                                 |
| **Native equivalents are mature**            | `grammy` + `@grammyjs/*` (Bot API = plain HTTPS), `discord.js` (discordgo/serenity), `@modelcontextprotocol/sdk` (official Go/Rust SDKs), `@anthropic-ai/sdk`, `openai`, `@openai/agents` (HTTP APIs), `cheerio`, `croner`, `file-type`, `liquidjs`, `marked`, `pino`, `undici`, `yaml`, `zod`, `p-retry`, `write-file-atomic`, `cross-spawn`, `picocolors`, `@clack/prompts` | Standard-library or well-trodden libraries in Go/Rust.                                                                                                                                                                                    |
| **Runtime-only, disappears**                 | `tsx`                                                                                                                                                                                                                                                                                                                                                                         | Replaced in Phase 1.                                                                                                                                                                                                                      |
| **Portable by design**                       | `wasmoon` (Lua-in-wasm), `native/*` wasm cores                                                                                                                                                                                                                                                                                                                                | Any wasmtime host runs the same `.wasm`; blake3 also has a napi build.                                                                                                                                                                    |

Net: **one hard sidecar** (agent host), **one transitional sidecar**
(userbot). Everything else is a port, not an adapter.

## Language decision (open — decide at Phase 3 entry, not before)

|                                                  | Go                                                                       | Rust                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| In-tree precedent                                | ✅ `apps/node` already implements the bridge protocol                    | wasm cores only                                           |
| Ecosystem for Talon's needs                      | gotd, discordgo, official MCP SDK, goldmark, robfig/cron, modernc sqlite | grammers, serenity, rmcp (Codex itself uses it), teloxide |
| Migration velocity for 170k LOC of orchestration | ✅ high                                                                  | lower                                                     |
| Runtime perf / RSS                               | good                                                                     | best                                                      |
| Single-binary + cross-compile                    | ✅ trivial                                                               | ✅                                                        |

Default recommendation is **Go** (velocity + in-tree precedent + the
bridge conformance suite already passing against a Go implementation),
with Rust reserved for perf-critical cores via the existing `native/`
pattern. Revisit with Phase 0 data in hand.

## Phases

### Phase 0 — Measure (entry gate for everything else)

- [x] Add boot-time and per-turn CPU/RSS accounting to the existing
      metrics (`storage/metrics.ts`). Landed as measurement only — no
      prompt byte and no turn behaviour changed.
- [ ] One `node --cpu-prof` capture of a real turn.
- [ ] **Publish the baseline** below. Define the targets that would
      justify later phases (e.g. boot < 1s, idle RSS < X MB, p95 turn
      overhead < Y ms — filled in from the baseline).
- **Exit:** numbers in hand. **Kill criterion:** if the TS control plane
  is <5% of turn latency and RSS is acceptable, later phases are
  optional perf work, not a migration.

**The baseline**

Every figure below comes off a running daemon: run `/metrics` (Telegram
or Discord, admin-only) and tap **All time** — these are process-lifetime
histograms, so the default *today* view does not carry them. The
idle-memory and per-turn rows need a daemon that has been up for a while
and served turns; a freshly booted process has the boot rows and nothing
else.
Nothing here is estimated or back-filled; the cells stay empty until
Ada pastes a reading in.

| Metric | Question it answers | Reading | Notes |
| --- | --- | --- | --- |
| `boot.total_ms` | Process start → frontends listening | | Target: < 1s |
| `boot.<phase>_ms` | Which startup phase owns the boot | | One per awaited phase: `bootstrap`, `frontends_create`, `backend_dispatcher`, `plugins`, `builtin_plugins`, `stores`, `chat_bindings`, `frontends_start` |
| `boot.rss_mb` | What the process costs the moment it serves | | The floor another runtime/language has to beat |
| `boot.heap_mb` | How much of that is JS heap | | |
| `rss.mb` | Idle resident memory, sampled every 60s | | Also answers "does it creep?" — compare `min`/`max` |
| `heap_used.mb` | JS heap share of idle RSS | | |
| `external.mb` | Off-heap (buffers, native, wasm) | | |
| `handles.count` | Active handles — fd/timer leak detector | | `process.getActiveResourcesInfo().length` |
| `turn.cpu_ms` | **The daemon's own CPU for one turn** | | The kill criterion's numerator |
| `turn.stream_ms` | Wall clock over the identical bracket | | Pre-existing; the honest denominator |
| `response_latency_ms` | End-to-end turn latency | | Pre-existing; no `turn.wall_ms` was added, this is it |

**Control-plane share** = `turn.cpu_ms` / `response_latency_ms`. Below 5%
the kill criterion fires and Phases 3–5 become optional perf work.

`/status` carries the same numbers per chat, one line:
`Daemon: rss <n> MB · heap <n> MB · cpu/turn avg <n> ms (n=<turns>)`.
The metrics store's histograms expose count/avg/min/max only, so the line
shows an average and names it — there is no percentile to read yet.

### Phase 1 — Bun as the runtime (decided 2026-08-22)

Bun 1.3.9 already runs the CLI cleanly and CI has a bun-compile sanity
job. Adoption checklist:

- [x] Full vitest suite green under Bun (#769 — 4513 pass / 29 skip)
- [x] `node:sqlite` behavior verified under Bun (storage tests on a real db)
- [x] napi (blake3-napi) + FUSE natives load, or wasm fallbacks engage —
      `bin/talon-fusefs.node` mounts `~/.talon/ns` under bun; blake3 media
      dedup runs on the napi addon
- [x] pino file transport + pretty stream behave
- [ ] grammY long-poll + GramJS soak (24h shadow instance) — no fd/RSS creep
- [x] `_mcp-launch` supervisor re-exec works under `process.execPath` = bun —
      live daemon supervises python, node, and bun MCP children
- [x] Update packaging (nfpm, Docker) to ship bun — the image is `oven/bun:1`
      with `CMD ["bun", "src/index.ts"]`; deps still come from `npm ci
      --omit=dev` in a node builder stage (package-lock.json is the lockfile
      of record), and `--build-arg RUNTIME=node` keeps the node+tsx image as
      the one-release-cycle fallback. nfpm already shipped the `bun build
      --compile` binary.

**Exit:** daemon runs on Bun in production for 2 weeks with boot/RSS
deltas recorded here. This phase alone may deliver most of the felt win.

**Soak log**

| Elapsed | RSS    | heapUsed | fds | errors | Notes                                    |
| ------- | ------ | -------- | --- | ------ | ---------------------------------------- |
| 19.9h   | 148 MB | 108 MB   | 157 | 0      | telegram + whatsapp + native, 34 hub sessions, 105 sessions |

One sample is not a trend — the soak box stays open until there are
readings far enough apart to tell warm-up from creep.

### Phase 2 — Harden the seams (still 100% JS)

- Define `protocol/agent-host_v1.json` fixtures: the `AgentEvent` stream
  - a small control RPC (runTurn, interrupt, setMcpServers) as
    NDJSON-over-stdio.
- Extract the claude-sdk backend into the `talon-agent-host` sidecar
  process behind that protocol, supervised like an MCP hub child
  (respawn-with-backoff already exists). The daemon side keeps its
  `ChatBackend` interface — this is a process split, not a redesign.
- Do the same for the GramJS userbot (`talon-userbot` sidecar) behind an
  events/commands protocol.
- **Why now:** proves the adapter design end-to-end while everything is
  still one language and trivially debuggable. Also buys crash isolation
  (an SDK OOM no longer takes down the daemon) regardless of what
  happens later.
- **Exit:** production-stable sidecars, conformance fixtures in CI.

### Phase 3 — Core skeleton in the target language

- Decide Go vs Rust (matrix above + Phase 0/1 data).
- Stand up the new core implementing, in order: storage repos (SQLite —
  mechanical, schema already migration-cursored), cron/scheduler, the
  per-chat FIFO dispatcher, watchdog, bridge protocol server (conformance
  fixtures already exist to verify it).
- Runs as a shadow daemon against a copy of `~/.talon` replaying
  journal fixtures; dual-run comparison on the bridge protocol surface.
- **Exit:** shadow daemon passes all `protocol/` fixtures + a replayed
  week of journal traffic with identical outcomes.

### Phase 4 — Frontends and backends flip

- Telegram Bot API + Discord natively in the core (plain HTTPS/gateway);
  userbot stays a sidecar.
- OpenCode/Kilo/Codex backends: the core speaks their HTTP/CLI protocols
  directly (already language-neutral). Claude backend: core supervises
  `talon-agent-host` sidecar via the Phase 2 protocol.
- Cutover per frontend behind config flags; instant rollback = flip the
  flag back to the JS daemon.
- **Exit:** JS daemon no longer serves production traffic.

### Phase 5 — Retire and re-evaluate

- Delete migrated TS subsystems; the JS runtime ships only as the
  sidecar host (bun single-binary per sidecar).
- Annual review of remaining sidecars: agent-host (tracks whether a
  non-JS agent runtime appears), userbot (gotd/grammers maturity).

## Position, 2026-09-18 — boundaries before rewrites

Re-read after the cleanup and memory work, with Ada asking whether
TypeScript is the right language for every part. The answer the tree
gives:

**The language question is a per-component question, and the repo
already answers it that way.** Four languages run behind three
fixture-verified boundaries today (`protocol/`: TS daemon, Dart
Companion, Go node; `native/`: Rust warden and fusefs, Zig and Rust
wasm cores, Gleam scheduler core; Lua scripts in wasm). Nothing about
that is accidental — it is the shape to push further.

| Component | Today | Verdict |
| --- | --- | --- |
| Agent host (Claude Agent SDK) | TS, in-process | **Must stay JS** (the SDK is JS). Becomes the `talon-agent-host` sidecar (Phase 2) — crash isolation and a stable `AgentEvent` protocol, whatever the core is written in later. |
| Chat frontends (grammY, discord.js, Baileys, GramJS) | TS, in-process | **Stay TS.** Their JS SDKs are best-in-class with no non-JS peer (Baileys especially). The lever is not their language but their *boundary*: the Companion is already an out-of-process driver over the bridge protocol; the same shape lets any future frontend be any language. |
| Core (weaver, dispatcher, storage, cron, bridge server) | TS | The only thing worth porting, and only once it is small and tree-shaped (docs/structure.md) and Phase 0 says the control plane costs something. Porting a tangle ports the tangle. Go remains the default target for the in-tree precedent. |
| Security / fs (warden, fusefs) | Rust | Right. Anything that must be correct under adversarial input or must touch the kernel lives here. |
| CPU cores (textops, blake3, sqlguard, htmlents) | Zig / Rust wasm | Right. |
| Scheduler core | Gleam → JS | Works, but it is a one-file language island with a build step of its own. Candidate to fold back into TS or into the Go core when the core moves; not before. |
| Mesh node | Go | Right (single static binary per platform). |
| Companion | Dart / Flutter | Right (the only real cross-platform mobile+desktop UI stack). |

**Rule going forward:** a component changes language only when it
crosses a *process* boundary with a fixture-verified protocol (`protocol/`),
and only for one of three reasons — the ecosystem lives there (SDKs),
correctness under hostile input (Rust), or a measured hot path
(Phase 0). "Newer" or "faster in general" is not a reason: Talon is
I/O-bound and its felt slowness has always been architectural.

**Order:** (1) finish the tree contract — a small, tree-shaped core is
the precondition for any port; (2) Phase 0's missing numbers (boot ms,
idle RSS, per-turn CPU) next to the cache metrics that now exist;
(3) Phase 2's agent-host sidecar — the single highest-leverage
structural move, valuable even if the core never leaves TypeScript;
(4) close the Bun checklist (Docker, soak); (5) revisit the Go/Rust
decision with the numbers, not before.

## Risks

| Risk                                           | Mitigation                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Dual-maintenance window freezes feature work   | Phases 2 and 3 are additive (sidecars, shadow daemon); the flip in Phase 4 is per-subsystem with flags |
| `claude-agent-sdk` churns fast                 | Sidecar isolates the churn behind `AgentEvent` — already Talon's internal contract                     |
| Bun compat gaps (napi, node:sqlite edge cases) | Phase 1 checklist + Node fallback entrypoint for one release                                           |
| Session/state format drift (GramJS ↔ gotd)     | Userbot ports last, behind its own sidecar protocol                                                    |
| The rewrite is slower than the original        | Phase 0 baseline + per-phase exit measurements; kill criteria are part of the plan                     |
