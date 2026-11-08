# Protocol conformance

This directory holds the canonical wire **fixtures** for Talon's protocols —
samples each implementation replays through its *real* parsing / serving /
execution paths in its own test suite, so a shape drift on any side fails
that side's CI instead of shipping a silent misrender.

Two protocols live here: the **Bridge Protocol** (daemon ↔ frontends and
mesh devices, three implementations) and the **agent-host protocol** (daemon
↔ the Claude Agent SDK sidecar, two).

## Bridge Protocol

The Talon Client Bridge Protocol has **one definition and three independent
implementations**:

| Implementation | Language | Role | Source |
| --- | --- | --- | --- |
| Daemon | TypeScript | serves the protocol | `src/frontend/native/protocol.ts` (types), `src/frontend/native/bridge/server.ts` (routes) |
| Companion app | Dart | GUI client + mesh device | `apps/companion/lib/src/models/bridge_models.dart`, `state/app_state.dart`, `services/mesh_service.dart` |
| talon-node | Go | headless mesh device | `apps/node/bridge.go`, `apps/node/commands.go` |

`src/frontend/native/protocol.ts` stays the **source of truth** for wire
types. This directory holds the shared **fixtures** — canonical wire samples
each implementation replays through its *real* parsing/serving/execution
paths in its own test suite. A shape drift on any side fails that side's CI
instead of shipping a silent misrender or a device command that times out.

## Fixtures

| File | Contents |
| --- | --- |
| `fixtures/protocol_v1.json` | Static REST shapes: message, chat, status, search result, log entry |
| `fixtures/events_v1.json` | The SSE stream: one sample per `BridgeEvent` kind (a coherent session, in order), plus forward-compat frames that clients must tolerate |
| `fixtures/mesh_v1.json` | The device mesh: registration bodies, device/location shapes, capability lists, one canonical `device_command` per command (with `dataKeys` = the result keys both device kinds must produce), and command-result shapes |
| `fixtures/auth_v1.json` | Per-device credentials (#1042): the credential token format, the in-band upgrade/rotation exchange (`POST /auth/upgrade`), the `credential` hint on the `/devices/register` reply, and `GET /auth/whoami` — plus a forward-compat hint clients must ignore |
| `fixtures/agent-host_v1.json` | The agent-host protocol (see below): one sample per `HostRequest` and `HostReply`, one `event` frame per `AgentEvent` kind as a coherent turn, the `log` / `metric` notices, plus forward-compat frames |

## Where each side asserts the Bridge Protocol

- **Daemon** — `src/__tests__/native-protocol-fixture.test.ts` and
  `src/__tests__/protocol-conformance.test.ts` (vitest, main CI). The events
  fixture is checked for exhaustiveness against the `BridgeEvent` union — a
  new event kind fails compile until a sample is added here. Registrations
  and locations run through the real `MeshRegistry` normalizers.
  `src/__tests__/protocol-auth-fixture.test.ts` replays the auth fixture's
  requests against a live bridge and pins every reply to its shape.
- **Companion** — `apps/companion/test/protocol_fixture_test.dart` and
  `apps/companion/test/protocol_conformance_test.dart` (flutter test,
  companion CI). The event session is streamed over a live SSE connection
  into `AppState`; mesh capability lists are asserted against
  `MeshService.capabilitiesFor`, and the exec/fs commands run through the
  real `DeviceExec` in a sandbox.
- **talon-node** — `apps/node/protocol_conformance_test.go` (go test, node
  CI). Capability parity with `nodeCapabilities` (plus, per platform, a
  subset of `nodeDesktopCapabilities`), SSE `device_command` frame
  decoding, registration body keys, and real `dispatch()` execution of every
  `run: true` command in a sandbox. The auth fixture's upgrade request is
  built by `upgradeRequestBody`, and every register/upgrade reply parses
  through the node's real decoders (unknown credential actions ignored).

The streamed transfer samples (`transfer: true`: `upload_file`,
`download_file`) carry payload digests. The daemon sends the body's `sha256`
with a push and checks the `sha256` a device reports for a pull. The node
and companion suites run both samples against a fake `/devices/file` serving
`transferBody` and check both digests. The daemon suite checks the params it
sends. The digests are additive: a device that reports none is not checked,
and a push without one is written unverified, as before.

## The agent-host protocol

The Claude Agent SDK is moving into its own process
(`docs/agent-host-sidecar.md`). The daemon and that host speak NDJSON over
stdio — one JSON object per line, both directions. Every request carries an
`id` and its reply carries the same one; turn traffic carries a `runId`.
`src/core/agent-runtime/agent-host.ts` is the **source of truth** for the
wire types and holds the codec (`parseHostMessage` / `serializeHostMessage`)
both sides run.

| Daemon → host | Reply / stream |
| --- | --- |
| `hello { protocol, daemon, config }` | `ready { protocol, host, sdk? }` |
| `run_turn { runId, params }` | stream `event { runId, event: AgentEvent }` … `run_done { runId }` |
| `interrupt { chatId }` | `ok { interrupted }` |
| `one_shot { runId, params }` | stream as above, then `run_done { runId, usage? }` |
| `warm_session { chatId }` | `ok` |
| `set_mcp_servers { chatId, servers }` / `refresh_tools { chatId }` | `ok { tools }` — `null` when the chat has no live query |
| `list_models { filter? }` | `models { models, total }` |
| `plan_usage` | `usage { usage }` |
| `session_info { chatId }` | `session { session }` |
| `reset_session { chatId }` | `ok { cleared }` |
| `shutdown` | `bye` — the host drains in-flight turns, then exits |
| Host → daemon, unsolicited | `log { level, component, msg }`, `metric { name, value }` |
| Anything the reader does not know | parses to a typed `unknown` result it logs and drops — never a throw |

Implementations:

| Implementation | Language | Role | Source |
| --- | --- | --- | --- |
| Daemon | TypeScript | holds an `AgentHostClient` | `src/core/agent-runtime/agent-host.ts` (types + codec) |
| In-process host | TypeScript | calls `backend/claude-sdk/` directly | `src/backend/claude-sdk/host/in-process.ts` |

`bin/talon-agent-host` — the process-backed third implementation — is Phase 2
and replays this same fixture from the other side.

**Where it is asserted** — `src/__tests__/agent-host-protocol.test.ts`
(vitest, main CI). Every fixture sample round-trips through the real codec;
the `requests` / `replies` / `notices` / `events` arrays are checked for
exhaustiveness against the unions (adding a member without a sample fails
compilation); the forward-compat frames must parse to `unknown` (new type) or
survive intact (new field); and the in-process client is driven through a
stubbed SDK turn and must yield the same `AgentEvent` sequence `runChatTurn`
yields when called directly.

## Evolving the protocol

1. Change `src/frontend/native/protocol.ts` (bump
   `BRIDGE_PROTOCOL_VERSION` only on a breaking change — prefer additive).
2. Update the fixture(s) here with a canonical sample of the new shape.
3. Run all three suites; fix what fails. New `BridgeEvent` kinds and new
   device commands are *forced* through this step by the exhaustiveness
   checks; new optional fields should be added to the samples by hand.
4. Clients must keep tolerating unknown kinds/fields (`forwardCompat` in
   `events_v1.json` pins that behavior).

The agent-host protocol evolves the same way, against
`src/core/agent-runtime/agent-host.ts` and `AGENT_HOST_PROTOCOL_VERSION`.
Adding a message type or an `AgentEvent` kind without a sample in
`agent-host_v1.json` fails to compile, so step 2 is not optional there.

Changes under `protocol/` trigger all three CI suites (see path filters in
`.github/workflows/node.yml` and `companion.yml`; main CI always runs).
