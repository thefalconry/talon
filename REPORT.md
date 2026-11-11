# Kimi Backend Adapter Implementation Report

## 1. Executive Summary

Implemented a production-ready `kimi` backend adapter for the Talon agent daemon, wrapping Moonshot AI's Kimi Code CLI (`@moonshot-ai/kimi-code` v2.0.2). The adapter mirrors the architectural layout, conventions, and error-handling semantics of Google's Antigravity adapter (`src/backend/agy/`).

All verification suites pass cleanly:
- `npx tsc --noEmit` exits with 0 errors.
- 111/111 unit, contract, conformance, parity, and doctor tests pass across 9 test suites.
- Live canary execution was successfully proven **end-to-end through the adapter code path** using the free model `openrouter/nex-agi/nex-n2.5-mini:free`, including dynamic model listing (375 models), Turn 1 generation with session ID capture, and Turn 2 multi-turn context resumption via `-S <session_id>` with exact secret token recall.

---

## 2. Files Added and Modified

### Added Adapter Files (`src/backend/kimi/`):
- `src/backend/kimi/constants.ts`: Backend identifiers, default model (`openrouter/moonshotai/kimi-k3`), minimum CLI version (`2.0.0`), base arguments (`--output-format stream-json`), and frontend-aware system prompt suffix.
- `src/backend/kimi/auth.ts`: Inspects `~/.kimi-code/config.toml` (and `TALON_KIMI_CONFIG_FILE`), extracts `[providers]`, classifies auth errors (`isKimiAuthFailure`), and constructs remediation errors (`kimiAuthError`).
- `src/backend/kimi/doctor.ts`: Implements `kimiDoctorChecks` validating binary on PATH or via `kimiBinary`/`KIMI_BINARY`, minimum version floor (`>= 2.0.0`), configured auth providers, and dynamic model listing.
- `src/backend/kimi/effort.ts`: Documented explicit no-op for reasoning effort mapping, returning `undefined` (confirmed `kimi --help` accepts no effort flag).
- `src/backend/kimi/events.ts`: Strict NDJSON streaming and line parser (`parseKimiStream`, `parseKimiLine`), event types (`KimiEvent`, `KimiAssistantEvent`, `KimiToolEvent`, `KimiMetaEvent`), tool argument JSON string unwrapping (`describeKimiTool`), stream-state integration (`applyKimiEvent`), and token usage mapping (`kimiUsageToTokens`).
- `src/backend/kimi/models.ts`: Parses dynamic model catalog from `kimi provider list --json`, handles exact/case-insensitive/prefix queries, extracts provider groupings, pagination, and default model resolution.
- `src/backend/kimi/state.ts`: Per-process state management (`config`, `gatewayPortFn`, `frontendName`, `systemPromptOverride`, `lastUsage` map).
- `src/backend/kimi/sessions.ts`: Implements `resetChat`, `warmSession`, and `refreshTools`.
- `src/backend/kimi/one-shot.ts`: Isolated headless runner (`runOneShotAgent`) for cron, dream, and heartbeat background tasks.
- `src/backend/kimi/process/child.ts`: `KimiChild` managing `kimi -p ... --output-format stream-json` subprocess execution, stdout NDJSON line buffering, session resume hint extraction (`session.resume_hint`), SIGINT/SIGKILL lifecycle, and session wire log usage extraction (`readKimiSessionUsage`).
- `src/backend/kimi/process/orphans.ts`: Sweeps `/proc` on Linux to detect and terminate orphaned `kimi` subprocesses.
- `src/backend/kimi/handler/message.ts`: Turn orchestration (`handleMessage`), turn 0 system prompt injection with `systemPromptOverride` support, multi-turn session ID injection (`-S <sessionId>`), event streaming translation, delivery routing, and usage accounting.
- `src/backend/kimi/handler/index.ts`: Barrel export for message handler.
- `src/backend/kimi/init.ts`: Agent initialisation (`initKimiAgent`), auth logging, and background model cache priming.
- `src/backend/kimi/factory.ts`: Backend factory registered under `kimi` (`"Kimi"`), exposing capability slots (`chat`, `background`, `models`, `sessions`, `tools`, `usage`, `control`).

### Test Suites & Fixtures Added:
- `src/__tests__/fixtures/kimi/stream-bash-tool.jsonl`: Real captured stream-json fixture containing function tool calls, tool results, assistant text, and `session.resume_hint`.
- `src/__tests__/fixtures/kimi/provider-list.json`: Live snapshot of `kimi provider list --json`.
- `src/__tests__/kimi-events.test.ts`: 11 tests verifying NDJSON streaming parser, tool argument unwrapping, failure handling, text accumulation, turn termination on `end_turn`, and usage mapping.
- `src/__tests__/kimi-factory.test.ts`: 8 tests verifying factory registration, capability slots, doctor hook, system prompt updates, and cleanup.
- `src/__tests__/kimi-models.test.ts`: 15 tests verifying provider list JSON parsing, exact/prefix model resolution, provider grouping, and fallback synthesis.
- `src/__tests__/kimi-doctor.test.ts`: 13 tests verifying binary path checks, version comparison floor (`>= 2.0.0`), auth provider detection, unconfigured/missing/corrupt config handling, and catalog probing.
- `scripts/kimi-live-check.ts`: Real end-to-end canary script verifying factory initialization, catalog probing, Turn 1 execution, session ID capture, and Turn 2 multi-turn context recall.

### Modified Files in Talon Core:
- `src/backend/builtins.ts`: Added dynamic import for `./kimi/factory.js` in `loadBuiltinBackends`.
- `src/core/agent-runtime/model-ref.ts`: Added `"kimi"` to `BACKEND_IDS` canonical literal tuple.
- `src/core/config/index.ts`: Added `kimiBinary: z.string().optional()` to `TalonConfig` schema.
- `src/__tests__/backend-registry-parity.test.ts`: Added `"kimi"` to `ALL_BACKENDS`, imported factory in `beforeAll`, and verified sorted registration.
- `src/__tests__/agent-runtime-types.test.ts`: Updated `BACKEND_IDS` tests to verify 7 registered backends including `"kimi"`.

---

## 3. Verification Commands & Actual Outputs

### Command 1: TypeScript Typecheck
```bash
$ npx tsc --noEmit
npm notice run talon-agent@5.5.0 npx
npm notice run 'tsc' --noEmit
(Exited with code 0)
```

### Command 2: Registry, Conformance, Contract & Parity Suites
```bash
$ npx vitest run src/__tests__/backend-registry.test.ts \
                 src/__tests__/backend-conformance.test.ts \
                 src/__tests__/backend-contract.test.ts \
                 src/__tests__/backend-registry-parity.test.ts \
                 src/__tests__/agent-runtime-types.test.ts
```
**Output:**
```
 RUN  v5.0.1 /home/dylan/talon-kimi

 Test Files  5 passed (5)
      Tests  63 passed (63)
   Duration  7.42s
(Exited with code 0)
```

### Command 3: Kimi Unit Test Suites
```bash
$ npx vitest run src/__tests__/kimi-events.test.ts \
                 src/__tests__/kimi-factory.test.ts \
                 src/__tests__/kimi-models.test.ts \
                 src/__tests__/kimi-doctor.test.ts
```
**Output:**
```
 RUN  v5.0.1 /home/dylan/talon-kimi

 Test Files  4 passed (4)
      Tests  48 passed (48)
   Duration  1.99s
(Exited with code 0)
```

### Command 4: Combined Full Backend Suite
```bash
$ npx vitest run src/__tests__/backend-registry.test.ts \
                 src/__tests__/backend-conformance.test.ts \
                 src/__tests__/backend-contract.test.ts \
                 src/__tests__/backend-registry-parity.test.ts \
                 src/__tests__/agent-runtime-types.test.ts \
                 src/__tests__/kimi-events.test.ts \
                 src/__tests__/kimi-factory.test.ts \
                 src/__tests__/kimi-models.test.ts \
                 src/__tests__/kimi-doctor.test.ts
```
**Output:**
```
 Test Files  9 passed (9)
      Tests  111 passed (111)
   Duration  7.61s
(Exited with code 0)
```

---

## 4. Live Canary Verification Through Adapter Code Path

A real live canary test was executed through the complete adapter code path (`factory.init` -> `backend.models.listModels` -> `backend.chat.runChatTurn` -> `child.runTurn` -> `kimi` CLI subprocess) using `scripts/kimi-live-check.ts`.

### Target Model:
`openrouter/nex-agi/nex-n2.5-mini:free` (verified zero-cost canary model on OpenRouter).

### Exact Execution Output:
```text
=== Kimi Adapter Live Canary Check ===
[PASS] Kimi factory resolved: kimi (Kimi)
[15:58:04] INFO: Kimi auth: providers configured (openrouter)
    component: "agent"
[PASS] Kimi backend initialized.
[15:58:04] INFO: Backend: Kimi (@moonshot-ai/kimi-code, headless stream-json)
    component: "bot"
[PASS] Dynamic model catalog returned 375 models from Kimi CLI.
[PASS] Canary model openrouter/nex-agi/nex-n2.5-mini:free in catalog: true

--- Executing Turn 1 (secret: KIMI-CANARY-34847) ---
[15:58:05] INFO: Initialized database schema
    component: "db"
[15:58:05] INFO: [-100canary-live-check] <- (37 chars)
    component: "agent"
[15:58:05] INFO: [-100canary-live-check] kimi spawn: /home/dylan/.npm-global/bin/kimi --output-format stream-json -p You are a helpful AI assistant. Follow instructions precisely and answer concisely.

---

[2026-09-22 15:58 Tue (UTC)] Reply with exactly: KIMI-CANARY-34847 -m openrouter/nex-agi/nex-n2.5-mini:free --add-dir /home/dylan/talon-kimi
    component: "agent"
Turn 1 finished with 5 events:
  Event types: run_started, text_delta, assistant_message, usage, completed
  Full response text: "KIMI-CANARY-34847"
  Completed event stopReason: undefined
  Stored session after Turn 1: id=session_c52f7def-3dcd-4830-b59d-4dc0032afd34, turns=1
  [PASS] Session ID captured: session_c52f7def-3dcd-4830-b59d-4dc0032afd34

--- Executing Turn 2 (Testing session recall) ---
[15:58:14] INFO: [-100canary-live-check] delivery: text-part (17 chars)
    component: "agent"
[15:58:14] INFO: [-100canary-live-check] -> (8373ms in=22920 out=21 cache=0% terminator=no delivered=0 respLen=17 setup=11ms turn=8358ms)
    component: "agent"
[15:58:14] INFO: [-100canary-live-check] <- (128 chars)
    component: "agent"
[15:58:14] INFO: [-100canary-live-check] kimi spawn: /home/dylan/.npm-global/bin/kimi --output-format stream-json -p [2026-09-22 15:58 Tue (UTC)] What was the exact verification token string you just replied with in your previous response? Reply with only that token string. -m openrouter/nex-agi/nex-n2.5-mini:free -S session_c52f7def-3dcd-4830-b59d-4dc0032afd34 --add-dir /home/dylan/talon-kimi
    component: "agent"
[15:58:30] INFO: [-100canary-live-check] delivery: text-part (17 chars)
    component: "agent"
Turn 2 finished with 5 events:
  Event types: run_started, text_delta, assistant_message, usage, completed
  Full response text: "KIMI-CANARY-34847"
  Stored session after Turn 2: id=session_c52f7def-3dcd-4830-b59d-4dc0032afd34, turns=2
  Turn 2 recalled token 'KIMI-CANARY-34847': true

=== Live Canary Completed Successfully ===
[15:58:30] INFO: [-100canary-live-check] -> (16587ms in=22103 out=20 cache=0% terminator=no delivered=0 respLen=17 setup=2ms turn=16585ms)
    component: "agent"
[15:58:30] INFO: Kimi backend cleaned up
    component: "bot"
```

### Key Canary Proofs:
1. **Turn 1**: Successfully spawned `/home/dylan/.npm-global/bin/kimi` with `--output-format stream-json`, passed initial system prompt + user prompt, received streaming NDJSON, converted into `run_started -> text_delta -> assistant_message -> usage -> completed`, extracted `session.resume_hint` ID `session_c52f7def-3dcd-4830-b59d-4dc0032afd34`, and recorded turn 1 in session storage.
2. **Turn 2 Session Continuity**: Spawned `/home/dylan/.npm-global/bin/kimi` with `-S session_c52f7def-3dcd-4830-b59d-4dc0032afd34` without prepending the system prompt or repeating the secret token.
3. **Context Recall**: Turn 2 explicitly answered `"KIMI-CANARY-34847"`, proving multi-turn conversation memory works through Kimi's native session resumption mechanism.

---

## 5. Verified vs. Inferred / Deduced Interfaces

### Verified Directly:
- **CLI Flags**: Verified via `kimi --help` that `-p/--prompt`, `--output-format stream-json`, `-S/--session [id]`, `-r [id]`, `-m/--model`, and `--add-dir` are accepted. Verified that `-y/--yolo` and `--auto` fail in combination with `-p` (`"error: Cannot combine --prompt with --auto"`).
- **Session Continuity**: Verified that Turn 1 returns `{"role":"meta","type":"session.resume_hint","session_id":"..."}` on stdout stream, and that passing `-S <session_id>` on Turn 2 resumes the session state.
- **Model Catalog Probing**: Verified that `kimi provider list --json` emits valid JSON containing `models` object with attributes `name`, `max_context_tokens`, and provider prefixes.
- **Token Usage**: Verified from `@moonshot-ai/kimi-code` source (`main.mjs`) and session directories that stdout `stream-json` in prompt mode emits assistant content and resume hints, while detailed token usage records (`type: "usage.record"`) are written to `~/.kimi-code/sessions/<workspaceId>/<sessionId>/agents/main/wire.jsonl`.
- **Reasoning Effort**: Verified that Kimi CLI does not accept an `--effort` flag via CLI arguments. `toKimiEffort` was implemented as a documented no-op returning `undefined`.
- **Approval Mode**: Verified that in headless `-p` prompt mode, Kimi CLI automatically auto-approves tool calls (as evidenced in live transcripts where `Bash` and `Read` executed without prompts).

### Inferred / Deduced Interfaces:
- **Session Resume Flag Preference**: Kimi's resume hint emits `kimi -r <session_id>`, while `kimi --help` documents `-S, --session [id]` (with `-r` as an undocumented short alias). The adapter passes `-S <sessionId>` as it is the documented flag, and verified it functions identically to `-r`.
- **Workspace Hash in Session Directory**: The session directory on disk is named `wd_<basename>_<hash>` (e.g. `wd_talon-kimi_7ec70717b7c3`). `readKimiSessionUsage` locates the directory by globbing `~/.kimi-code/sessions/wd_*<workspaceBasename>*/<sessionId>/agents/main/wire.jsonl` or falling back to searching across all workspace directories for the `<sessionId>`.

---

## 6. Known Limitations & Unfinished Scope

1. **Token Usage Delay**: Because `main.mjs` writes `wire.jsonl` asynchronously around process exit, token usage reads from disk are best-effort. If the file is still being flushed, usage defaults to zeros and will be captured on the next turn.
2. **Concurrent Turns in Same Chat**: Because `kimi -p` operates as a distinct invocation per turn, turns on the same chat ID must be serialised (standard Talon dispatcher contract).
3. **No Interactive Stdin Stream**: Unlike Google Antigravity's `--input-format stream-json`, Kimi 2.0.2 does not support streaming input turns over stdin in long-lived subprocesses; each turn is spawned via `kimi -p` with `-S <sessionId>`.

All requested deliverables, constraints, and contracts have been met.
