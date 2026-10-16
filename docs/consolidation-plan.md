# Consolidation plan

A map of the tree as of 2026-09-02 (v3.32.0) and the ordered worklist that
falls out of it. Companion to [code-health.md](code-health.md), which is
the static/dynamic analysis pass; this is the structural one. Numbers are
from that day's `cloc`, `vitest --coverage`, and `dependency-cruiser`
runs.

## Map

### Size and coverage by area (non-test lines; statement / branch coverage)

| Area | Lines | Cov (stmt / br) | Fan-in | Role |
| --- | ---: | ---: | ---: | --- |
| `core/` | 31,278 | 82–95% | 87 + per-module | Platform-agnostic engine |
| `frontend/` | 25,433 | 25–99% | 22 (shared) | Six chat surfaces |
| `backend/` | 20,478 | 64–91% | 47 (shared) | Five agent backends |
| `storage/` | 6,291 | 92% / 88% | 133 | SQLite repos + stores |
| `util/` | 2,918 | 80% / 81% | 338 | Leaf helpers (+ config, see below) |
| `cli/` | 2,777 | 14% / 21% | — | Composition-root glue |
| `plugins/` | 1,858 | 78% / 69% | 9 | Built-in plugins + provisioning |
| `native/` | 1,427 | 40% / 29% | 20 | WASM/napi bricks with TS fallbacks |
| tests | 86,731 | — | — | 4,640 daemon tests |

Thinnest-covered areas, in the order that matters: `cli` 14% (glue,
exercised end-to-end by integration tests), `frontend/discord` 25%
(handlers 5%), `frontend/native` 39% (the bearer-token bridge — the one
that is a security surface), `native` 40%, `frontend/whatsapp` 46%,
`frontend/telegram` 54%.

### Dependency shape

The architecture gate (`scripts/check-architecture.mjs`) cruises 588
modules and finds **0 errors** against every ratified boundary
(`core-not-to-frontend`, `core-not-to-backend`, `backend-not-to-frontend`,
`frontend-not-to-backend`, `util-is-a-leaf`, `native-is-a-leaf`,
`storage-below-the-engine`, `no-circular`). The 18 warnings are the three
in-flight migrations `.dependency-cruiser.cjs` documents by name.

Heaviest cross-area edges: `frontend/telegram → util` 39,
`frontend/discord → util` 38, `storage → util` 31, `frontend/telegram →
storage` 24, `core/engine → util` 23. Frontends reach `storage` directly
(telegram 24, discord 19, native 9) — the sessions/history/settings stores
are the frontends' data layer as much as the engine's, which is by design
but worth knowing before moving anything.

### Largest files

| File | Lines | Shape |
| --- | ---: | --- |
| `core/mesh/service.ts` | 1,863 | One class; three sections already delimited by comments (device commands, streaming file transfer, node provisioning + pairing) |
| `frontend/native/index.ts` | 1,416 | `createNativeFrontend` is a single 1,260-line closure |
| `frontend/native/server.ts` | 1,101 | `BridgeServer.handle()` is a 430-line `if` chain over ~40 routes |
| `core/engine/gateway-actions/native.ts` | 1,035 | Flat handler table, fine |
| `util/config.ts` | 843 | Engine configuration filed as a leaf util (see migration) |
| `apps/companion` | — | Companion client moved to separate repository (`thefalconry/talos`) |

## Findings, ordered by value over risk

### 1. Dead exports were ungated — done in #820

255 unused exports/types, no gate. Swept to zero, `knip` added to the
Code Quality workflow. Nothing further.

### 2. Kilo and OpenCode were two copies of one backend — #822

`backend/kilo/` (1,498 lines) and `backend/opencode/` (1,331) were
identical after name normalisation except for five knobs: SDK package,
port, delivery contract, stored-model parser, picker limits. The turn
driver, chat-turn orchestration, server wrappers, and factory now live
once in `backend/remote-server/`; each backend is a `RemoteBackendProfile`
plus re-exports. Net −913 lines.

**Left open on purpose:** the model-picker knobs in `*/models/index.ts`
(`maxCallbackIdLength`, `allowCallbackSeparators`, `quickPickLimit`) are
described as "Kilo renders through Discord select menus, OpenCode through
Telegram inline keyboards". Those are frontend constraints filed under a
backend. They should become per-frontend presentation limits the model
catalog reads from the requesting frontend's descriptor; until then a
Kilo user on Telegram gets Discord-sized callback ids.

### 3. Frontend access control and rate limiting are duplicated

`frontend/telegram/handlers/access.ts` (313 lines) + `queue.ts` and
`frontend/discord/handlers/access.ts` (243) carry the same sliding-window
rate limiter (`isUserRateLimited`, identical bodies, one keyed by number
and one by string) and near-identical allowlist / admin / DM-tracking
state. WhatsApp and Teams have their own partial versions.

**Shape:** `core/frontend-runtime/access.ts` — a generic
`createAccessGate<SenderId>({ allowlist, admins, rateLimit })` returning
`isAllowed`, `isAdmin`, `isRateLimited`, `trackDm`. Frontends keep only
the config mapping and the platform-specific "who is the sender" step.
Est. −350 lines, and one place to fix rate-limit semantics.

### 4. The native bridge: a route table, split closure, and tests

The bridge is the security surface (bearer auth, failed-auth lockout,
pre-auth routes `/health` `/pair` `/node/install` `/node/binary`,
transfer-token scoping) and the least-covered frontend after Discord.

- `server.ts` `handle()`: replace the 430-line `if` chain with a route
  table `Map<"METHOD /path", { auth: "none" | "bearer" | "transfer";
  handler }>`. The auth tier per route then *is* the security property,
  and a test can assert it for every route in one loop instead of one
  hand-written request per route.
- `index.ts` `createNativeFrontend`: split the closure along the seams
  its inner functions already mark — chat/queue state (`toQueued`,
  `setQueued`, `liveTurnEvents`, `toClientChat`), the turn runner
  (`runTurn`, `emit*`), and control (`listModels`, `setBackend`,
  `control`, `spawnDaemonRestart`).
- Coverage: `settings.ts` 20%, `extensions.ts` 0%, `index.ts` 4%. Note
  `native-bridge-extensions.test.ts` tests `storage/history`, not
  `frontend/native/extensions.ts`; rename it and write the real one.

### 5. `core/mesh/service.ts` (1,863 lines)

Split along the section comments already in the file: `mesh/transfer.ts`
(the streaming bridge surface, pull/push bytes, `acceptFileUpload`,
`openFileDownload`), `mesh/provision.ts` (`getNodeBinary`,
`makeNodeInstallLink`, `openNodeInstall/Binary`, `updateNodeBinary`,
companion pairing links), leaving `service.ts` as the device
registry + command façade. No behaviour change; the class already
delegates to private methods at those boundaries.

### 6. The three planned migrations in `.dependency-cruiser.cjs`

Already documented there; listed here so the order is explicit.

- **`config-belongs-in-core`** (3 edges, done): moved `util/config.ts` to
  `core/config/`. Mechanical — it imports `core/agent-runtime/model-ref`,
  `core/models/reasoning-levels`, `core/prompt/assemble`; ~100 import
  sites move with it. Ratchet the rule to `error` in the same PR.
- **`doctor-probes-move-behind-registry`** (4 edges): doctor hardcodes
  claude-sdk and codex probes, so kilo, opencode, and openai-agents get
  no doctor checks. Add an optional `doctorChecks()` slot to
  `BackendFactory`; doctor composes whatever is registered.
- **`backend-sessions-move-to-thread`** (10 edges after #822): deferred by
  design per `docs/weaver.md`; do not add importers. Revisit when the
  Weaver gets a write-capable `ThreadSession`.

### 7. Soul kernel — no investment ✅ done

**Done** — torn out in #953; the taps live on in `core/memory/taps.ts`.

`core/soul/` is 4,657 lines at 93% coverage with ten importers
(bootstrap, dream, gateway, prompt assembly, and admin/middleware in
telegram and discord). `docs/memory-persona-plan.md` §2 keeps ~460 lines
and deletes ~4,300 + 26 test files. That is its own rollout; nothing here
should touch soul except to remove it when that lands.

### 8. Companion — retired from monorepo ✅

The Flutter companion client has been retired from this monorepo and now
lives in its own repository: [`thefalconry/talos`](https://github.com/thefalconry/talos).
The daemon mesh protocol in `protocol/` remains the shared contract.

### 9. Test brittleness

`package.functional.test.ts` asserts the spawned CLI's stderr is exactly
empty. Any Node process warning (here: `NODE_USE_ENV_PROXY` making undici
print its experimental-agent notice) fails both cases on a machine where
CI is green. Filter `(node:NNN)` warning lines before the assertion.

## Order

1. #820 — knip sweep + gate. *(merging)*
2. #822 — remote-server unification. *(open, stacked on 1)*
3. Frontend access gate (§3).
4. Native bridge route table + closure split + tests (§4).
5. `config → core/config`, doctor probes via registry (§6).
6. `mesh/service.ts` split (§5).
7. `settings_screen.dart` split (§8).
8. Test brittleness (§9) — rides along with whichever PR touches tests
   next.
