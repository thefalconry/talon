# Frontend SDK — capability contract + registry

> Status: **implemented**. The contract and registry landed as a
> behavior-preserving refactor; every built-in frontend registers through
> it. Plugin-loaded frontends use the same API (see "External frontends"
> below for what still gates them).

## Why

Backends have had a real SDK shape for a while: one `Backend` capability
interface (`core/agent-runtime/capabilities.ts`) and a self-registration
registry (`core/agent-runtime/backend-registry.ts`) — adding a backend is
one `factory.ts`, no bootstrap churn.

Frontends had the interface (the `Frontend` type, formerly in
`bootstrap.ts`) but not the registry. Frontend _identity_ was smeared
across four hand-maintained copies of the same if/else chain:

| Concern                                    | Lived in                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| Creation switch                            | `app.ts` (`switch (name)` over dynamic imports)                                   |
| Dispatch routing (chat id → live frontend) | `bootstrap.ts` `resolveFrontendName`                                              |
| Gateway action routing                     | `core/engine/gateway.ts` `resolveOwnedFrontendName`                               |
| MCP tool scoping                           | `backend/runtime/frontends.ts` `frontendForChatId` + literal `"terminal"` filters |

Adding a frontend meant touching all four, and they could silently drift.

## The model

`core/frontend-runtime/` is the frontend counterpart of
`core/agent-runtime`:

```
capabilities.ts   Frontend (runtime contract: init/start/stop, context,
                  sendMessage/sendTyping, getBridgePort) and
                  FrontendCreate ((config, gateway) → Frontend)
lifecycle.ts      startFrontends(): what a composition root calls to
                  bring them all up and wait for readiness.
run-loop.ts       runUntilStopped(): splits a run-until-stopped loop
                  into "listening" (for start) and "stopped" (for stop).
registry.ts       id → FrontendDescriptor map + chat-id resolution.
                  Self-contained: create functions are stored opaquely
                  so routing-only consumers never import engine types.
builtins.ts       The six built-in descriptors (identity only — no
                  frontend implementation is imported from core).
create.ts         The typed create seam: attachFrontendCreate,
                  registerFrontend (plugin path), createFrontendById.
routing.ts        Import surface for routing-only consumers (gateway,
                  backend MCP scoping) — guarantees builtins are
                  registered without pulling in the create seam.
index.ts          Everything, for composition roots and factories.
```

A **descriptor** is cheap, static identity:

```ts
{
  id: "discord",                    // matches config.frontend entries
  label: "Discord",                 // logs / status output
  ownsChatId: isDiscordChatId,      // chat-id shape convention
  routePriority: 40,                // lower checks first; broad matchers last
  messaging: true,                  // gets a per-frontend MCP tool server
  sharesStdin: false,               // owns the process's stdin (terminal only)
}
```

The **create** half is attached separately by
`src/frontend/<id>/factory.ts`, which dynamically imports the
implementation — an unconfigured frontend costs nothing at boot:

```ts
attachFrontendCreate("discord", async (config, gateway) => {
  const { createDiscordFrontend } = await import("./index.js");
  return createDiscordFrontend(config, gateway);
});
```

`src/frontend/factories.ts` is the side-effect barrel the composition
roots import once.

The split exists for layering: `core/` never imports `frontend/`, so
descriptors register from core while create functions attach from the
frontend layer. Everything that only needs "whose chat id is this?"
works from descriptors alone.

## Lifecycle: `start()` means started, not stopped

`create → init → start → stop`, and the one rule that keeps a
composition root honest:

- **`start()` resolves when the frontend is LISTENING** — Telegram's
  `onStart` (identity fetched, polling up), Discord's `READY`, WhatsApp's
  first socket (or the park that waits for a human to pair), the bound
  bridge server, the drawn terminal prompt. It rejects only if the
  surface never came up.
- **The run-until-stopped loop is the frontend's own business.** A
  long-poll or reconnect loop is kept internally — `runUntilStopped()`
  splits it into `ready` (what `start()` awaits) and `stopped` (what
  `stop()` awaits) — so `stop()` resolving means the loop has ended.

This is not a style point. When `start()` returned the run loop instead,
`await`ing the frontends at boot resolved at _shutdown_: boot metrics
and the resource sampler were armed hours late, the "Ready in …" line
printed a lifetime as a boot time (`Ready in 17796980ms`), and anything
sequenced after the await never ran while the daemon lived.

`startFrontends()` (lifecycle.ts) is what a composition root calls: it
starts every frontend in parallel — terminal included, no special case —
and resolves when they are all listening.

## Routing semantics (preserved from the old chains)

- `resolveOwnerFrontendId(chatId)` — the messaging frontend owning a
  chat id by shape, else null (heartbeat sentinel, one-shots, terminal).
  This is the MCP-scoping flavour (`frontendForChatId`).
- `resolveOwnerFrontendId(chatId, { includeNonMessaging: true })` — full
  routing, terminal included (gateway flavour).
- `resolveFrontendIdAmong(chatId, candidates)` — pick the live frontend
  that serves a chat: single candidate wins; else the owner if
  live; else the first messaging candidate, else the first (bootstrap
  flavour).

Two historical tie-breaks are encoded in `routePriority`: telegram's
numeric matcher accepts almost anything so it runs last (90), and the
terminal claims the legacy chat id `"1"` ahead of telegram (10).

## Adding a built-in frontend

1. Implement `createMyFrontend(config, gateway): Frontend` under
   `src/frontend/my/`.
2. Register the descriptor in `core/frontend-runtime/builtins.ts` (id,
   label, chat-id matcher — add the predicate to
   `core/frontend-runtime/chat-id.ts`).
3. Drop a `factory.ts` beside the implementation and list it in
   `src/frontend/factories.ts`.
4. Add the id to the config `frontendEnum` in `core/config/index.ts`, plus
   a config block and its credential check in `loadConfig`.
5. Expose the tools it implements: add the id to `ToolFrontend`
   (`core/tools/types.ts`), to `VALID_TOOL_FRONTENDS`
   (`core/mcp-hub/talon-server.ts`), to `FRONTEND_TOOLS`
   (`backend/runtime/prompt/delivery-contract.ts`), and to the `frontends: [...]`
   array of every tool in `core/tools/` it can serve. A tool listed for a
   frontend whose action handler doesn't implement it is a tool the model
   will call and get "unknown action" from — gate deliberately.
6. Teach `unconfiguredFrontends` in `core/doctor/index.ts` what "configured"
   means for it; the check is fail-closed, so an unknown id reports as
   broken.
7. Add `prompts/<id>.md` (platform affordances and formatting rules) and
   run `npm run build:prompts`.
8. Add a `LogComponent` entry in `util/log.ts` for its log lines.

Steps 1-4 are all the _registry_ needs; 5-8 are what makes the frontend
actually usable. `src/__tests__/frontend-registry.test.ts` pins the
built-in list, so it fails until the new id is added there too.

No changes to `app.ts`, `bootstrap.ts`, the gateway, or backend scoping.

## External frontends

`registerFrontend({ ...descriptor, create })` registers a complete
frontend at runtime — the intended path for plugin frontends (Slack,
Matrix, …). The registry, routing, creation, MCP tool scoping, and
gateway all handle unknown ids already (the registry tests pin this
with a synthetic `slack` frontend). What still gates a real frontend
plugin:

- the config schema's `frontendEnum` only admits built-in ids;
- the plugin loader has no lifecycle step that imports frontend modules
  before frontends are created;
- per-frontend prompt flavours (`prompts/system/<id>.md`) and the
  `FrontendScope` tool tags are still built-in-only vocabularies.

Those are deliberate follow-ups — the seam they plug into is now one
registry instead of four switch statements.
