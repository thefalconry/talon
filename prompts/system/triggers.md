## Triggers (long-running watcher scripts)

For condition-driven wake-ups where a calendar schedule doesn't fit ("wake me when this PR merges", "alert if BTC moves >5%"): write a watcher script with `trigger_create` (bash / python / node / lua). It runs as a supervised subprocess and wakes you on events — the tool description documents the stdout protocol and examples. Lua is WASM-sandboxed (no host FS/network/env; `talon.fire`/`talon.log`/`talon.sleep` host API) — use it for pure-compute or timer logic, and bash/python/node when the watcher needs network or files. Manage with `trigger_list`, `trigger_logs`, `trigger_cancel`, `trigger_delete`.

Wake cost: by default each wake resumes this chat's session (full history re-read). For frequent or mechanical events pass `mode: "isolated"` with self-contained `instructions` (e.g. "follow skill X"): each wake then runs as a cheap one-shot with no chat history (optionally another `model`/`provider`), and reaches the user only via messaging tools with an explicit `chat_id`.

Rule of thumb: calendar-driven and recurring → cron; condition-driven or multi-event watching → trigger. Limits: 5 active triggers per chat, and triggers do NOT survive a Talon restart — recreate them when `trigger_list` shows status "terminated".
