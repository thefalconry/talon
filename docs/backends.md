# Backends

Talon's `core/` is backend-agnostic. The active model provider is
selected via `backend` in `~/.talon/config.json`, and every backend
composes the same `Backend` capability interface from
[`src/core/agent-runtime/capabilities.ts`](../src/core/agent-runtime/capabilities.ts).
Heartbeat, dream, `/model`, `/settings`, `/status`, plugin hot-reload,
etc. work identically against any backend.

## Available backends

| `backend` value    | Label         | SDK                              | Transport                                     |
| ------------------ | ------------- | -------------------------------- | --------------------------------------------- |
| `"claude"`         | Anthropic     | `@anthropic-ai/claude-agent-sdk` | Per-query subprocess (the `claude` CLI)       |
| `"kilo"`           | Kilo          | `@kilocode/sdk`                  | Local HTTP server (one process, SSE-streamed) |
| `"opencode"`       | OpenCode      | `@opencode-ai/sdk`               | Local HTTP server (one process, SSE-streamed) |
| `"codex"`          | Codex         | `@openai/codex-sdk`              | Per-turn subprocess (the `codex` CLI)         |
| `"agy"`            | Antigravity   | none — the `agy` CLI direct      | Long-lived per-chat subprocess (headless NDJSON) |
| `"openai-agents"`  | OpenAI Agents | `@openai/agents`                 | In-process (Responses API or any OpenAI-compatible endpoint) |

## Shared infrastructure

### `backend/runtime/` — backend-agnostic helpers

The library every backend builds on. `index.ts` is its barrel; the
modules group into `turn/` (what a turn does once the SDK loop is
running), `prompt/` (the text handed to the model) and `cache/`
(prompt-cache telemetry), with the cross-cutting vocabulary at the root.

Every backend uses these:

- `turn/stream-state.ts` — accumulator for text deltas, tool calls,
  delivered-text norms, synthetic-error markers.
- `turn/delivery.ts` — `routeDelivery` decides between
  `tool` / `synthetic-error` / `text-part` / `empty` at end of turn.
- `prompt/delivery-contract.ts` — per-backend response-flow contract
  built from `prompts/system/contract-*.md` templates, plus the
  frontend-aware flow-violation reminder and first-turn nudge.
- `turn/flow-violation.ts` — detect trailing prose without delivery tool
  call, build the synthetic re-prompt.
- `metrics.ts` — the shared metric vocabulary (`tool_calls.*`,
  `queries_total`, per-turn histograms, `backend.<id>.*` dimensions).
  Backends never call `incrementCounter` for these directly.
- `prompt/prompt-format.ts` — `[YYYY-MM-DD HH:MM:SS] [Name] [msg_id:N]`
  prefix on user prompts.
- `prompt/system-prompt.ts` — per-session frozen prompt snapshots +
  per-backend suffix join (assembly itself lives in `core/prompt/`).
- `frontends.ts` — `nonTerminalFrontends` config normaliser.
- `turn/model-retry.ts` — classify retryable errors into reset /
  fallback / bubble decisions.
- `session-name.ts` — first-message → short session title.
- `usage.ts` — cache-hit % + log summariser.
- `cache/cache-telemetry.ts` + `cache/cache-metrics.ts` — the per-turn
  cache verdict, tool fingerprint and lookback risk, and the counters
  they roll up into.
- `turn/turn-phases.ts` — the post-stream phases every handler runs after
  its SDK loop: `accountTurn` / `accountFailedTurn` (metrics + session
  usage + session id), `nameSessionFromFirstMessage`,
  `enforceTrailingProse` (the tool-only contract + flow-violation retry
  decision), and `finishCallbackTurn` (the summary log lines +
  `QueryResult`).
- `turn/result-events.ts` — `buildResultEvents`, the `usage` +
  `completed` pair every chat-turn stream ends with; dependency-free so
  `turn/handler-to-events.ts` stays a pure adapter.

### `backend/remote-server/` — for HTTP-server backends (Kilo, OpenCode)

Kilo and OpenCode both wrap forks of the same upstream HTTP agent
server, so their MCP / session / provider plumbing is shared:

- `client.ts` — narrow `RemoteAgentClient` interface that both
  `OpencodeClient` and `KiloClient` structurally satisfy.
- `state.ts` — per-backend mutable state container.
- `lifecycle.ts` — lazy-spawn + reuse-existing-server probe.
- `mcp.ts` — chat MCP server registration, visibility rotation
  (disconnect rival chat servers before adding the current one — the
  upstream's permission rules only block execution, not visibility),
  plugin server registration.
- `sessions.ts` — `ensureRemoteSession` with the standard permission
  ruleset.
- `session-helpers.ts` — message parsing, usage summary, snapshot
  construction, pending-question rejection.
- `providers.ts` — `resolveProviderID` walking the provider catalog.
- `events.ts` — SSE event processor (`processStreamEvent`,
  `finalizePartsIntoState`).
- `one-shot.ts` — shared heartbeat/dream runner; each backend binds
  its server bootstrap, model-selection parser, and delivery suffix.
- `server-bindings.ts` — `bindRemoteServer(profile)`: the helpers above
  closed over one backend's state. A `RemoteBackendProfile` is the whole
  per-backend seam: SDK client/server constructors, loopback port (and
  its override env var), delivery contract, and the stored-model parser.
- `turn.ts` — `runRemoteTurn`: the SSE-first turn driver (subscribe,
  `promptAsync`, await close, read the authoritative parts list).
- `chat-turn.ts` — `runRemoteChatTurn`: the chat-turn orchestration
  (model/provider resolution, session + MCP setup, prompt pair, turn,
  post-turn accounting, delivery routing).
- `factory.ts` — `createRemoteBackendFactory`: the registry factory
  composition shared by every member of the family.
- `profiles/bind.ts` — `bindRemoteProfile(definition)`: server bindings
  + catalog + model provider + chat handler + one-shot runner +
  session snapshots, all closed over one profile's state. The result is
  a `RemoteBackendFactoryInputs`, so `backend/builtins.ts` registers it
  straight through `createRemoteBackendFactory`.
- `profiles/kilo.ts`, `profiles/opencode.ts` — the two drivers. Each is
  a `RemoteProfileDefinition`: SDK client/server constructors, loopback
  port and its override env var, delivery contract, stored-model parser,
  and the model-picker budget.

A member of this family is therefore one file of constants. There is no
per-backend directory, and no per-backend turn, handler, catalog or
session code left to drift.

Codex and Claude SDK don't use this — they wrap different transport
shapes.

## The Backend capability interface

Every backend's factory composes a `Backend` object via
`composeBackend(...)` from
`core/agent-runtime/capabilities.ts`. Capabilities are explicit
slots, not optional methods on a fat interface — consumers read
presence directly (`backend.chat?.…`) and degrade gracefully when a
slot is absent:

```typescript
interface Backend {
  id: BackendId;
  label: string;
  cacheMetrics: CacheMetricsSupport;
  chat?: ChatBackend;          // runChatTurn → AsyncIterable<AgentEvent>
  background?: BackgroundRunner; // runOneShotAgent (heartbeat / dream / triggers)
  models?: ModelCatalog;       // resolution core + optional picker surface
  sessions?: SessionBackend;   // resetChat / warmSession
  tools?: ToolRuntime;         // refreshTools (plugin hot-reload)
  usage?: UsageTelemetry;      // getSessionSnapshot (/status enrichment)
  control?: SystemControl;     // updateSystemPrompt
}
```

`background.runOneShotAgent` is what makes heartbeat + dream work
across all backends — each backend's `one-shot.ts` translates the
runtime events into Markdown-flavoured run-log entries.

### `core/mcp-hub/` — MCP over HTTP for every backend

All MCP servers are served by the daemon's MCP hub on the gateway
HTTP server (streamable HTTP), and every backend connects with its
SDK's HTTP/remote transport instead of spawning stdio subprocesses:

- `/mcp/talon/<frontend>/<chatId>` — Talon's own tool set, composed
  **in-process** (`talon-server.ts`); the per-chat binding travels in
  the URL rather than `TALON_CHAT_ID` env. Zero subprocesses.
- `/mcp/plugin/<serverName>/<chatId>` — external plugin / brave
  servers, proxied (`proxy-server.ts`) to hub-owned stdio children
  (`children.ts`) that are shared across sessions, reaped after an
  idle TTL (`TALON_MCP_HUB_IDLE_MS`, default 10 min), and *retired*
  on plugin reload — in-flight tool calls drain on the old process
  while new calls spawn fresh from the reloaded registry.

Before the hub, each backend spawned its own copy of every MCP server
per chat (claude-sdk/codex per turn; openai-agents and kilo/opencode
per chat, held indefinitely) and daemon memory grew linearly with the
number of chats.

## Backend-specific notes

### Claude SDK

Spawns the `claude` CLI as a subprocess per turn via
`@anthropic-ai/claude-agent-sdk`. MCP servers are passed in
`Options.mcpServers` as `type: "http"` hub URLs.
Turn termination via `PostToolBatch` hook + `continue: false` returns.

Requires the `claude` CLI on `PATH` and ChatGPT auth (or
`ANTHROPIC_API_KEY`).

### Kilo

Spawns one long-lived `kilo serve` HTTP server (default port 4097)
via `@kilocode/sdk`'s `createKiloServer`. MCP servers registered
via `oc.mcp.add()`. Turns driven by `session.promptAsync` + SSE
events from `oc.global.event()`. Turn termination via
`oc.session.abort()` when a terminator tool fires.

Free-tier models accessible without auth; routed models use Kilo's
own credentials.

### OpenCode

Same shape as Kilo (Kilo is a fork). One long-lived `opencode serve`
HTTP server (default port 4096) via `@opencode-ai/sdk`. Same MCP
wiring, same SSE event loop, same session lifecycle — literally the
same code: both are `bindRemoteProfile` profiles under
`backend/remote-server/profiles/`. What differs is the SDK package, the
port, the delivery contract (Kilo: text-or-tools; OpenCode:
text-preferred), the stored-model parser (Kilo honours a `kilo/` prefix;
OpenCode splits `provider/model` fuzzily), and the model-picker budget
(Kilo renders through Discord select menus, OpenCode through Telegram
inline keyboards).

### Codex

Per-turn subprocess via `@openai/codex-sdk`. Each `runStreamed`
spawns the `codex` CLI from `@openai/codex`. MCP servers configured
at thread-creation time via `--config mcp_servers.<name>...` TOML
overrides (Codex doesn't have a runtime `mcp.add` API).

Talon caches the `Codex` instance by chat id so per-chat MCP
isolation works despite the configure-at-startup constraint;
switching chats rebuilds the instance.

Requires the `codex` CLI from `@openai/codex` and Codex auth:
ChatGPT OAuth via `codex login`, or API-key billing via
`CODEX_API_KEY`, `TALON_CODEX_KEY`, or `codexApiKey`. Talon's shared
`OPENAI_API_KEY` / `openaiApiKey` values are last-resort fallbacks only;
they do not override a `codex login` auth file, so other backends can
keep OpenAI-compatible endpoint credentials without hijacking Codex.

### Antigravity (agy)

Google's Antigravity CLI, driven in
[headless mode](https://antigravity.google/docs/cli/headless). There is
no SDK: Talon speaks the CLI's stdin/stdout protocol directly.

**Transport.** One long-lived child per chat, spawned lazily:

```
agy --input-format stream-json --output-format stream-json \
    --dangerously-skip-permissions --print-timeout 0s \
    --model <id> [--effort low|medium|high] \
    [--conversation <id>] --add-dir <workspace>
```

Each turn writes one `{"event":"user","message":{"content":"…"}}` line
to stdin and reads events off stdout until that turn's `result`. The
process stays warm between turns (the CLI's docs call this
"significantly faster than repeated `--continue` commands"), is
idle-reaped after 10 minutes, and is killed on `/reset`, tool refresh
and shutdown. Diagnostics — including the `authentication required`
error — go to **stderr**, never stdout.

**Turn termination.** A turn in a stream-json process cannot be
cancelled in-flight, so when a delivery tool fires the terminator
Talon kills the child; the next turn respawns it with
`--conversation <id>` and the conversation continues. The kill is
routed through the same clean-close path a Codex abort takes, so it
settles as a completion rather than an error.

**MCP.** agy reads its servers once at startup from the single shared
file `~/.gemini/config/mcp_config.json` — which also holds the user's
own entries. Talon therefore writes only keys prefixed
`__talon__<scope>__`, through an atomic read-modify-write that
preserves every foreign key byte-for-byte, and deletes the tool-schema
snapshot directories (`~/.gemini/antigravity-cli/mcp/<name>/`) the CLI
leaves behind on removal. Stale `__talon__*` entries from a previous
boot are pruned at init. Both paths are injectable via
`TALON_AGY_MCP_CONFIG` / `TALON_AGY_MCP_SNAPSHOT_DIR`.

Every MCP tool reaches the model through ONE generic native tool,
`call_mcp_tool`, with parameters `{ServerName, ToolName, Arguments}`.
Talon unwraps it, so metrics, the terminator logic and the frontends
all see `end_turn` / `send` / `check_time` like any other backend.

**Models.** `agy models` prints `id<TAB>label`; the catalog is parsed
at init and behind a 10-minute TTL. Effort is baked into most ids
(`gemini-3.8-flash-high|medium|low`), so a requested level first
re-points the model at the sibling slug carrying that suffix and is
then also passed as `--effort` — see `backend/agy/effort.ts` for the
precedence. Default model: `gemini-3.8-flash-high`.

**System prompt.** No flag exists. The assembled prompt is prepended
as a fenced block on the FIRST turn of a conversation only; resumed
conversations inherit it (the same thing codex does).

**Usage.** `result.usage` is cumulative over the session in
stream-json mode, so a turn's cost is the delta against the previous
result. `thinking_tokens` is a subset of `output_tokens`, never added
to it. Cache reads are reported, cache writes are not — hence
`cacheMetrics: "read"`.

**Plan usage.** There is no account API, but the `/usage` slash command
runs headlessly: `agy -p /usage --output-format text` prints one
tab-separated line per quota window — model group, window, percent
*remaining*, reset time — and exits without a model call.
`getPlanUsage` spawns that (same binary resolution and env as the chat
children, 20s timeout), flips remaining into used, and labels the
windows `Gemini · 5h`, `Gemini · 7d`, `Claude/GPT · 5h`,
`Claude/GPT · 7d`. The result is cached for 60s with concurrent callers
sharing one spawn, and a failed read backs off 15s and serves the last
good value — or `undefined`, so headroom falls back to the
`backendBudgets` ledger.

**Live check.** `npx tsx scripts/agy-live-check.ts` runs the whole
stack against the real binary and a running daemon: it writes one hub
server into the real `mcp_config.json`, spawns the process layer, asks
the model to call `check_time` over MCP, asserts the tool surfaced
unwrapped, and puts the config back exactly as it found it.

**Auth.** Consumer Google OAuth, cached at
`~/.gemini/antigravity-cli/antigravity-oauth-token` by a one-time
interactive `agy` run. No API key exists; that subscription-backed
path is the point of the backend. `docker/agy-test/` documents why
this makes an unattended CI harness impossible.

## Plan-aware routing

Background work — `spawn_agent` sub-agents, cron `query` jobs, the
heartbeat — used to run on whichever backend the chat happened to be
using. On an install with more than one subscription that is a good way
to burn one plan to its ceiling while another sits idle, so when nothing
is pinned Talon now picks the backend with the most **headroom**.
Headroom is `1 - (tightest rate-limit window)` where a backend reports
its own plan (Claude, Codex, `agy`), and `1 - used/budget` against a
local rolling token ledger where it does not (`openai-agents`, or `agy`
when its `/usage` read fails) — see `config.backendBudgets`. A backend with neither reports "no usage
signal" and ranks below any measured backend it ties with. Every
decision is logged under the `router` component with all the candidates
it saw, and `/usage`, `/status`, `plan_usage` and `list_backends` all
show the same figures.

A pin always wins: an explicit `backend` on a spawn, a `provider` on a
cron job, `heartbeatBackend` — and an explicit **model**, since a model
id is backend-specific and naming one pins the backend that understands
it. Routing is what happens in the absence of a choice, never over one,
and `"router": { "enabled": false }` turns it off entirely. Two rules
are worth knowing: the ceiling (`ceilingPercent`, 85) is applied before
any task-class preference, so "reasoning runs on Claude" cannot send
work to a spent plan; and routing never boots a cold provider to measure
it, so a backend joins the rotation once it is running (bound to a role
or serving a chat) or once you give it a `backendBudgets` entry.

A backend that isn't working is routed around. If its runs fail
repeatedly (3 in a row), or fail on a credential (401, expired login),
a breaker opens and it scores zero headroom for a cool-off period. The
cool-off starts at 15 minutes and doubles each time the breaker re-opens,
up to 4 hours. The same happens while its usage endpoint reports a rejected login. A
backend with no usage signal at all scores zero too: it still takes work
when nothing measured is available, but it is never preferred over a
backend that can show it has room.

## Adding a new backend

1. Create `src/backend/<name>/` with at minimum:
   - `factory.ts` — calls `registerBackend({ id, label, init })`.
   - `handler.ts` — implements `handleMessage(params: QueryParams)`.
   - `index.ts` — barrel.

2. The factory's `init` is called once at startup and returns a
   `Backend` composed via `composeBackend(...)`. Wire in as many of
   the capability slots as your SDK supports; `core/` falls back
   gracefully when a slot is missing. Implement `doctor(config,
   isActive)` too — `talon doctor` composes each backend's own binary /
   auth / catalog checks off the registry and knows nothing about any
   backend itself, so a factory without the slot is reported as having
   nothing to check.

3. Add `await import("./<name>/factory.js");` to
   `backend/builtins.ts` — the one list bootstrap, `talon doctor`, and
   the registry tests all load.

4. Add `"<name>"` to `BACKEND_IDS` in
   `src/core/agent-runtime/model-ref.ts` — the config `backend` enum is
   built from it, so config validation accepts it.

5. Wire shared infrastructure where it helps. If your backend wraps
   an OpenCode-shaped HTTP server, it is a `RemoteProfileDefinition`:
   copy `backend/remote-server/profiles/opencode.ts`, change the
   fields, and register it from `backend/builtins.ts` — step 3 above
   is the profile list, not a factory module. If it spawns a
   subprocess, study the Codex pattern in `backend/codex/`.

6. Update the README's Backends section + this doc.

7. Add tests:
   - Unit tests for backend-specific helpers (`models.ts`,
     `mcp-config.ts`, etc.).
   - A factory wiring test (mock the SDK, assert the composed
     `Backend` has the expected capability slots).
   - If you wrap a CLI: a Docker harness under `docker/<name>-test/`
     for live verification.

8. Verify it through the backend-registry-parity test —
   `src/__tests__/backend-registry-parity.test.ts` expects all
   backends to register with non-empty labels + init functions.

## Backend conformance tests

`src/__tests__/backend-conformance.test.ts` exercises the shared
infrastructure (`processStreamEvent`, `finalizePartsIntoState`,
`routeDelivery`) with hand-built event sequences and asserts that
multiple backends produce identical state mutations / route
decisions. This catches drift between backends in the shared layer
without requiring a real upstream server.
