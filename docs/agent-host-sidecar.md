# The agent host sidecar — the Claude Agent SDK in its own process

Status: design, 2026-09-18. Phase 2 of `docs/ts-migration-plan.md`, and
the highest-leverage structural move in the language position recorded
there: it pays off whether or not the core ever leaves TypeScript.

## Why

- **Crash isolation.** The SDK hosts Claude Code's runtime: subprocesses,
  MCP children, big transcripts in memory. An OOM or an SDK bug takes the
  whole daemon down with every frontend on it. In its own process it
  takes down one turn, and the daemon respawns it.
- **The boundary the language plan needs.** Once the SDK is behind a
  fixture-verified protocol, "what language is the core" is a question
  about a small thing that talks NDJSON, not about the SDK's host.
- **Independent lifecycle.** The SDK churns fast (`0.3.x` weekly). A host
  binary can be pinned, upgraded and rolled back on its own, and
  bun-compiled separately from the daemon.
- **Memory accounting.** Phase 0's `rss.mb` currently mixes the daemon and
  the SDK; two processes give two honest numbers.

## What makes it small

Two facts about today's code:

1. Talon's own tools already reach the SDK **over HTTP**: `core/mcp-hub/`
   serves them as an MCP server and `backend/claude-sdk/options.ts`
   hands the SDK `mcpServers` URLs per session. A host in another
   process connects to the same hub the same way. **No tool-execution
   RPC is needed.**
2. The daemon already consumes the SDK through one internal contract:
   the `AgentEvent` union in `core/agent-runtime/events.ts` (`run_started`,
   `text_delta`, `assistant_message`, `reasoning`, `tool_call`,
   `tool_result`, `usage`, `model_swapped`, `warning`, `error`,
   `completed`) and the `Backend` capability interfaces in
   `core/agent-runtime/capabilities.ts` (`ChatBackend`, `BackgroundRunner`,
   `ModelCatalog`, `SessionBackend`, `ToolRuntime`, `UsageTelemetry`,
   `SystemControl`). Those are the protocol; nothing new is designed.

So the sidecar is: the `backend/claude-sdk/` code, unchanged, running
behind a NDJSON-over-stdio loop, and a client in the daemon that
implements the same capability interfaces by sending requests and
replaying the event stream.

## Protocol — `protocol/fixtures/agent-host_v1.json`

One JSON object per line, both directions. Every request carries `id`;
every reply carries the same `id`. Turn events carry `runId`.

| Daemon → host | Reply / stream |
| --- | --- |
| `hello { protocol: 1, daemon: version, config: <the claude-sdk slice of TalonConfig> }` | `ready { host: version, sdk: version }` |
| `run_turn { runId, params: ChatRunParams, systemPrompt: SystemPromptParts, chatSettings }` | stream `event { runId, event: AgentEvent }` … `run_done { runId }` |
| `interrupt { chatId }` | `ok { interrupted: boolean }` |
| `one_shot { runId, params: OneShotAgentParams }` | stream as above |
| `warm_session { chatId }` | `ok` |
| `set_mcp_servers { chatId?, servers }` / `refresh_tools` | `ok` |
| `list_models`, `plan_usage`, `session_info { chatId }`, `reset_session { chatId }` | the same shapes the in-process backend returns today |
| `shutdown` | `bye` — the host drains in-flight turns, then exits |
| Host → daemon, unsolicited | `log { level, component, msg }`, `metric { name, value }`, `stderr` is tailed by the supervisor like an MCP child's |

Fixtures: one sample per request and reply, one `event` sample per
`AgentEvent` kind, and the forward-compat rule the bridge protocol already
uses (unknown fields tolerated, unknown message types logged and dropped).
Both sides replay the fixtures through their real codecs in CI.

## Supervision

`core/daemon/sidecar.ts`: spawn, stderr tail, health (`ping` every 30 s;
two misses → restart), respawn with the backoff `core/daemon/respawn.ts`
already implements, graceful `shutdown` on daemon stop. One host process
for all chats — the SDK multiplexes sessions itself and a process per
chat would multiply RSS. A host death mid-turn: every in-flight `runId`
gets an `error` `AgentEvent` (`kind: "host_crashed"`), the Weaver's
existing retry decides, the host respawns, and sessions resume from the
SDK's on-disk transcripts exactly as after a daemon restart today.

## Prompt-cache statement

The host builds the same `query()` calls from the same
`SystemPromptParts`, tools and session ids it builds now; the bytes on
the wire to Anthropic do not change. A host restart is invisible to the
cache (the cache is on Anthropic's side, keyed by prefix). The
`cache.*` metrics from `docs/cache-economics.md` are recorded by the
host and forwarded as `metric` messages, so the rollups are unchanged.

## Phases

1. **Seam.** — **landed, PR #968.** `AgentHostClient` interface in
   `core/agent-runtime/agent-host.ts` with the NDJSON codec
   (`parseHostMessage` / `serializeHostMessage`); the in-process
   implementation in `backend/claude-sdk/host/in-process.ts` wrapping
   today's functions directly; the claude-sdk `BackendFactory` binds
   through it. `protocol/fixtures/agent-host_v1.json` replayed by
   `src/__tests__/agent-host-protocol.test.ts`, which also asserts the
   in-process client yields the same `AgentEvent` sequence
   `runChatTurn` yields directly. No process yet; zero behaviour change.

   Three things the table above did not cover, found while binding the
   real factory — each is Phase 2's to answer:

   - **`evictOrphanSubprocesses(label)`.** A `BackgroundRunner` member
     that force-cleans the SDK's own children after an abort grace
     window. It is host-side by definition and has no request row.
   - **`SystemControl.updateSystemPrompt(prompt)`.** Plugin hot-reload
     pokes the live claude-sdk config through it. That config lives in
     the host once the host is a process, so it needs a row too.
   - **The rest of `ModelCatalog`.** `list_models` covers one of the
     eight members the factory binds; the other seven are daemon-side
     formatting over `core/models/catalog.ts` — a registry that
     `initAgent` (i.e. `hello`) populates from the SDK. So `ready` or
     `list_models` has to carry the raw model list home, or `/model`
     goes empty the moment the SDK moves out.

   Two shapes could not cross the boundary as written, and the wire
   types say so: `OneShotAgentParams` carries an `AbortController` and
   an `appendLog` callback (the wire type is the serialisable subset;
   `appendLog` becomes `log` notices and the abort becomes an
   interrupt), and `warm_session`'s context figures are written into
   the daemon's session store today — hence the `session_info` query.
2. **Host.** `bin/talon-agent-host` — the claude-sdk code behind the
   NDJSON loop; `core/daemon/sidecar.ts`; the process-backed
   `AgentHostClient`. Flag `TALON_AGENT_HOST=process` selects it;
   default stays in-process.
3. **Soak.** Two weeks on Ada's daemon with the flag on: `agent_host.respawns`,
   `agent_host.rss_mb`, `turn.first_token_ms` delta, `cache.first_request.hit`
   unchanged. Then the default flips.
4. **Package.** `bun build --compile` the host on its own; nfpm/Docker
   ship both binaries; the SDK dependency leaves the daemon's
   `package.json`.

Each phase is one PR-sized unit for an Opus agent with this document as
the brief. Phase 1 can start now; it does not depend on the tree work.

## Non-goals

No second protocol for the userbot (that is its own sidecar, later). No
change to how MCP plugin children are supervised. No per-chat hosts.
