import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Per-worker throwaway home (HOME, USERPROFILE, TALON_HOME, Claude/
    // Codex/XDG store dirs) — no suite can reach the real ~/.talon; see
    // src/__tests__/setup/home-isolation.ts and util/fs-path.ts. Must
    // stay first so nothing is imported before the override. Then a
    // per-worker throwaway SQLite path (setup/test-db.ts).
    setupFiles: [
      "src/__tests__/setup/home-isolation.ts",
      "src/__tests__/setup/test-db.ts",
    ],
    // tmp-reaper gives the run a private temp root and reaps it (with every
    // worker home in it) afterwards; home-global records the real home and
    // points the workers' inherited env at a run-wide fallback home. Order
    // matters: the home is created inside the reaper's root.
    globalSetup: [
      "src/__tests__/setup/tmp-reaper.ts",
      "src/__tests__/setup/home-global.ts",
    ],
    // The codex-handler integration tests drive a full
    // initCodexAgent + handleMessage flow per case; some retry-path
    // tests do 2-3 round trips through the SDK mock and hit the real
    // sessions/chat-settings stores on disk. The default 5s timeout
    // is tight on Windows where each writeFileAtomic.sync stalls on
    // fsync. Bumped to 15s to absorb the disk-IO variance without
    // changing the per-test logic.
    testTimeout: 15_000,
    // Under `bun --bun vitest`, vitest's externalized-dep loader hits a
    // CJS/ESM interop gap in bun's node compat and `import { z } from
    // "zod"` evaluates to undefined, failing every schema-touching
    // suite. Inlining zod routes it through vite's own transform, which
    // both runtimes resolve identically. No effect on node runs beyond
    // a one-time transform cost.
    server: {
      deps: {
        inline: ["zod"],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html", "lcov"],
      // ── Excludes ──────────────────────────────────────────────────────
      // Test files, integration scaffolding, and entry points are noise
      // for the coverage gate — they're either tests themselves or
      // glue that's verified by integration tests rather than unit ones.
      exclude: [
        "src/**/*.test.ts",
        "src/__tests__/**",
        "src/index.ts",
        "src/cli.ts",
        "src/login.ts",
        "src/setup.ts",
        "src/bootstrap.ts",
        // The Kilo/OpenCode profiles are declarations bound to SDK
        // constructors, exercised by the dedicated integration and
        // backend-live CI tiers. Keep unit coverage focused on the shared
        // parser/session/server logic where isolated tests give useful signal.
        "src/backend/remote-server/profiles/kilo.ts",
        "src/backend/remote-server/profiles/opencode.ts",
        // The Lua runner is a process entry (`_lua-run`): exercised end-to-end
        // by lua-runner.test.ts as a real child process, which v8 in-process
        // coverage can't see.
        "src/core/scripts/lua.ts",
        "**/*.d.ts",
        "**/dist/**",
      ],
      // ── Global thresholds ─────────────────────────────────────────────
      // Catches "tests dropped on critical code" without being so tight
      // that minor refactors break CI. Tightened over time as the suite
      // grows. Each ratchet should bump in increments of ~5%.
      // Ratcheted 60 → 65 at actuals of 70.5/69.4/70.5 (2026-06);
      // branches stays 60 (actual 63.2 — too tight for a 5pt bump).
      thresholds: {
        lines: 65,
        functions: 65,
        branches: 60,
        statements: 65,
      },
    },
  },
});
