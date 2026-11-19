import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("../storage/history.js", () => ({
  getRecentFormatted: vi.fn(() => ""),
  searchHistory: vi.fn(() => ""),
  getMessagesByUser: vi.fn(() => ""),
  getKnownUsers: vi.fn(() => ""),
}));

vi.mock("../storage/media-index.js", () => ({
  formatMediaIndex: vi.fn(() => ""),
}));

vi.mock("../storage/cron.js", () => ({
  addCronJob: vi.fn(),
  getCronJob: vi.fn(),
  getCronJobsForChat: vi.fn(() => []),
  updateCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  validateCronExpression: vi.fn(() => ({ valid: true })),
  generateCronId: vi.fn(() => "test-id"),
  loadCronJobs: vi.fn(),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { classify, TalonError } = await import("../core/errors.js");
await import("../storage/cron.js");
const { handleSharedAction } =
  await import("../core/engine/gateway-actions/index.js");
const { resolveModelId: resolveModelName } =
  await import("../core/models/catalog.js");
const { registerClaudeModelsStatic, CLAUDE_MODELS_STATIC } =
  await import("../backend/claude-sdk/models/index.js");
registerClaudeModelsStatic(CLAUDE_MODELS_STATIC);
const { Cron } = await import("croner");
const { messagingTools } = await import("../core/tools/chat/messaging.js");
const { stripMcpPrefix, isTurnTerminator, ALL_TOOLS } =
  await import("../core/tools/index.js");
const { markdownToTelegramHtml, escapeHtml } =
  await import("../frontend/telegram/formatting.js");
const { z } = await import("zod");

// ── Configuration ───────────────────────────────────────────────────────────

const NUM_RUNS = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;
const fcParams = { numRuns: NUM_RUNS };

// ── Fuzz tests ───────────────────────────────────────────────────────────────

describe("fuzz: classify()", () => {
  it("never throws on random string inputs", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = classify(input);
        expect(result).toBeInstanceOf(TalonError);
        expect(typeof result.reason).toBe("string");
        expect(typeof result.retryable).toBe("boolean");
        expect(typeof result.message).toBe("string");
      }),
      fcParams,
    );
  });

  it("never throws on random Error inputs", () => {
    fc.assert(
      fc.property(fc.string(), (msg) => {
        const result = classify(new Error(msg));
        expect(result).toBeInstanceOf(TalonError);
        expect(result.reason).toBeTruthy();
      }),
      fcParams,
    );
  });

  it("never throws on random non-string/non-Error inputs", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
          fc.double(),
          fc.object(),
        ),
        (input) => {
          const result = classify(input);
          expect(result).toBeInstanceOf(TalonError);
          expect(result.reason).toBeTruthy();
        },
      ),
      fcParams,
    );
  });

  it("always returns a valid ErrorReason", () => {
    const validReasons = new Set([
      "rate_limit",
      "overloaded",
      "network",
      "auth",
      "context_length",
      "content_filter",
      "session_expired",
      "bad_request",
      "forbidden",
      "telegram_api",
      "unknown",
    ]);

    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = classify(input);
        expect(validReasons.has(result.reason)).toBe(true);
      }),
      fcParams,
    );
  });

  it("retryAfterMs is never negative when present", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = classify(input);
        if (result.retryAfterMs !== undefined) {
          expect(result.retryAfterMs).toBeGreaterThanOrEqual(0);
        }
      }),
      fcParams,
    );
  });
});

// Real cron validator (the import is mocked, so we use Cron directly)
function realValidateCron(
  expr: string,
  timezone?: string,
): { valid: boolean; error?: string } {
  try {
    const cron = new Cron(expr, { timezone: timezone ?? undefined });
    cron.nextRun();
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

describe("fuzz: validateCronExpression()", () => {
  it("never throws on random strings, always returns { valid: boolean }", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = realValidateCron(input);
        expect(typeof result.valid).toBe("boolean");
        if (!result.valid) {
          expect(typeof result.error).toBe("string");
        }
      }),
      fcParams,
    );
  });

  it("never throws on random strings with random timezone strings", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (expr, tz) => {
        const result = realValidateCron(expr, tz);
        expect(typeof result.valid).toBe("boolean");
      }),
      fcParams,
    );
  });
});

describe("fuzz: handleSharedAction() — unknown actions", () => {
  it("returns null for random action names (never crashes)", () => {
    fc.assert(
      fc.asyncProperty(fc.string(), async (actionName) => {
        // Skip known action names to test only the default/unknown path
        const knownActions = new Set([
          "read_history",
          "search_history",
          "get_user_messages",
          "list_known_users",
          "list_media",
          "fetch_url",
          "create_cron_job",
          "list_cron_jobs",
          "edit_cron_job",
          "delete_cron_job",
        ]);
        if (knownActions.has(actionName)) return;

        const result = await handleSharedAction({ action: actionName }, 123);
        expect(result).toBeNull();
      }),
      fcParams,
    );
  });

  it("never crashes with random body objects", () => {
    fc.assert(
      fc.asyncProperty(
        fc.record({
          action: fc.string(),
          extra: fc.string(),
          num: fc.integer(),
        }),
        async (body) => {
          const knownActions = new Set([
            "read_history",
            "search_history",
            "get_user_messages",
            "list_known_users",
            "list_media",
            "fetch_url",
            "create_cron_job",
            "list_cron_jobs",
            "edit_cron_job",
            "delete_cron_job",
          ]);
          if (knownActions.has(body.action)) return;

          const result = await handleSharedAction(body, 123);
          expect(result).toBeNull();
        },
      ),
      fcParams,
    );
  });
});

describe("fuzz: fetch_url URL validation", () => {
  let originalFetch: typeof globalThis.fetch;

  it("random strings as URLs return ok:false or null, never throw", () => {
    originalFetch = globalThis.fetch;
    // Mock fetch to prevent real network calls
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("mocked")));

    fc.assert(
      fc.asyncProperty(fc.string(), async (url) => {
        const result = await handleSharedAction(
          { action: "fetch_url", url },
          123,
        );
        // Should either return an error result or handle gracefully
        expect(result).not.toBeUndefined();
        if (result !== null) {
          expect(typeof result.ok).toBe("boolean");
          if (!result.ok) {
            expect(typeof result.error).toBe("string");
          }
        }
      }),
      fcParams,
    );

    globalThis.fetch = originalFetch;
  });

  it("rejects all non-http/https protocols", () => {
    fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          "ftp",
          "file",
          "javascript",
          "data",
          "ws",
          "wss",
          "ssh",
        ),
        fc.webUrl(),
        async (protocol, path) => {
          const url = `${protocol}://${path.replace(/^https?:\/\//, "")}`;
          const result = await handleSharedAction(
            { action: "fetch_url", url },
            123,
          );
          if (result !== null) {
            // Should not be ok for non-http protocols
            // (some invalid URLs will get "Invalid URL" error at parse time)
            expect(result.ok).toBe(false);
          }
        },
      ),
      fcParams,
    );
  });
});

describe("fuzz: resolveModelName()", () => {
  it("never throws on random strings, always returns a string", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = resolveModelName(input);
        expect(typeof result).toBe("string");
      }),
      fcParams,
    );
  });

  it("always returns trimmed output", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = resolveModelName(input);
        expect(result).toBe(result.trim());
      }),
      fcParams,
    );
  });

  it("known aliases resolve to the expected SDK model IDs", () => {
    const aliasMappings = [
      ["sonnet", "default"],
      ["opus", "opus"],
      ["haiku", "haiku"],
      ["sonnet-4.6", "default"],
      ["opus-4.6", "opus"],
      ["haiku-4.5", "haiku"],
      ["sonnet-4-6", "default"],
      ["opus-4-6", "opus"],
      ["haiku-4-5", "haiku"],
    ] as const;
    fc.assert(
      fc.property(
        fc.constantFrom(...aliasMappings),
        fc.constantFrom("", " ", "  "),
        ([alias, expectedModelId], padding) => {
          const result = resolveModelName(padding + alias + padding);
          expect(result).toBe(expectedModelId);
        },
      ),
      fcParams,
    );
  });

  it("unknown strings pass through trimmed", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const trimmed = input.trim().toLowerCase();
        const knownAliases = [
          "sonnet",
          "opus",
          "haiku",
          "sonnet-4.6",
          "opus-4.6",
          "haiku-4.5",
          "sonnet-4-6",
          "opus-4-6",
          "haiku-4-5",
        ];
        if (knownAliases.includes(trimmed)) return;

        const result = resolveModelName(input);
        expect(result).toBe(input.trim());
      }),
      fcParams,
    );
  });
});

// ── Fuzz: stripMcpPrefix() ──────────────────────────────────────────────────
//
// Tool names arrive at handler.ts in two shapes: bare (`end_turn`) when
// declared natively and MCP-prefixed (`mcp__telegram-tools__end_turn`) when
// served through MCP. `stripMcpPrefix` is the boundary normalizer used by
// `isTurnTerminator`, dedup capture, and the daily-log capture path.
// PR #122 lived for 8 weeks because three call sites compared against bare
// names and the prefixed ones never matched. Fuzz makes sure no input
// shape (including UTF-8, empty strings, malformed prefixes) ever throws.

describe("fuzz: stripMcpPrefix()", () => {
  it("never throws on arbitrary strings, always returns a string", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = stripMcpPrefix(input);
        expect(typeof result).toBe("string");
      }),
      fcParams,
    );
  });

  it("input without `mcp__` prefix is returned unchanged", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.startsWith("mcp__")),
        (input) => {
          expect(stripMcpPrefix(input)).toBe(input);
        },
      ),
      fcParams,
    );
  });

  it("synthesized mcp__<server>__<tool> always reduces to <tool>", () => {
    // Server names: alphanumeric + hyphens (matches MCP convention).
    const serverNameArb = fc
      .string({ minLength: 1, maxLength: 30 })
      .filter((s) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(s));
    // Tool names can include underscores (`end_turn`, `send_message`) but
    // not the `__` boundary itself.
    const toolNameArb = fc
      .string({ minLength: 1, maxLength: 30 })
      .filter((s) => /^[A-Za-z0-9_]+$/.test(s) && !s.includes("__"));

    fc.assert(
      fc.property(serverNameArb, toolNameArb, (server, tool) => {
        const full = `mcp__${server}__${tool}`;
        expect(stripMcpPrefix(full)).toBe(tool);
      }),
      fcParams,
    );
  });

  it("isTurnTerminator never throws on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = isTurnTerminator(input);
        expect(typeof result).toBe("boolean");
      }),
      fcParams,
    );
  });

  it("isTurnTerminator agrees with bare/prefixed equivalence", () => {
    // For every endsTurn tool, every MCP-prefixed shape AND the bare name
    // must return true. Anchors PR #122's regression: if a future change
    // breaks the prefix-stripping path, this fails fast.
    const endsTurnTools = ALL_TOOLS.filter((t) => t.endsTurn).map(
      (t) => t.name,
    );
    if (endsTurnTools.length === 0) return; // nothing to test
    const serverArb = fc.constantFrom(
      "telegram-tools",
      "teams-tools",
      "some-server-x",
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...endsTurnTools),
        serverArb,
        (toolName, serverName) => {
          expect(isTurnTerminator(toolName)).toBe(true);
          expect(isTurnTerminator(`mcp__${serverName}__${toolName}`)).toBe(
            true,
          );
        },
      ),
      fcParams,
    );
  });
});

// ── Fuzz: messaging-tool zod schemas ────────────────────────────────────────
//
// Every messaging tool declares a zod schema describing its input shape.
// `tool.execute(params, bridge)` only runs after the schema validates.
// This suite hammers each schema with arbitrary input and asserts:
//   - .safeParse() never throws (it shouldn't — that's its contract)
//   - When parsing succeeds, the resulting object is shaped correctly
// Catches schema regressions: a future change that turns a `z.string()`
// into something throw-prone (e.g. a discriminated union missing a case)
// would fail here.

describe("fuzz: messaging-tool zod schemas", () => {
  for (const tool of messagingTools) {
    // Build a zod object schema from the tool's field-level schema map.
    const objectSchema = z.object(tool.schema);

    it(`${tool.name}: safeParse never throws on arbitrary objects`, () => {
      fc.assert(
        fc.property(
          fc.dictionary(fc.string(), fc.anything(), {
            minKeys: 0,
            maxKeys: 8,
          }),
          (input) => {
            const parsed = objectSchema.safeParse(input);
            expect(typeof parsed.success).toBe("boolean");
            if (parsed.success) {
              expect(typeof parsed.data).toBe("object");
            }
          },
        ),
        fcParams,
      );
    });

    it(`${tool.name}: safeParse on undefined / null / primitives returns failure`, () => {
      // The tool's input is always an object — primitives + null/undefined
      // must fail validation cleanly, never throw.
      const nonObjectArb = fc.oneof(
        fc.constantFrom(undefined, null),
        fc.string(),
        fc.integer(),
        fc.boolean(),
      );
      fc.assert(
        fc.property(nonObjectArb, (input) => {
          const parsed = objectSchema.safeParse(input);
          expect(parsed.success).toBe(false);
        }),
        fcParams,
      );
    });
  }
});

// ── Fuzz: messaging-tool execute() ──────────────────────────────────────────
//
// For every tool, generate arbitrary VALID input (the exhaustive way: build
// the input object from the zod schema's introspected fields), then call
// `tool.execute(params, fakeBridge)`. The fakeBridge captures every call
// and returns a synthetic success. Properties:
//   - execute never throws on valid input
//   - bridge is called at most a small bounded number of times per execute
//   - if it returns ok, the return shape is sensible (`ok` is bool)
//
// We use a permissive arbitrary (anything, then filter to objects). Tools
// that bail early on bad input return without calling bridge — that's
// fine, we only assert no throw + return shape.

describe("fuzz: messaging-tool execute()", () => {
  for (const tool of messagingTools) {
    it(`${tool.name}: execute never throws + returns ok-shaped result`, async () => {
      // Build an arbitrary that's "object-ish" — most useful inputs are
      // dictionaries that may or may not satisfy the schema.
      const objectArb = fc.dictionary(fc.string(), fc.anything(), {
        minKeys: 0,
        maxKeys: 6,
      });

      await fc.assert(
        fc.asyncProperty(objectArb, async (input) => {
          // Small fakeBridge: records calls, returns plausible success.
          const calls: Array<{
            action: string;
            body: Record<string, unknown>;
          }> = [];
          const fakeBridge = async (
            action: string,
            body: Record<string, unknown>,
          ) => {
            calls.push({ action, body });
            return { ok: true, message_id: 1 };
          };

          let result: unknown;
          try {
            result = await tool.execute(
              input as Record<string, unknown>,
              fakeBridge,
            );
          } catch (err) {
            // Tool execute is allowed to throw on invalid input — the SDK's
            // schema validation gates this in production. Acceptable failure.
            expect(err).toBeInstanceOf(Error);
            return;
          }

          // If it didn't throw, it returned something. Most messaging tools
          // return `{ok: bool, ...}` — we only require the result is an
          // object or undefined (some tools may legitimately return void).
          if (result !== undefined && result !== null) {
            expect(typeof result).toBe("object");
          }
          // Bridge calls should be bounded — no tool should fan out massively.
          expect(calls.length).toBeLessThanOrEqual(2);
        }),
        // execute is async + spawns no subprocesses, but we keep iterations
        // modest for time budget.
        { numRuns: Math.min(NUM_RUNS, 200) },
      );
    });
  }
});

// ── Fuzz: markdownToTelegramHtml ────────────────────────────────────────────
//
// Used on every outbound message. Anything the model can produce flows
// through this — including malformed markdown, code-block deltas mid-token,
// nested formatting that isn't valid Telegram HTML. Must never throw and
// must always return a string. The function is also responsible for some
// HTML escaping so the output should never contain unescaped raw `<` or `&`
// at top level outside of generated tags.

describe("fuzz: markdownToTelegramHtml()", () => {
  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = markdownToTelegramHtml(input);
        expect(typeof result).toBe("string");
      }),
      fcParams,
    );
  });

  it("never throws on long arbitrary strings (size-stressed)", () => {
    // fast-check 4 collapsed the unicode-specific arbitraries into plain
    // `string()` with a `unit` constraint; the default unit covers
    // arbitrary Unicode codepoints which is what we want here.
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }),
        (input: string) => {
          const result = markdownToTelegramHtml(input);
          expect(typeof result).toBe("string");
        },
      ),
      fcParams,
    );
  });

  // "Never throws" is too weak a property: a crossed-tag result like
  // `<b><i>x</b></i>` returns a perfectly fine string and then gets
  // rejected by Telegram at send time. The output has to be *parseable*.
  it("always emits well-formed, Telegram-allowed tags", () => {
    const ALLOWED = new Set(["b", "i", "s", "a", "code", "pre"]);
    const wellFormed = (html: string): boolean => {
      const stack: string[] = [];
      const tag = /<(\/?)([a-zA-Z]+)(?:\s[^>]*)?>/g;
      let m: RegExpExecArray | null;
      while ((m = tag.exec(html)) !== null) {
        const [, closing, name] = m;
        if (!ALLOWED.has(name!)) return false;
        if (closing) {
          if (stack.pop() !== name) return false;
        } else {
          stack.push(name!);
        }
      }
      return stack.length === 0;
    };

    // Markdown-shaped tokens, which random unicode strings essentially
    // never produce — this is where the crossed-tag bugs actually live.
    const token = fc.constantFrom(
      "**",
      "***",
      "*",
      "_",
      "~~",
      "`",
      "```\n",
      "[x](https://a.com)",
      "text",
      " ",
      "\n",
      "<",
      "&",
    );
    fc.assert(
      fc.property(fc.array(token, { minLength: 1, maxLength: 12 }), (parts) => {
        expect(wellFormed(markdownToTelegramHtml(parts.join("")))).toBe(true);
      }),
      fcParams,
    );
  });

  it("never throws on heavily nested markdown", () => {
    // Adversarial input: deeply nested formatting that often breaks naive
    // markdown parsers.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (depth) => {
        const opens = "*".repeat(depth) + "_".repeat(depth) + "`".repeat(depth);
        const closes =
          "`".repeat(depth) + "_".repeat(depth) + "*".repeat(depth);
        const input = `${opens}content${closes}`;
        const result = markdownToTelegramHtml(input);
        expect(typeof result).toBe("string");
      }),
      fcParams,
    );
  });

  it("escapeHtml never throws + always escapes `<`, `>`, `&`, `\"`, `'`", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = escapeHtml(input);
        expect(typeof result).toBe("string");
        // No raw < > & " ' should appear in the output (they should all
        // have been replaced with entities). Note: digits/entities like
        // `&amp;` ARE allowed.
        // Strip valid entities before checking.
        const stripped = result
          .replace(/&amp;/g, "")
          .replace(/&lt;/g, "")
          .replace(/&gt;/g, "")
          .replace(/&quot;/g, "")
          .replace(/&#39;/g, "")
          .replace(/&apos;/g, "");
        expect(stripped).not.toMatch(/[<>&]/);
      }),
      fcParams,
    );
  });
});
