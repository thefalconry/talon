# Plugin memory: why it scales with agents, and what to do about it

> **Update 2026-09-30.** The first part of this document is the 2026-09-25
> snapshot. Since then, plugin servers run under the MCP hub
> (`src/core/mcp-hub/`). A week of daemon logs (Sep 23-30) shows the
> problem is still there in a new shape. See
> [Measured on the hub](#measured-on-the-hub-2026-09-30) and
> [Plan](#plan-2026-09-30) at the end.

Written 2026-09-25 after the sub-agent cap conversation. Measurements are from
the production VPS (7.7 GB RAM, 4 cores, 8 GB swap) while two sub-agents and
one chat turn were live.

## The measurement

- 63 MCP server processes, **4.7 GB resident**, all children of the daemon.
- Each `claude` model process: ~310 MB.
- Four copies each of firecrawl, email, playwright, fli; eight of whois.
- Average MCP server: ~75 MB. Range ~55 MB (small node CLIs) to ~155 MB
  (`npm exec @bharathvaj/whois-mcp`, which pays for an npm wrapper process on
  top of the server itself).

So a sub-agent does not cost 310 MB. It costs 310 MB plus a private fleet of
~20 plugin servers, i.e. **~1.5-1.8 GB**. Twenty concurrent agents is not 6 GB
of models, it is 30 GB of plugins.

This is by design rather than a leak: `core/agents/context.ts` grants every
background run "the full cross-surface tool set: frontend tools plus every
loaded plugin", and a sub-agent context qualifies.

## The shape of the problem

MCP stdio servers are *per-client processes*. The daemon's cost is therefore
`sessions × plugins`, and every axis we want to grow (more agents, more
frontends, more plugins) multiplies against every other. Nothing about the
work being done requires that: an agent auditing Dart code uses `bash`,
`read`, `grep` and nothing else, while paying for a Playwright browser, a
flight-search Python process and two prediction-market clients.

Three independent levers: **how many** servers exist, **how big** each one is,
and **how long** each one lives.

## Options, cheapest first

### 1. Drop the wrapper processes (hours, no design risk)

`npm exec @bharathvaj/whois-mcp` spawns npm, which spawns node. The npm
process is pure overhead — ~55 MB each, eight copies live at measurement time,
~440 MB for nothing. Resolve the binary once at install/registration time and
spawn it directly. Same for any plugin configured as `npx -y ...`.

Pure win, no behaviour change, no protocol work.

### 2. Lazy activation (days, moderate risk)

Do not start a server until a tool from it is first called.

The blocker is that we need the tool *names* to advertise, and today that
means starting the server and asking. But the deferred-tool mechanism already
means the model does not receive schemas up front — it searches a name list.
So cache what a server reported last time in a manifest (`plugins.lock.json`:
server id, version, tool names, config hash), refresh it in the background
once per daemon start rather than once per session, and invalidate on version
or config change.

Cost: one cold start (~0.5-2 s) the first time a session touches a plugin.
Benefit: idle sessions pay nothing, and most sessions are idle for most
plugins. This helps the main chat as much as it helps agents.

Sharp edge: servers whose tool list depends on runtime state (the ssh plugin
enumerates configured hosts). The manifest must be refreshable, and a tool
call that turns out not to exist has to fail cleanly rather than confusingly.

### 3. Idle eviction (days, low risk)

Shut a server down after K minutes without a call, restart on next use. Pairs
naturally with lazy activation — together they make steady-state memory track
*actual* usage instead of *possible* usage. Without eviction, a long chat
still accumulates the full fleet eventually.

K wants to be long enough that a conversation doesn't thrash (10 minutes?) and
short enough that a finished agent's fleet doesn't outlive it.

### 4. Scope tools per run (days, low risk, best side effects)

`spawn_agent` takes a plugin allowlist; the default for a sub-agent is native
tools only (bash, read, write, edit, grep, glob) plus the reporting tools.
Anything else is opt-in in the spawn call.

Three benefits, only one of which is memory:
- ~1.5 GB → ~310 MB per agent, which makes a cap of 20 honest.
- A smaller tool surface measurably improves agent behaviour; twenty
  irrelevant tools is twenty chances to do something silly.
- **Least privilege.** An agent that never loads the mesh or email plugins
  cannot be talked into using them by something it reads. This is the same
  lever the security review is looking at from the other side.

### 5. Shared fleet for stateless servers (weeks, real risk)

One process per plugin for the whole daemon, with a router multiplexing
clients: map request ids per client, fan notifications out, handle
`initialize` per virtual session.

Works cleanly for stateless tool servers (whois, brave, ccusage, fli,
currency/weather/time). Does *not* work for stateful ones — Playwright owns a
browser, ssh owns connections, anything with a session or a cursor. So it
cannot be a global switch: it needs a `shared: true` flag per plugin,
defaulting to false, opted into per server after checking its behaviour.

Best steady-state number of all the options, and the most ways to go wrong:
one crashed shared server takes out every session at once, and cross-session
state leakage is a security bug rather than a performance bug.

### 6. In-process hosting for node servers (weeks)

Most servers are node CLIs paying for their own V8 heap (~60-95 MB). Several
could be imported into one node/bun worker and spoken to over in-memory
transports instead of stdio. Saves a heap per server, at the cost of losing
crash isolation and inheriting their dependency conflicts. Interesting for the
handful of small first-party ones, not for third-party code.

### 7. Consolidate the tiny ones (ongoing)

whois, fli, currency, weather, time are each a whole process wrapping what is
essentially one HTTP call. A single "utilities" plugin implementing them
directly would delete five processes outright. Less architecture, more
gardening, but it is ~300 MB of gardening.

### 8. Admission control and budgets (hours, high value for stability)

Independent of all the above: refuse a spawn when free RAM+swap is below a
threshold, with an error that says so. Today `agents.maxConcurrent` is a
number someone guessed; the machine's actual limit is memory, and the number
lies whenever the box is busy with something else. A memory-aware check lets
the cap be 20 without pretending 20 always fits.

Worth pairing with a per-server memory ceiling so one leaky plugin cannot OOM
the daemon — the fattest process on the box is currently the daemon itself,
which means the kernel reaps *Talon* when something else goes wild.

### 9. Measure it continuously (hours)

`talon doctor --memory`: RSS per plugin, per session, sorted. Without it,
every one of the above is argued from a single snapshot. With it, regressions
are visible and the effect of each change is checkable rather than asserted.

## Recommended order

1. Kill the npm-exec wrappers (#1) and add the memory reporting (#9). Hours,
   no risk, and #9 makes everything after it measurable.
2. Scope tools per agent (#4). Biggest single win for the thing that prompted
   this, and it improves agent quality and least-privilege at the same time.
3. Admission control (#8), so the cap stops being a guess.
4. Lazy activation + idle eviction (#2, #3). The structural fix; helps every
   session, not just agents.
5. Shared fleet (#5) only if the numbers after 1-4 still hurt, and only
   opt-in per plugin.

Consolidation (#7) and in-process hosting (#6) are opportunistic; do them when
touching those plugins anyway.

## The honest caveat

7.7 GB with a browser, a mesh service, a daemon and a model process resident
is a small machine for this workload. Every item above is worth doing on its
own merits — they make the system lighter, safer and more predictable
everywhere it runs, including on a self-hoster's Pi. But if the goal is
"twenty agents at once", the architecture work buys maybe 5-6× and the
remaining gap is RAM. Both conversations are real; neither substitutes for the
other.

## Measured on the hub (2026-09-30)

Source: daemon logs and process samples from the production VPS,
2026-09-23 to 2026-09-30.

- **111 MCP launcher processes** live at the peak, **~2 GB resident plus
  ~1.6 GB in swap**. The daemon itself was at **2.4 GB RSS**, and the load
  average hit **15** on a 4-core box.
- **~16 children per context.** The hub shares children per *key*, and the
  key for every plugin except brave-search is `name + chatId`
  (`childKey()` in `mcp-hub/index.ts`). Plugins read `TALON_CHAT_ID` at
  boot, so they cannot be shared as written. Each chat, each sub-agent
  (its own `agent:*` context id) and the heartbeat therefore gets its own
  full fleet of ~16 servers. The 10-minute idle reaper
  (`TALON_MCP_HUB_IDLE_MS`) bounds how long a fleet lives, not how many
  exist at once. A burst of agents is a burst of fleets.
- **Fleets are spawned by listing, not by use.** A backend's MCP client
  connects to every configured server at session start and calls
  `tools/list`, which forces a child spawn. A context that never calls a
  plugin still pays for all of them until the reaper catches up.
- **The stall on 2026-09-23 00:11.** Under that memory pressure the daemon
  stopped answering long enough for the launchers' bridge watchdog to see
  the gateway as *unreachable* for 60 s (`BRIDGE_FAILURES_BEFORE_EXIT` = 4
  pings × 15 s). **Every child shut itself down at once: 417 child exits.**
  The next request on every context respawned its fleet from cold, which
  is the worst moment to do it. The watchdog was designed for "Talon is
  gone" (kilo/opencode holding stdin open across a restart). Hub children
  are the daemon's own stdio children, and stdin EOF already covers that
  case.
- **No per-child visibility.** The resource sampler records the daemon's
  own `rss.mb` and heap. It records nothing per child and no event-loop
  lag, so none of the numbers above came from Talon itself.

## Plan (2026-09-30)

Ordered by value per unit of risk. Each step is independently shippable.

1. **Measure first: RSS and lag logging (hours).** Extend
   `core/daemon/resource-sampler.ts`:
   - sample each hub child's RSS (`/proc/<pid>/statm`, keyed by server
     name and context kind: chat / agent / heartbeat) and log the top N
     plus the total whenever the total crosses a threshold;
   - add event-loop delay (`perf_hooks.monitorEventLoopDelay`) as a
     histogram, so a stall like 00:11 shows up as a number rather than a
     guess;
   - surface both in `/status` and `talon doctor`.
   Every later step is checked against this.
2. **Tolerant watchdog (hours).** A hub child should not kill itself
   because the gateway is slow or briefly unbound while its parent is
   alive. In the launcher, treat "unreachable" as fatal only when the
   owning daemon is gone: the parent pid has changed, or
   `TALON_DAEMON_PID` (stamped at boot since the single-instance-guard
   fix) is dead. While the owner is alive, log and keep serving. Stdin
   EOF stays the primary exit signal. This removes the mass exit and the
   cold-respawn storm behind it.
3. **Lazy start (days).** Answer `tools/list` from a per-server manifest
   (tool names and schemas cached from the last live child, invalidated
   on plugin version, config hash or reload). Spawn the child only on the
   first `tools/call`. Servers whose tool list depends on runtime state
   (ssh hosts) keep a refreshable manifest, and a call to a tool that has
   disappeared fails with a clear error. On its own this turns "fleet per
   context" into "the servers a context actually used".
4. **Shared stateless children (days).** Extend `childKey()` beyond
   brave-search with a per-plugin `shared: true` flag, opted into per
   server after checking it keeps no per-chat state (whois, fli,
   currency, weather, time, ccusage). For servers
   that need the caller's identity, pass it per call (request `_meta` or
   a hub-injected argument) instead of reading `TALON_CHAT_ID` at boot.
   Stateful servers (playwright, ssh, email sessions) stay per-context.
   Most of the ~16-per-context fleet is stateless, so this step alone
   should cut the child count by roughly an order of magnitude.
5. **Global cap with LRU eviction (days).** A hub-wide ceiling on live
   children (configurable, sized from RAM, e.g. 40 on this box). At the
   cap, evict the least-recently-used *idle* child. If none is idle,
   queue the spawn briefly, then fail the call with an explicit "plugin
   capacity reached" error. Never OOM the daemon.
6. **Context-aware reaping (hours).** Retire an agent's or heartbeat's
   keys as soon as that run settles rather than waiting 10 idle minutes.
   Chats keep the idle TTL. Finished sub-agents currently leave their
   whole fleet resident for 10 minutes each.

Steps 1, 2 and 6 are small and safe and should land first. 3 and 4 are
the structural fix. 5 is the backstop that keeps the worst case bounded
whatever the other steps miss. The earlier recommendations (drop npm-exec
wrappers, scope tools per agent, admission control) still stand. Scoping
tools per agent is complementary to step 4: an agent that doesn't load a
plugin doesn't need a shared or a private copy of it.
