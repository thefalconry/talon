import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks (must come before import) ──────────────────────────────────

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

const mockGetRecentFormatted = vi.fn(() => "history lines here");
const mockSearchHistory = vi.fn(() => "search results here");
const mockGetMessagesByUser = vi.fn(() => "user messages here");
const mockGetKnownUsers = vi.fn(() => "alice, bob");
vi.mock("../storage/history.js", () => ({
  getRecentFormatted: mockGetRecentFormatted,
  searchHistory: mockSearchHistory,
  getMessagesByUser: mockGetMessagesByUser,
  getKnownUsers: mockGetKnownUsers,
}));

const mockFormatMediaIndex = vi.fn(() => "media index here");
vi.mock("../storage/media-index.js", () => ({
  formatMediaIndex: mockFormatMediaIndex,
}));

const mockCronJobs = new Map<string, any>();
const mockAddCronJob = vi.fn((job: any) => {
  mockCronJobs.set(job.id, job);
});
const mockGetCronJob = vi.fn((id: string) => mockCronJobs.get(id));
const mockGetCronJobsForChat = vi.fn((): any[] => []);
const mockUpdateCronJob = vi.fn();
const mockDeleteCronJob = vi.fn();
const mockValidateCronExpression = vi.fn(
  (): { valid: boolean; next?: string; error?: string } => ({
    valid: true,
    next: "2026-04-01T09:00:00.000Z",
  }),
);
const mockGenerateCronId = vi.fn(() => "test-id-123");
const mockDescribeSchedule = vi.fn((job: any) =>
  job.everyMs ? `every ${Math.round(job.everyMs / 1000)}s` : job.schedule,
);
const mockNextRunAt = vi.fn(() => Date.parse("2026-04-01T09:00:00.000Z"));

vi.mock("../storage/cron.js", () => ({
  addCronJob: mockAddCronJob,
  getCronJob: mockGetCronJob,
  getCronJobsForChat: mockGetCronJobsForChat,
  updateCronJob: mockUpdateCronJob,
  deleteCronJob: mockDeleteCronJob,
  validateCronExpression: mockValidateCronExpression,
  generateCronId: mockGenerateCronId,
  describeSchedule: mockDescribeSchedule,
  nextRunAt: mockNextRunAt,
  loadCronJobs: vi.fn(),
}));

// Backend controller + model resolver — exercised by the per-job model
// override validation and the list_models / list_backends discovery actions.
const mockGetBackendForChat = vi.fn((): unknown => ({
  background: {},
  models: undefined,
}));
const mockGetBackendIdForChat = vi.fn(() => "claude");
const mockGetAvailableBackends = vi.fn((): { id: string; label: string }[] => [
  { id: "claude", label: "Claude" },
]);
const mockGetPooledBackend = vi.fn((): unknown => null);
const mockRelease = vi.fn(async () => {});
const mockAcquireBackendInstance = vi.fn(
  async (): Promise<{ backend: unknown; release: () => Promise<void> }> => {
    throw new Error("not stubbed");
  },
);
const mockIsModelValidForBackend = vi.fn(async () => true);
vi.mock("../core/engine/backend-controller/index.js", () => ({
  getBackendForChat: mockGetBackendForChat,
  getBackendIdForChat: mockGetBackendIdForChat,
  getAvailableBackends: mockGetAvailableBackends,
  // The router's usage snapshot reads the pool through these two.
  listAvailableBackends: mockGetAvailableBackends,
  getPoolConfig: () => null,
  getPooledBackend: mockGetPooledBackend,
  acquireBackendInstance: mockAcquireBackendInstance,
  isModelValidForBackend: mockIsModelValidForBackend,
}));

const mockResolveExplicitModelRef = vi.fn(async (): Promise<unknown> => null);
vi.mock("../core/models/active-model.js", () => ({
  resolveExplicitModelRef: mockResolveExplicitModelRef,
}));

// fetch_url resolves every host before fetching (SSRF guard); keep the
// test hosts public and offline.
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup: vi.fn(async () => [{ address: "93.184.215.14", family: 4 }]),
}));

// Mock node:fs for fetch_url binary download path
const mockExistsSync = vi.fn(() => true);
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  readFileSync: vi.fn(),
}));

// The fetch ladder's impersonation rungs need the curl-impersonate binary;
// keep it "not installed" here so every fetch_url case exercises the plain
// rung against the stubbed global fetch (and nothing is downloaded).
vi.mock("../core/fetch/curl-impersonate.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../core/fetch/curl-impersonate.js")
  >()),
  resolveCurlImpersonate: vi.fn(async () => {
    throw new Error("curl-impersonate not installed (test)");
  }),
}));

const { handleSharedAction, handleChatFreeAction, isChatFreeAction } =
  await import("../core/engine/gateway-actions/index.js");
const { registerCrossSendTarget } =
  await import("../core/engine/gateway-actions/cross-send.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal mock Response for `fetch`. */
function mockResponse(opts: {
  ok?: boolean;
  status?: number;
  contentType?: string;
  body?: string;
  arrayBuffer?: ArrayBuffer;
}): Response {
  const headers = new Headers();
  if (opts.contentType) headers.set("content-type", opts.contentType);
  const body = opts.arrayBuffer ?? opts.body ?? "";
  return new Response(body, {
    status: opts.status ?? (opts.ok === false ? 500 : 200),
    headers,
  });
}

/** Create an ArrayBuffer with valid image magic bytes. */
function imageBuffer(
  type: "png" | "jpg" | "gif" | "webp",
  size = 1024,
): ArrayBuffer {
  const buf = new ArrayBuffer(Math.max(size, 16));
  const view = new Uint8Array(buf);
  switch (type) {
    case "png":
      // Signature plus the IHDR chunk header every real PNG starts with.
      view.set([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52,
      ]);
      break;
    case "jpg":
      view.set([0xff, 0xd8, 0xff, 0xe0]);
      break;
    case "gif":
      view.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      break;
    case "webp":
      view.set([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      ]);
      break;
  }
  return buf;
}

function documentBuffer(type: "pdf" | "zip", size = 1024): ArrayBuffer {
  const buf = new ArrayBuffer(Math.max(size, 16));
  const view = new Uint8Array(buf);
  view.set(
    type === "pdf"
      ? new TextEncoder().encode("%PDF-1.7")
      : [0x50, 0x4b, 0x03, 0x04],
  );
  return buf;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("gateway shared actions", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
    vi.clearAllMocks();
    mockCronJobs.clear();
    mockValidateCronExpression.mockReset();
    mockNextRunAt.mockReset();
    mockDescribeSchedule.mockReset();
    mockGetCronJob.mockImplementation((id: string) => mockCronJobs.get(id));
    mockGetCronJobsForChat.mockReturnValue([]);
    mockDescribeSchedule.mockImplementation((job: any) =>
      job.everyMs ? `every ${Math.round(job.everyMs / 1000)}s` : job.schedule,
    );
    mockNextRunAt.mockReturnValue(Date.parse("2026-04-01T09:00:00.000Z"));
    mockValidateCronExpression.mockReturnValue({
      valid: true,
      next: "2026-04-01T09:00:00.000Z",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  // ════════════════════════════════════════════════════════════════════════
  // Unknown actions
  // ════════════════════════════════════════════════════════════════════════

  describe("unknown actions", () => {
    it("returns null for unknown actions", async () => {
      expect(
        await handleSharedAction({ action: "unknown_thing" }, 123),
      ).toBeNull();
    });

    it("returns null for empty action", async () => {
      expect(await handleSharedAction({ action: "" }, 123)).toBeNull();
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // History actions
  // ════════════════════════════════════════════════════════════════════════

  describe("read_history", () => {
    it("returns formatted history with default limit", async () => {
      const result = await handleSharedAction({ action: "read_history" }, 42);
      expect(result).toEqual({ ok: true, text: "history lines here" });
      expect(mockGetRecentFormatted).toHaveBeenCalledWith("42", 30);
    });

    it("reads under the canonical chat key when the gateway supplies one", async () => {
      await handleSharedAction(
        { action: "read_history" },
        42,
        undefined,
        "d_native",
      );
      expect(mockGetRecentFormatted).toHaveBeenCalledWith("d_native", 30);
    });

    it("passes custom limit", async () => {
      await handleSharedAction({ action: "read_history", limit: 10 }, 42);
      expect(mockGetRecentFormatted).toHaveBeenCalledWith("42", 10);
    });

    it("clamps limit to 100", async () => {
      await handleSharedAction({ action: "read_history", limit: 500 }, 42);
      expect(mockGetRecentFormatted).toHaveBeenCalledWith("42", 100);
    });

    it("clamps limit=200 to 100", async () => {
      await handleSharedAction({ action: "read_history", limit: 200 }, 42);
      expect(mockGetRecentFormatted).toHaveBeenCalledWith("42", 100);
    });

    it("converts chatId to string", async () => {
      await handleSharedAction({ action: "read_history" }, 999);
      expect(mockGetRecentFormatted).toHaveBeenCalledWith("999", 30);
    });
  });

  describe("search_history", () => {
    it("returns search results with default limit", async () => {
      const result = await handleSharedAction(
        { action: "search_history", query: "hello" },
        42,
      );
      expect(result).toEqual({ ok: true, text: "search results here" });
      expect(mockSearchHistory).toHaveBeenCalledWith("42", "hello", 20, {
        after: undefined,
        before: undefined,
      });
    });

    it("passes custom limit", async () => {
      await handleSharedAction(
        { action: "search_history", query: "test", limit: 5 },
        42,
      );
      expect(mockSearchHistory).toHaveBeenCalledWith("42", "test", 5, {
        after: undefined,
        before: undefined,
      });
    });

    it("clamps limit to 100", async () => {
      await handleSharedAction(
        { action: "search_history", query: "test", limit: 999 },
        42,
      );
      expect(mockSearchHistory).toHaveBeenCalledWith("42", "test", 100, {
        after: undefined,
        before: undefined,
      });
    });

    it("uses empty string when query is missing", async () => {
      await handleSharedAction({ action: "search_history" }, 42);
      expect(mockSearchHistory).toHaveBeenCalledWith("42", "", 20, {
        after: undefined,
        before: undefined,
      });
    });
  });

  describe("get_user_messages", () => {
    it("returns user messages with default limit", async () => {
      const result = await handleSharedAction(
        { action: "get_user_messages", user_name: "alice" },
        42,
      );
      expect(result).toEqual({ ok: true, text: "user messages here" });
      expect(mockGetMessagesByUser).toHaveBeenCalledWith("42", "alice", 20);
    });

    it("passes custom limit", async () => {
      await handleSharedAction(
        { action: "get_user_messages", user_name: "bob", limit: 10 },
        42,
      );
      expect(mockGetMessagesByUser).toHaveBeenCalledWith("42", "bob", 10);
    });

    it("clamps limit to 50", async () => {
      await handleSharedAction(
        { action: "get_user_messages", user_name: "bob", limit: 200 },
        42,
      );
      expect(mockGetMessagesByUser).toHaveBeenCalledWith("42", "bob", 50);
    });

    it("uses empty string when user_name is missing", async () => {
      await handleSharedAction({ action: "get_user_messages" }, 42);
      expect(mockGetMessagesByUser).toHaveBeenCalledWith("42", "", 20);
    });
  });

  describe("list_known_users", () => {
    it("returns known users", async () => {
      const result = await handleSharedAction(
        { action: "list_known_users" },
        42,
      );
      expect(result).toEqual({ ok: true, text: "alice, bob" });
      expect(mockGetKnownUsers).toHaveBeenCalledWith("42");
    });
  });

  describe("list_media", () => {
    it("returns media index with default limit", async () => {
      const result = await handleSharedAction({ action: "list_media" }, 42);
      expect(result).toEqual({ ok: true, text: "media index here" });
      expect(mockFormatMediaIndex).toHaveBeenCalledWith("42", 10);
    });

    it("passes custom limit", async () => {
      await handleSharedAction({ action: "list_media", limit: 5 }, 42);
      expect(mockFormatMediaIndex).toHaveBeenCalledWith("42", 5);
    });

    it("clamps limit to 20", async () => {
      await handleSharedAction({ action: "list_media", limit: 100 }, 42);
      expect(mockFormatMediaIndex).toHaveBeenCalledWith("42", 20);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // fetch_url
  // ════════════════════════════════════════════════════════════════════════

  describe("fetch_url", () => {
    it("rejects missing URL", async () => {
      const result = await handleSharedAction({ action: "fetch_url" }, 123);
      expect(result).toEqual({ ok: false, error: "Missing URL" });
    });

    it("rejects non-http protocols", async () => {
      const result = await handleSharedAction(
        { action: "fetch_url", url: "ftp://example.com" },
        123,
      );
      expect(result?.ok).toBe(false);
      expect(result?.error).toContain("http or https");
    });

    it("rejects malformed URLs", async () => {
      const result = await handleSharedAction(
        { action: "fetch_url", url: "not a url at all" },
        123,
      );
      expect(result).toEqual({ ok: false, error: "Invalid URL" });
    });

    it("rejects javascript: protocol", async () => {
      const result = await handleSharedAction(
        { action: "fetch_url", url: "javascript:alert(1)" },
        123,
      );
      expect(result?.ok).toBe(false);
    });

    it("rejects data: protocol", async () => {
      const result = await handleSharedAction(
        { action: "fetch_url", url: "data:text/html,<h1>hi</h1>" },
        123,
      );
      expect(result?.ok).toBe(false);
    });

    it("fetches text page and strips HTML", async () => {
      const htmlBody = `<html><head><title>Test</title></head><body>
        <script>var x = 1;</script>
        <style>.foo { color: red; }</style>
        <h1>Hello World</h1>
        <p>This is a &amp; test with &lt;tags&gt; and &nbsp; entities.</p>
      </body></html>`;
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "text/html; charset=utf-8",
          body: htmlBody,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com" },
        123,
      );

      expect(result?.ok).toBe(true);
      // Script and style content should be stripped
      expect(result?.text).not.toContain("var x = 1");
      expect(result?.text).not.toContain("color: red");
      // HTML tags stripped, entities decoded
      expect(result?.text).toContain("Hello World");
      expect(result?.text).toContain("This is a & test with <tags> and");
    });

    it("returns JSON content as text", async () => {
      const jsonBody = '{"key": "value", "count": 42}';
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "application/json",
          body: jsonBody,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://api.example.com/data" },
        123,
      );

      expect(result?.ok).toBe(true);
      expect(result?.text).toContain('"key": "value"');
    });

    it("returns structured JSON media types as text", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(
          mockResponse({
            ok: true,
            contentType: "application/problem+json",
            body: '{"title":"Rate limited","status":429}',
          }),
        ),
      );

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://api.example.com/problem" },
        123,
      );

      expect(result?.ok).toBe(true);
      expect(result?.text).toContain("Rate limited");
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("returns short JSON bodies verbatim instead of discarding them", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(
          mockResponse({
            ok: true,
            contentType: "application/json",
            body: '{"status":"ok"}',
          }),
        ),
      );

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://api.example.com/health" },
        123,
      );

      expect(result).toEqual({
        ok: true,
        text: '{"status":"ok"}\n\n[fetched via plain]',
      });
    });

    it("decodes text using the response charset", async () => {
      const encoded = Uint8Array.from(
        Buffer.from("Hello from a UTF-16 page — café", "utf16le"),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(
          mockResponse({
            ok: true,
            contentType: "text/plain; charset=utf-16le",
            arrayBuffer: encoded.buffer,
          }),
        ),
      );

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/utf16" },
        123,
      );

      expect(result).toEqual({
        ok: true,
        text: "Hello from a UTF-16 page — café\n\n[fetched via plain]",
      });
    });

    it("sniffs headerless HTML as text instead of saving it as binary", async () => {
      const encoded = new TextEncoder().encode(
        "<!doctype html><html><body><h1>Headerless page content is readable</h1></body></html>",
      );
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(
          mockResponse({
            ok: true,
            arrayBuffer: encoded.buffer,
          }),
        ),
      );

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/headerless" },
        123,
      );

      expect(result?.ok).toBe(true);
      expect(result?.text).toContain("Headerless page content is readable");
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("truncates large text content with an explicit marker", async () => {
      const longText = "A".repeat(60_000);
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "text/plain",
          body: longText,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/big" },
        123,
      );

      expect(result?.ok).toBe(true);
      expect(result?.text!.startsWith("AAA")).toBe(true);
      expect(result?.text).toContain("[Content truncated at 50000 characters]");
      expect(result?.text!.length).toBeLessThan(60_000);
    });

    it("returns message for pages with no readable content", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "text/html",
          body: "<html><body>  </body></html>",
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://empty.com" },
        123,
      );

      expect(result?.ok).toBe(true);
      expect(result?.text).toBe(
        "(Page has no readable content)\n\n[fetched via plain]",
      );
    });

    it("returns HTTP error for non-ok response", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 404,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/missing" },
        123,
      );

      // A 404 is a wrong URL, not a bot wall: reported as such, no climbing.
      expect(result?.ok).toBe(false);
      expect(result?.error).toMatch(/^HTTP 404 via plain — /);
      expect(result?.error).toContain("wrong URL, not a block");
    });

    it("returns HTTP 500 error", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 500,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/error" },
        123,
      );

      expect(result).toEqual({ ok: false, error: "HTTP 500 via plain" });
    });

    it("handles network errors", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"));
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://down.example.com" },
        123,
      );

      expect(result?.ok).toBe(false);
      expect(result?.error).toContain("Could not reach the site on any rung");
      expect(result?.error).toContain("plain ECONNREFUSED");
    });

    it("handles timeout errors", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(
          new Error("The operation was aborted due to timeout"),
        );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://slow.example.com" },
        123,
      );

      expect(result?.ok).toBe(false);
      expect(result?.error).toContain("Could not reach the site");
      expect(result?.error).toContain("timeout");
    });

    it("handles non-Error thrown values", async () => {
      const mockFetch = vi.fn().mockRejectedValueOnce("string error");
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://weird.example.com" },
        123,
      );

      expect(result?.ok).toBe(false);
      expect(result?.error).toContain("plain string error");
    });

    // ── Binary download tests ─────────────────────────────────────────────

    it("downloads binary PNG file", async () => {
      const buffer = imageBuffer("png");
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "image/png",
          arrayBuffer: buffer,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);
      mockExistsSync.mockReturnValue(true);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/img.png" },
        123,
      );

      expect(result?.ok).toBe(true);
      expect(result?.text).toContain("Downloaded image");
      expect(result?.text).toContain("1KB");
      expect(result?.text).toContain(".png");
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    });

    it("downloads JPEG file", async () => {
      const buffer = imageBuffer("jpg", 2048);
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "image/jpeg",
          arrayBuffer: buffer,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);
      mockExistsSync.mockReturnValue(true);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/photo.jpg" },
        123,
      );

      expect(result?.ok).toBe(true);
      expect(result?.text).toContain(".jpg");
      expect(result?.text).toContain("image");
    });

    it("downloads GIF file", async () => {
      const buffer = imageBuffer("gif", 512);
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "image/gif",
          arrayBuffer: buffer,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/anim.gif" },
        123,
      );

      expect(result?.ok).toBe(true);
      expect(result?.text).toContain(".gif");
    });

    it("downloads WebP file", async () => {
      const buffer = imageBuffer("webp", 512);
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "image/webp",
          arrayBuffer: buffer,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/pic.webp" },
        123,
      );

      expect(result?.ok).toBe(true);
      expect(result?.text).toContain(".webp");
    });

    it("downloads PDF file", async () => {
      const buffer = documentBuffer("pdf", 4096);
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "application/pdf",
          arrayBuffer: buffer,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/doc.pdf" },
        123,
      );

      expect(result?.ok).toBe(true);
      expect(result?.text).toContain(".pdf");
      expect(result?.text).toContain("pdf");
    });

    it("downloads ZIP file", async () => {
      const buffer = documentBuffer("zip", 8192);
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "application/zip",
          arrayBuffer: buffer,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/archive.zip" },
        123,
      );

      expect(result?.ok).toBe(true);
      expect(result?.text).toContain(".zip");
    });

    it("uses .bin extension for unknown binary types", async () => {
      const buffer = new ArrayBuffer(256);
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "application/octet-stream",
          arrayBuffer: buffer,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/data" },
        123,
      );

      expect(result?.ok).toBe(true);
      expect(result?.text).toContain(".bin");
    });

    it("creates uploads directory when it does not exist", async () => {
      const buffer = imageBuffer("png", 256);
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "image/png",
          arrayBuffer: buffer,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);
      mockExistsSync.mockReturnValue(false);

      await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/img.png" },
        123,
      );

      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("uploads"),
        { recursive: true },
      );
    });

    it("does not create uploads directory when it exists", async () => {
      const buffer = imageBuffer("png", 256);
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "image/png",
          arrayBuffer: buffer,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);
      mockExistsSync.mockReturnValue(true);

      await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/img.png" },
        123,
      );

      expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it("rejects chunked binary responses larger than 50MB", async () => {
      const buffer = new ArrayBuffer(51 * 1024 * 1024); // 51MB
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "image/png",
          arrayBuffer: buffer,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/huge.png" },
        123,
      );

      expect(result?.ok).toBe(false);
      expect(result?.error).toContain("Response too large");
      expect(result?.error).toContain("50MB");
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("rejects chunked text responses larger than 50MB", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "text/plain",
          body: "A".repeat(51 * 1024 * 1024),
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/huge.txt" },
        123,
      );

      expect(result).toEqual({
        ok: false,
        error: "Response too large (max 50MB)",
      });
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("includes send instructions in download response", async () => {
      const buffer = imageBuffer("png");
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "image/png",
          arrayBuffer: buffer,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/img.png" },
        123,
      );

      expect(result?.text).toContain("Read it with the Read tool");
      expect(result?.text).toContain('send(type="file"');
    });

    it("rejects HTML error page disguised as image (magic byte validation)", async () => {
      const htmlError = new TextEncoder().encode(
        "<!DOCTYPE html><html><body>Wikimedia Error</body></html>",
      );
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "image/jpeg",
          arrayBuffer: htmlError.buffer,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://upload.wikimedia.org/img.jpg" },
        123,
      );

      expect(result?.ok).toBe(false);
      expect(result?.error).toContain("invalid image content");
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("rejects HTML error page disguised as a PDF", async () => {
      const htmlError = new TextEncoder().encode(
        "<!DOCTYPE html><html><body>Access denied</body></html>",
      );
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(
          mockResponse({
            ok: true,
            contentType: "application/pdf",
            arrayBuffer: htmlError.buffer,
          }),
        ),
      );

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/report.pdf" },
        123,
      );

      expect(result?.ok).toBe(false);
      expect(result?.error).toContain("invalid pdf content");
      expect(result?.error).toContain("Access denied");
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("detects PDF magic bytes when the server uses a generic content type", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(
          mockResponse({
            ok: true,
            contentType: "application/octet-stream",
            arrayBuffer: documentBuffer("pdf"),
          }),
        ),
      );

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/download" },
        123,
      );

      expect(result?.ok).toBe(true);
      expect(result?.text).toContain("Downloaded pdf");
      expect(result?.text).toContain(".pdf");
    });

    it("rejects empty response", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "image/png",
          arrayBuffer: new ArrayBuffer(0),
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/empty.png" },
        123,
      );

      expect(result?.ok).toBe(false);
      expect(result?.error).toContain("Empty response");
    });

    it("passes User-Agent header in fetch", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "text/html",
          body: "<p>Content here is enough to pass the 20 char minimum check test</p>",
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      await handleSharedAction(
        { action: "fetch_url", url: "https://example.com" },
        123,
      );

      // Redirects are followed by hand so each hop is SSRF-checked.
      expect(mockFetch).toHaveBeenCalledWith(
        new URL("https://example.com"),
        expect.objectContaining({
          headers: { "User-Agent": "Talon/1.0" },
          redirect: "manual",
        }),
      );
    });

    it("labels non-image binary as content subtype", async () => {
      const buffer = documentBuffer("pdf", 512);
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockResponse({
          ok: true,
          contentType: "application/pdf",
          arrayBuffer: buffer,
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const result = await handleSharedAction(
        { action: "fetch_url", url: "https://example.com/doc.pdf" },
        123,
      );

      // For non-image types, it uses ct.split("/")[1]?.split(";")[0] => "pdf"
      expect(result?.text).toContain("Downloaded pdf");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Cron CRUD
  // ════════════════════════════════════════════════════════════════════════

  describe("cron CRUD", () => {
    // ── create_cron_job ─────────────────────────────────────────────────

    describe("create_cron_job", () => {
      it("creates a cron job with all fields", async () => {
        const result = await handleSharedAction(
          {
            action: "create_cron_job",
            name: "Morning Greeting",
            schedule: "0 9 * * *",
            type: "message",
            content: "Good morning!",
            timezone: "America/New_York",
          },
          42,
        );

        expect(result?.ok).toBe(true);
        expect(result?.text).toContain('Created cron job "Morning Greeting"');
        expect(result?.text).toContain("test-id-123");
        expect(result?.text).toContain("0 9 * * *");
        expect(result?.text).toContain("Type: message");
        expect(mockAddCronJob).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "test-id-123",
            chatId: "42",
            schedule: "0 9 * * *",
            type: "message",
            content: "Good morning!",
            name: "Morning Greeting",
            enabled: true,
            timezone: "America/New_York",
          }),
        );
      });

      it("uses default name when not provided", async () => {
        await handleSharedAction(
          {
            action: "create_cron_job",
            schedule: "0 9 * * *",
            content: "hi",
          },
          42,
        );

        expect(mockAddCronJob).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "Unnamed job",
          }),
        );
      });

      it("uses default type 'message' when not specified", async () => {
        await handleSharedAction(
          {
            action: "create_cron_job",
            schedule: "*/5 * * * *",
            content: "ping",
          },
          42,
        );

        expect(mockAddCronJob).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "message",
          }),
        );
      });

      it("rejects missing cadence", async () => {
        const result = await handleSharedAction(
          {
            action: "create_cron_job",
            name: "test",
            content: "hi",
          },
          123,
        );
        expect(result).toEqual({
          ok: false,
          error:
            "Provide either 'schedule' (a cron expression) or 'every_seconds' (a fixed interval).",
        });
      });

      it("rejects missing content", async () => {
        const result = await handleSharedAction(
          {
            action: "create_cron_job",
            name: "test",
            schedule: "0 9 * * *",
          },
          123,
        );
        expect(result).toEqual({ ok: false, error: "Missing content" });
      });

      it("rejects content over 10,000 chars", async () => {
        const result = await handleSharedAction(
          {
            action: "create_cron_job",
            name: "test",
            schedule: "0 9 * * *",
            content: "x".repeat(10001),
          },
          123,
        );
        expect(result?.ok).toBe(false);
        expect(result?.error).toContain("too long");
        expect(result?.error).toContain("10,000");
      });

      it("rejects invalid cron expression", async () => {
        mockValidateCronExpression.mockReturnValueOnce({
          valid: false,
          error: "bad syntax",
        });

        const result = await handleSharedAction(
          {
            action: "create_cron_job",
            name: "test",
            schedule: "not valid",
            content: "hi",
          },
          123,
        );

        expect(result?.ok).toBe(false);
        expect(result?.error).toContain("Invalid cron expression");
        expect(result?.error).toContain("bad syntax");
      });

      it("includes next run time in response", async () => {
        mockValidateCronExpression.mockReturnValueOnce({
          valid: true,
          next: "2026-04-01T09:00:00.000Z",
        });

        const result = await handleSharedAction(
          {
            action: "create_cron_job",
            schedule: "0 9 * * *",
            content: "morning",
          },
          123,
        );

        expect(result?.text).toContain("2026-04-01T09:00:00.000Z");
      });

      it("shows 'unknown' when next run time is not available", async () => {
        mockNextRunAt.mockReturnValueOnce(null as unknown as number);

        const result = await handleSharedAction(
          {
            action: "create_cron_job",
            schedule: "0 9 * * *",
            content: "morning",
          },
          123,
        );

        expect(result?.text).toContain("Next run: unknown");
      });

      it("passes timezone to validation", async () => {
        await handleSharedAction(
          {
            action: "create_cron_job",
            schedule: "0 9 * * *",
            content: "hi",
            timezone: "Europe/London",
          },
          123,
        );

        expect(mockValidateCronExpression).toHaveBeenCalledWith(
          "0 9 * * *",
          "Europe/London",
        );
      });

      it("passes undefined timezone when not specified", async () => {
        await handleSharedAction(
          {
            action: "create_cron_job",
            schedule: "0 9 * * *",
            content: "hi",
          },
          123,
        );

        expect(mockValidateCronExpression).toHaveBeenCalledWith(
          "0 9 * * *",
          undefined,
        );
      });
    });

    // ── list_cron_jobs ──────────────────────────────────────────────────

    describe("list_cron_jobs", () => {
      it("returns 'no cron jobs' when empty", async () => {
        mockGetCronJobsForChat.mockReturnValue([]);

        const result = await handleSharedAction(
          { action: "list_cron_jobs" },
          42,
        );

        expect(result).toEqual({
          ok: true,
          text: "No cron jobs in this chat.",
        });
      });

      it("lists existing jobs with all details", async () => {
        mockGetCronJobsForChat.mockReturnValue([
          {
            id: "job-1",
            chatId: "42",
            schedule: "0 9 * * *",
            type: "message",
            content: "Good morning!",
            name: "Morning Greeting",
            enabled: true,
            createdAt: 1700000000000,
            runCount: 5,
            lastRunAt: 1700086400000,
            timezone: "America/New_York",
          },
        ]);
        mockValidateCronExpression.mockReturnValueOnce({
          valid: true,
          next: new Date("2026-04-02T09:00:00Z").toISOString(),
        });

        const result = await handleSharedAction(
          { action: "list_cron_jobs" },
          42,
        );

        expect(result?.ok).toBe(true);
        expect(result?.text).toContain("Cron jobs (1)");
        expect(result?.text).toContain("Morning Greeting (enabled)");
        expect(result?.text).toContain("ID: job-1");
        expect(result?.text).toContain("0 9 * * *");
        expect(result?.text).toContain("America/New_York");
        expect(result?.text).toContain("Type: message");
        expect(result?.text).toContain("Good morning!");
        expect(result?.text).toContain("Runs: 5");
      });

      it("shows 'never' for lastRun when not set", async () => {
        mockGetCronJobsForChat.mockReturnValue([
          {
            id: "job-2",
            chatId: "42",
            schedule: "*/5 * * * *",
            type: "query",
            content: "check status",
            name: "Status Check",
            enabled: true,
            createdAt: 1700000000000,
            runCount: 0,
          },
        ]);
        mockValidateCronExpression.mockReturnValueOnce({
          valid: true,
          next: new Date(Date.now() + 60000).toISOString(),
        });

        const result = await handleSharedAction(
          { action: "list_cron_jobs" },
          42,
        );

        expect(result?.text).toContain("Last: never");
      });

      it("shows disabled status", async () => {
        mockGetCronJobsForChat.mockReturnValue([
          {
            id: "job-3",
            chatId: "42",
            schedule: "0 12 * * *",
            type: "message",
            content: "lunch!",
            name: "Lunch Alert",
            enabled: false,
            createdAt: 1700000000000,
            runCount: 10,
            lastRunAt: 1700100000000,
          },
        ]);
        mockValidateCronExpression.mockReturnValueOnce({ valid: true });

        const result = await handleSharedAction(
          { action: "list_cron_jobs" },
          42,
        );

        expect(result?.text).toContain("Lunch Alert (disabled)");
      });

      it("shows em dash for nextRun when nextRunAt returns null", async () => {
        mockGetCronJobsForChat.mockReturnValue([
          {
            id: "job-4",
            chatId: "42",
            schedule: "bad",
            type: "message",
            content: "x",
            name: "Bad Job",
            enabled: true,
            createdAt: 1700000000000,
            runCount: 0,
          },
        ]);
        mockNextRunAt.mockReturnValueOnce(null as unknown as number);

        const result = await handleSharedAction(
          { action: "list_cron_jobs" },
          42,
        );

        expect(result?.text).toContain("Next: —");
      });

      it("truncates long content to 100 chars with ellipsis", async () => {
        const longContent = "B".repeat(200);
        mockGetCronJobsForChat.mockReturnValue([
          {
            id: "job-5",
            chatId: "42",
            schedule: "0 * * * *",
            type: "message",
            content: longContent,
            name: "Long",
            enabled: true,
            createdAt: 1700000000000,
            runCount: 0,
          },
        ]);
        mockValidateCronExpression.mockReturnValueOnce({
          valid: true,
          next: new Date().toISOString(),
        });

        const result = await handleSharedAction(
          { action: "list_cron_jobs" },
          42,
        );

        expect(result?.text).toContain("B".repeat(100) + "...");
        expect(result?.text).not.toContain("B".repeat(101));
      });

      it("lists multiple jobs", async () => {
        mockGetCronJobsForChat.mockReturnValue([
          {
            id: "j1",
            chatId: "42",
            schedule: "0 9 * * *",
            type: "message",
            content: "morning",
            name: "Job A",
            enabled: true,
            createdAt: 1700000000000,
            runCount: 1,
          },
          {
            id: "j2",
            chatId: "42",
            schedule: "0 17 * * *",
            type: "query",
            content: "evening",
            name: "Job B",
            enabled: false,
            createdAt: 1700000000000,
            runCount: 2,
          },
        ]);
        mockValidateCronExpression.mockReturnValueOnce({
          valid: true,
          next: new Date().toISOString(),
        });
        mockValidateCronExpression.mockReturnValueOnce({
          valid: true,
          next: new Date().toISOString(),
        });

        const result = await handleSharedAction(
          { action: "list_cron_jobs" },
          42,
        );

        expect(result?.text).toContain("Cron jobs (2)");
        expect(result?.text).toContain("Job A");
        expect(result?.text).toContain("Job B");
      });

      it("shows no timezone when not set", async () => {
        mockGetCronJobsForChat.mockReturnValue([
          {
            id: "j-tz",
            chatId: "42",
            schedule: "0 9 * * *",
            type: "message",
            content: "hi",
            name: "No TZ",
            enabled: true,
            createdAt: 1700000000000,
            runCount: 0,
          },
        ]);
        mockValidateCronExpression.mockReturnValueOnce({
          valid: true,
          next: new Date().toISOString(),
        });

        const result = await handleSharedAction(
          { action: "list_cron_jobs" },
          42,
        );

        // Should show schedule without timezone in parens
        expect(result?.text).toContain("Schedule: 0 9 * * *");
        expect(result?.text).not.toContain("Schedule: 0 9 * * * (");
      });
    });

    // ── edit_cron_job ───────────────────────────────────────────────────

    describe("edit_cron_job", () => {
      it("rejects missing job_id", async () => {
        const result = await handleSharedAction(
          { action: "edit_cron_job" },
          123,
        );
        expect(result).toEqual({ ok: false, error: "Missing job_id" });
      });

      it("rejects non-existent job", async () => {
        mockGetCronJob.mockReturnValue(undefined);

        const result = await handleSharedAction(
          { action: "edit_cron_job", job_id: "nonexistent" },
          123,
        );

        expect(result?.ok).toBe(false);
        expect(result?.error).toContain("not found");
      });

      it("rejects job from different chat", async () => {
        mockGetCronJob.mockReturnValue({
          id: "job-x",
          chatId: "999",
          schedule: "0 9 * * *",
          type: "message",
          content: "hi",
          name: "Other Chat",
          enabled: true,
          createdAt: 1700000000000,
          runCount: 0,
        });

        const result = await handleSharedAction(
          { action: "edit_cron_job", job_id: "job-x" },
          123,
        );

        expect(result?.ok).toBe(false);
        expect(result?.error).toBe("Job belongs to a different chat");
      });

      it("updates job name", async () => {
        mockGetCronJob.mockReturnValue({
          id: "job-e1",
          chatId: "123",
          schedule: "0 9 * * *",
          type: "message",
          content: "hi",
          name: "Old Name",
          enabled: true,
          createdAt: 1700000000000,
          runCount: 0,
        });
        mockUpdateCronJob.mockReturnValue({ name: "New Name" });

        const result = await handleSharedAction(
          {
            action: "edit_cron_job",
            job_id: "job-e1",
            name: "New Name",
          },
          123,
        );

        expect(result?.ok).toBe(true);
        expect(result?.text).toContain("New Name");
        expect(result?.text).toContain("Fields changed: name");
        expect(mockUpdateCronJob).toHaveBeenCalledWith("job-e1", {
          name: "New Name",
        });
      });

      it("updates content", async () => {
        mockGetCronJob.mockReturnValue({
          id: "job-e2",
          chatId: "123",
          schedule: "0 9 * * *",
          type: "message",
          content: "old",
          name: "Job",
          enabled: true,
          createdAt: 1700000000000,
          runCount: 0,
        });
        mockUpdateCronJob.mockReturnValue({ name: "Job" });

        const result = await handleSharedAction(
          {
            action: "edit_cron_job",
            job_id: "job-e2",
            content: "new content",
          },
          123,
        );

        expect(result?.ok).toBe(true);
        expect(mockUpdateCronJob).toHaveBeenCalledWith("job-e2", {
          content: "new content",
        });
      });

      it("updates enabled flag", async () => {
        mockGetCronJob.mockReturnValue({
          id: "job-e3",
          chatId: "123",
          schedule: "0 9 * * *",
          type: "message",
          content: "hi",
          name: "Job",
          enabled: true,
          createdAt: 1700000000000,
          runCount: 0,
        });
        mockUpdateCronJob.mockReturnValue({ name: "Job" });

        const result = await handleSharedAction(
          {
            action: "edit_cron_job",
            job_id: "job-e3",
            enabled: false,
          },
          123,
        );

        expect(result?.ok).toBe(true);
        expect(mockUpdateCronJob).toHaveBeenCalledWith("job-e3", {
          enabled: false,
        });
      });

      it("updates schedule with validation", async () => {
        mockGetCronJob.mockReturnValue({
          id: "job-e4",
          chatId: "123",
          schedule: "0 9 * * *",
          type: "message",
          content: "hi",
          name: "Job",
          enabled: true,
          createdAt: 1700000000000,
          runCount: 0,
          timezone: "America/New_York",
        });
        mockValidateCronExpression.mockReturnValueOnce({
          valid: true,
          next: "2026-05-01T12:00:00Z",
        });
        mockUpdateCronJob.mockReturnValue({ name: "Job" });

        const result = await handleSharedAction(
          {
            action: "edit_cron_job",
            job_id: "job-e4",
            schedule: "0 12 * * *",
          },
          123,
        );

        expect(result?.ok).toBe(true);
        expect(mockValidateCronExpression).toHaveBeenCalledWith(
          "0 12 * * *",
          "America/New_York",
        );
        expect(mockUpdateCronJob).toHaveBeenCalledWith("job-e4", {
          schedule: "0 12 * * *",
        });
      });

      it("rejects invalid schedule update", async () => {
        mockGetCronJob.mockReturnValue({
          id: "job-e5",
          chatId: "123",
          schedule: "0 9 * * *",
          type: "message",
          content: "hi",
          name: "Job",
          enabled: true,
          createdAt: 1700000000000,
          runCount: 0,
        });
        mockValidateCronExpression.mockReturnValueOnce({
          valid: false,
          error: "too many fields",
        });

        const result = await handleSharedAction(
          {
            action: "edit_cron_job",
            job_id: "job-e5",
            schedule: "bad schedule",
          },
          123,
        );

        expect(result?.ok).toBe(false);
        expect(result?.error).toContain("Invalid cron expression");
        expect(result?.error).toContain("too many fields");
        expect(mockUpdateCronJob).not.toHaveBeenCalled();
      });

      it("updates multiple fields at once", async () => {
        mockGetCronJob.mockReturnValue({
          id: "job-e6",
          chatId: "123",
          schedule: "0 9 * * *",
          type: "message",
          content: "hi",
          name: "Job",
          enabled: true,
          createdAt: 1700000000000,
          runCount: 0,
        });
        mockUpdateCronJob.mockReturnValue({ name: "Updated" });

        const result = await handleSharedAction(
          {
            action: "edit_cron_job",
            job_id: "job-e6",
            name: "Updated",
            content: "new",
            enabled: false,
            type: "query",
          },
          123,
        );

        expect(result?.ok).toBe(true);
        expect(result?.text).toContain(
          "Fields changed: name, content, enabled, type",
        );
        expect(mockUpdateCronJob).toHaveBeenCalledWith("job-e6", {
          name: "Updated",
          content: "new",
          enabled: false,
          type: "query",
        });
      });

      it("updates timezone", async () => {
        mockGetCronJob.mockReturnValue({
          id: "job-e7",
          chatId: "123",
          schedule: "0 9 * * *",
          type: "message",
          content: "hi",
          name: "Job",
          enabled: true,
          createdAt: 1700000000000,
          runCount: 0,
        });
        mockUpdateCronJob.mockReturnValue({ name: "Job" });

        const result = await handleSharedAction(
          {
            action: "edit_cron_job",
            job_id: "job-e7",
            timezone: "Europe/Berlin",
          },
          123,
        );

        expect(result?.ok).toBe(true);
        expect(mockUpdateCronJob).toHaveBeenCalledWith("job-e7", {
          timezone: "Europe/Berlin",
        });
      });

      it("clears timezone when set to empty", async () => {
        mockGetCronJob.mockReturnValue({
          id: "job-e8",
          chatId: "123",
          schedule: "0 9 * * *",
          type: "message",
          content: "hi",
          name: "Job",
          enabled: true,
          createdAt: 1700000000000,
          runCount: 0,
          timezone: "America/New_York",
        });
        mockUpdateCronJob.mockReturnValue({ name: "Job" });

        const result = await handleSharedAction(
          {
            action: "edit_cron_job",
            job_id: "job-e8",
            timezone: "",
          },
          123,
        );

        expect(result?.ok).toBe(true);
        expect(mockUpdateCronJob).toHaveBeenCalledWith("job-e8", {
          timezone: undefined,
        });
      });

      it("uses new timezone for schedule validation when both change", async () => {
        mockGetCronJob.mockReturnValue({
          id: "job-e9",
          chatId: "123",
          schedule: "0 9 * * *",
          type: "message",
          content: "hi",
          name: "Job",
          enabled: true,
          createdAt: 1700000000000,
          runCount: 0,
          timezone: "America/New_York",
        });
        mockValidateCronExpression.mockReturnValueOnce({ valid: true });
        mockUpdateCronJob.mockReturnValue({ name: "Job" });

        await handleSharedAction(
          {
            action: "edit_cron_job",
            job_id: "job-e9",
            schedule: "0 12 * * *",
            timezone: "Asia/Tokyo",
          },
          123,
        );

        // Should validate with the NEW timezone, not the old one
        expect(mockValidateCronExpression).toHaveBeenCalledWith(
          "0 12 * * *",
          "Asia/Tokyo",
        );
      });

      it("falls back to job timezone when schedule changes but timezone does not", async () => {
        mockGetCronJob.mockReturnValue({
          id: "job-e10",
          chatId: "123",
          schedule: "0 9 * * *",
          type: "message",
          content: "hi",
          name: "Job",
          enabled: true,
          createdAt: 1700000000000,
          runCount: 0,
          timezone: "US/Pacific",
        });
        mockValidateCronExpression.mockReturnValueOnce({ valid: true });
        mockUpdateCronJob.mockReturnValue({ name: "Job" });

        await handleSharedAction(
          {
            action: "edit_cron_job",
            job_id: "job-e10",
            schedule: "30 8 * * 1-5",
          },
          123,
        );

        expect(mockValidateCronExpression).toHaveBeenCalledWith(
          "30 8 * * 1-5",
          "US/Pacific",
        );
      });

      it("uses job_id as fallback name when updateCronJob returns no name", async () => {
        mockGetCronJob.mockReturnValue({
          id: "job-e11",
          chatId: "123",
          schedule: "0 9 * * *",
          type: "message",
          content: "hi",
          name: "Job",
          enabled: true,
          createdAt: 1700000000000,
          runCount: 0,
        });
        mockUpdateCronJob.mockReturnValue(undefined);

        const result = await handleSharedAction(
          {
            action: "edit_cron_job",
            job_id: "job-e11",
            content: "new",
          },
          123,
        );

        expect(result?.ok).toBe(true);
        expect(result?.text).toContain("job-e11");
      });
    });

    // ── delete_cron_job ─────────────────────────────────────────────────

    describe("delete_cron_job", () => {
      it("rejects missing job_id", async () => {
        const result = await handleSharedAction(
          { action: "delete_cron_job" },
          123,
        );
        expect(result).toEqual({ ok: false, error: "Missing job_id" });
      });

      it("rejects non-existent job", async () => {
        mockGetCronJob.mockReturnValue(undefined);

        const result = await handleSharedAction(
          { action: "delete_cron_job", job_id: "ghost" },
          123,
        );

        expect(result?.ok).toBe(false);
        expect(result?.error).toContain("not found");
      });

      it("rejects job from different chat", async () => {
        mockGetCronJob.mockReturnValue({
          id: "job-d1",
          chatId: "999",
          schedule: "0 9 * * *",
          type: "message",
          content: "hi",
          name: "Other",
          enabled: true,
          createdAt: 1700000000000,
          runCount: 0,
        });

        const result = await handleSharedAction(
          { action: "delete_cron_job", job_id: "job-d1" },
          123,
        );

        expect(result?.ok).toBe(false);
        expect(result?.error).toBe("Job belongs to a different chat");
      });

      it("deletes a job successfully", async () => {
        mockGetCronJob.mockReturnValue({
          id: "job-d2",
          chatId: "123",
          schedule: "0 9 * * *",
          type: "message",
          content: "hi",
          name: "To Delete",
          enabled: true,
          createdAt: 1700000000000,
          runCount: 5,
        });

        const result = await handleSharedAction(
          { action: "delete_cron_job", job_id: "job-d2" },
          123,
        );

        expect(result?.ok).toBe(true);
        expect(result?.text).toContain('Deleted cron job "To Delete"');
        expect(result?.text).toContain("job-d2");
        expect(mockDeleteCronJob).toHaveBeenCalledWith("job-d2");
      });
    });
  });
});

// ── Additional branch coverage for fetch_url ──────────────────────────────

describe("gateway-actions — additional branch coverage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects fetch_url when Content-Length header exceeds the size limit (line 152 TRUE branch)", async () => {
    // Build a response that has a Content-Length header over the 50MB limit
    const headers = new Headers();
    headers.set("content-type", "text/html");
    headers.set("content-length", String(55 * 1024 * 1024)); // 55MB
    const bigResponse = {
      ok: true,
      status: 200,
      headers,
      text: async () => "some text",
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(bigResponse));

    const result = await handleSharedAction(
      { action: "fetch_url", url: "https://example.com/huge.html" },
      123,
    );

    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("too large");
  });

  it("uses empty string when content-type header is absent in fetch_url (line 146 FALSE branch)", async () => {
    // Response with no content-type header and binary content → falls through to binary path
    // ct="" → mimeType="" → isText=false → binary download
    const noCtHeaders = new Headers(); // no content-type
    const buf = new ArrayBuffer(16);
    const view = new Uint8Array(buf);
    view[0] = 0x25; // not a known image magic byte → ext = "bin"
    const noCtResponse = {
      ok: true,
      status: 200,
      headers: noCtHeaders,
      text: async () => "",
      json: async () => ({}),
      arrayBuffer: async () => buf,
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(noCtResponse));

    const result = await handleSharedAction(
      { action: "fetch_url", url: "https://example.com/unknown" },
      123,
    );
    // Should succeed (downloaded as bin), covering ct ?? "" right side and ct.split("/")[1] ?? "file" right side
    expect(result?.ok).toBe(true);
  });
});

// ── Per-job model override + model/backend discovery ────────────────────────

describe("per-job model override + discovery actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCronJobs.clear();
    mockValidateCronExpression.mockReset();
    mockNextRunAt.mockReset();
    mockDescribeSchedule.mockReset();
    mockGetCronJob.mockImplementation((id: string) => mockCronJobs.get(id));
    mockGetCronJobsForChat.mockReturnValue([]);
    mockDescribeSchedule.mockImplementation((job: any) =>
      job.everyMs ? `every ${Math.round(job.everyMs / 1000)}s` : job.schedule,
    );
    mockNextRunAt.mockReturnValue(Date.parse("2026-04-01T09:00:00.000Z"));
    mockGetBackendIdForChat.mockReturnValue("claude");
    mockGetBackendForChat.mockReturnValue({
      background: {},
      models: undefined,
    });
    mockGetPooledBackend.mockReturnValue(null);
    mockGetAvailableBackends.mockReturnValue([
      { id: "claude", label: "Claude" },
    ]);
    mockResolveExplicitModelRef.mockResolvedValue(null);
    mockValidateCronExpression.mockReturnValue({
      valid: true,
      next: "2026-04-01T09:00:00.000Z",
    });
  });

  describe("create_cron_job model override", () => {
    it("rejects a query model that isn't selectable on the chat's backend", async () => {
      mockResolveExplicitModelRef.mockResolvedValue(null);
      const result = await handleSharedAction(
        {
          action: "create_cron_job",
          name: "Cheap job",
          schedule: "0 9 * * *",
          type: "query",
          content: "do a thing",
          model: "bogus-model",
        },
        42,
      );
      expect(result?.ok).toBe(false);
      expect(result?.error).toMatch(/not a selectable model/i);
      expect(mockAddCronJob).not.toHaveBeenCalled();
    });

    it("persists a valid query model", async () => {
      mockResolveExplicitModelRef.mockResolvedValue({
        id: "claude-haiku-4-5",
        backend: "claude",
      });
      const result = await handleSharedAction(
        {
          action: "create_cron_job",
          name: "Cheap job",
          schedule: "0 9 * * *",
          type: "query",
          content: "do a thing",
          model: "claude-haiku-4-5",
        },
        42,
      );
      expect(result?.ok).toBe(true);
      expect(mockAddCronJob).toHaveBeenCalledWith(
        expect.objectContaining({ model: "claude-haiku-4-5", type: "query" }),
      );
    });

    it("rejects a query job with no override when the chat backend cannot run isolated jobs", async () => {
      mockGetBackendIdForChat.mockReturnValue("openai-agents");
      mockGetBackendForChat.mockReturnValue({ models: undefined });

      const result = await handleSharedAction(
        {
          action: "create_cron_job",
          name: "OpenAI Agents job",
          schedule: "0 9 * * *",
          type: "query",
          content: "do a thing",
        },
        42,
      );

      expect(result?.ok).toBe(false);
      expect(result?.error).toBe(
        `Provider "openai-agents" can't run isolated jobs (no background capability).`,
      );
      expect(mockAddCronJob).not.toHaveBeenCalled();
    });

    it("rejects a model override on a non-query job before validating it", async () => {
      const result = await handleSharedAction(
        {
          action: "create_cron_job",
          name: "Msg job",
          schedule: "0 9 * * *",
          type: "message",
          content: "hello",
          model: "claude-haiku-4-5",
        },
        42,
      );
      expect(result?.ok).toBe(false);
      expect(result?.error).toMatch(/only apply to 'query'/i);
      expect(mockResolveExplicitModelRef).not.toHaveBeenCalled();
      expect(mockAddCronJob).not.toHaveBeenCalled();
    });

    it("rejects a provider override without a model", async () => {
      const result = await handleSharedAction(
        {
          action: "create_cron_job",
          name: "X",
          schedule: "0 9 * * *",
          type: "query",
          content: "do a thing",
          provider: "codex",
        },
        42,
      );
      expect(result?.ok).toBe(false);
      expect(result?.error).toMatch(/requires a 'model'/i);
      expect(mockAddCronJob).not.toHaveBeenCalled();
    });

    it("persists a cross-provider override after validating it on that backend", async () => {
      mockGetBackendIdForChat.mockReturnValue("claude");
      mockAcquireBackendInstance.mockResolvedValue({
        backend: { background: {} }, // supports isolated runs
        release: mockRelease,
      });
      mockIsModelValidForBackend.mockResolvedValue(true);

      const result = await handleSharedAction(
        {
          action: "create_cron_job",
          name: "Cheap codex job",
          schedule: "0 9 * * *",
          type: "query",
          content: "check the thing",
          model: "gpt-5.5",
          provider: "codex",
          instructions: "be terse",
        },
        42,
      );
      expect(result?.ok).toBe(true);
      expect(mockAcquireBackendInstance).toHaveBeenCalledWith("codex");
      expect(mockRelease).toHaveBeenCalled();
      expect(mockAddCronJob).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-5.5",
          provider: "codex",
          instructions: "be terse",
          type: "query",
        }),
      );
    });

    it("rejects a cross-provider model that isn't valid on that backend", async () => {
      mockGetBackendIdForChat.mockReturnValue("claude");
      mockAcquireBackendInstance.mockResolvedValue({
        backend: { background: {} },
        release: mockRelease,
      });
      mockIsModelValidForBackend.mockResolvedValue(false);

      const result = await handleSharedAction(
        {
          action: "create_cron_job",
          name: "Bad codex job",
          schedule: "0 9 * * *",
          type: "query",
          content: "x",
          model: "nope",
          provider: "codex",
        },
        42,
      );
      expect(result?.ok).toBe(false);
      expect(result?.error).toMatch(/not a selectable model on provider/i);
      expect(mockRelease).toHaveBeenCalled();
      expect(mockAddCronJob).not.toHaveBeenCalled();
    });
  });

  describe("list_models", () => {
    it("lists selectable models on the chat's current backend", async () => {
      mockGetBackendForChat.mockReturnValue({
        models: {
          listModels: async () => ({
            models: [
              {
                id: "claude-opus-4-8",
                displayName: "Opus 4.8",
                selectable: true,
                reasoning: true,
                contextWindow: 1_000_000,
              },
              {
                id: "claude-haiku-4-5",
                displayName: "Haiku 4.5",
                selectable: true,
              },
              { id: "legacy", displayName: "Legacy", selectable: false },
            ],
            total: 3,
          }),
        },
      });
      const result = await handleSharedAction({ action: "list_models" }, 42);
      expect(result?.ok).toBe(true);
      expect(result?.backend).toBe("claude");
      const ids = (result!.models as { id: string }[]).map((m) => m.id);
      expect(ids).toEqual(["claude-opus-4-8", "claude-haiku-4-5"]); // non-selectable dropped
      expect(result?.text).toContain("claude-haiku-4-5");
    });

    it("reports a fixed-model backend with no catalog", async () => {
      mockGetBackendForChat.mockReturnValue({ models: undefined });
      const result = await handleSharedAction({ action: "list_models" }, 42);
      expect(result?.ok).toBe(true);
      expect(result?.text).toMatch(/fixed model/i);
      expect(result?.models).toEqual([]);
    });

    it("errors on an unknown named backend", async () => {
      const result = await handleSharedAction(
        { action: "list_models", backend: "ghost" },
        42,
      );
      expect(result?.ok).toBe(false);
      expect(result?.error).toMatch(/unknown backend/i);
    });

    it("boots a non-active backend on demand, reads its catalog, and releases", async () => {
      mockGetBackendIdForChat.mockReturnValue("claude");
      mockGetAvailableBackends.mockReturnValue([
        { id: "claude", label: "Claude" },
        { id: "codex", label: "Codex" },
      ]);
      mockGetPooledBackend.mockReturnValue(null); // codex not pooled
      mockAcquireBackendInstance.mockResolvedValue({
        backend: {
          models: {
            listModels: async () => ({
              models: [
                { id: "gpt-5.5", displayName: "GPT-5.5", selectable: true },
              ],
              total: 1,
            }),
          },
        },
        release: mockRelease,
      });

      const result = await handleSharedAction(
        { action: "list_models", backend: "codex" },
        42,
      );
      expect(result?.ok).toBe(true);
      expect(result?.backend).toBe("codex");
      expect((result!.models as { id: string }[]).map((m) => m.id)).toEqual([
        "gpt-5.5",
      ]);
      expect(result?.text).toContain("not this chat's backend");
      expect(mockAcquireBackendInstance).toHaveBeenCalledWith("codex");
      expect(mockRelease).toHaveBeenCalled(); // torn down after read
    });

    it("releases the transient instance even when the catalog read throws", async () => {
      mockGetBackendIdForChat.mockReturnValue("claude");
      mockGetAvailableBackends.mockReturnValue([
        { id: "claude", label: "Claude" },
        { id: "codex", label: "Codex" },
      ]);
      mockGetPooledBackend.mockReturnValue(null);
      mockAcquireBackendInstance.mockResolvedValue({
        backend: {
          models: {
            listModels: async () => {
              throw new Error("catalog boom");
            },
          },
        },
        release: mockRelease,
      });

      await expect(
        handleSharedAction({ action: "list_models", backend: "codex" }, 42),
      ).rejects.toThrow("catalog boom");
      expect(mockRelease).toHaveBeenCalled();
    });

    it("surfaces a boot failure as a clean error", async () => {
      mockGetBackendIdForChat.mockReturnValue("claude");
      mockGetAvailableBackends.mockReturnValue([
        { id: "claude", label: "Claude" },
        { id: "codex", label: "Codex" },
      ]);
      mockGetPooledBackend.mockReturnValue(null);
      mockAcquireBackendInstance.mockRejectedValue(new Error("no api key"));

      const result = await handleSharedAction(
        { action: "list_models", backend: "codex" },
        42,
      );
      expect(result?.ok).toBe(false);
      expect(result?.error).toMatch(/could not load backend "codex"/i);
      expect(result?.error).toMatch(/no api key/i);
    });
  });

  describe("list_backends", () => {
    it("lists available backends and flags the current one", async () => {
      mockGetAvailableBackends.mockReturnValue([
        { id: "claude", label: "Claude" },
        { id: "codex", label: "Codex" },
      ]);
      mockGetBackendIdForChat.mockReturnValue("codex");
      mockGetPooledBackend.mockReturnValue({ background: {} });
      const result = await handleSharedAction({ action: "list_backends" }, 42);
      expect(result?.ok).toBe(true);
      expect(result?.backends).toEqual([
        {
          id: "claude",
          label: "Claude",
          current: false,
          headroom: null,
          headroomSource: "none",
        },
        {
          id: "codex",
          label: "Codex",
          current: true,
          headroom: null,
          headroomSource: "none",
        },
      ]);
      expect(result?.text).toContain("current");
      expect(result?.text).toContain("free");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // send_via — cross-frontend send
  // ════════════════════════════════════════════════════════════════════════

  describe("send_via (cross-frontend send)", () => {
    afterEach(() => {
      registerCrossSendTarget("whatsapp", null);
      registerCrossSendTarget("telegram", null);
      registerCrossSendTarget("teams", null);
    });

    it("is a chat-free action, reachable before chat resolution", () => {
      expect(isChatFreeAction("send_via")).toBe(true);
      // The chat-addressed sends stay chat-bound.
      expect(isChatFreeAction("send_message")).toBe(false);
    });

    it("dispatches send_message to the named frontend's registered handler", async () => {
      const handler = vi.fn(async () => ({ ok: true, message_id: 7 }));
      registerCrossSendTarget("whatsapp", handler);
      const result = await handleChatFreeAction({
        action: "send_via",
        frontend: "whatsapp",
        target: "+353871234567",
        text: "hi there",
      });
      expect(result).toEqual({ ok: true, message_id: 7 });
      // Non-numeric target rides in body.target; chatId stays the 0 sentinel.
      expect(handler).toHaveBeenCalledWith(
        { action: "send_message", text: "hi there", target: "+353871234567" },
        0,
      );
    });

    it("promotes a numeric target to the handler's chatId key", async () => {
      const handler = vi.fn(async () => ({ ok: true, message_id: 9 }));
      registerCrossSendTarget("telegram", handler);
      await handleChatFreeAction({
        action: "send_via",
        frontend: "telegram",
        target: "-1009876543210",
        text: "build is green",
      });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ action: "send_message" }),
        -1009876543210,
      );
    });

    it("errors cleanly when the named frontend is not enabled", async () => {
      registerCrossSendTarget(
        "telegram",
        vi.fn(async () => ({ ok: true })),
      );
      const result = await handleChatFreeAction({
        action: "send_via",
        frontend: "whatsapp",
        target: "+353871234567",
        text: "hi",
      });
      expect(result?.ok).toBe(false);
      expect(String(result?.error)).toContain(
        "whatsapp frontend is not enabled",
      );
      expect(String(result?.error)).toContain("telegram");
    });

    it("requires frontend, target, and text", async () => {
      const missingFrontend = await handleChatFreeAction({
        action: "send_via",
        target: "123",
        text: "hi",
      });
      expect(missingFrontend?.error).toContain("frontend is required");

      const missingTarget = await handleChatFreeAction({
        action: "send_via",
        frontend: "telegram",
        text: "hi",
      });
      expect(missingTarget?.error).toContain("target is required");

      const missingText = await handleChatFreeAction({
        action: "send_via",
        frontend: "telegram",
        target: "123",
      });
      expect(missingText?.error).toContain("text is required");
    });

    it("surfaces a handler that does not implement send_message", async () => {
      registerCrossSendTarget(
        "teams",
        vi.fn(async () => null),
      );
      const result = await handleChatFreeAction({
        action: "send_via",
        frontend: "teams",
        target: "42",
        text: "hi",
      });
      expect(result?.ok).toBe(false);
      expect(String(result?.error)).toContain(
        "does not implement send_message",
      );
    });

    it("promotes a media source to the matching per-kind send action", async () => {
      const handler = vi.fn(async () => ({ ok: true, message_id: 11 }));
      registerCrossSendTarget("whatsapp", handler);
      const result = await handleChatFreeAction({
        action: "send_via",
        frontend: "whatsapp",
        target: "+353871234567",
        file_path: "media/dolphin.png",
        text: "look at this",
      });
      expect(result).toEqual({ ok: true, message_id: 11 });
      // Text rides as the caption — a media send has no separate body.
      expect(handler).toHaveBeenCalledWith(
        {
          action: "send_photo",
          target: "+353871234567",
          file_path: "media/dolphin.png",
          caption: "look at this",
        },
        0,
      );
    });

    it("infers the kind from a URL extension, ignoring the query string", async () => {
      const handler = vi.fn(
        async (_body: Record<string, unknown>, _chatId: number) => ({
          ok: true,
        }),
      );
      registerCrossSendTarget("whatsapp", handler);
      await handleChatFreeAction({
        action: "send_via",
        frontend: "whatsapp",
        target: "+353871234567",
        url: "https://example.com/clip.mp4?v=2",
      });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "send_video",
          url: "https://example.com/clip.mp4?v=2",
        }),
        0,
      );
      // No text given, so no caption key at all.
      expect(handler.mock.calls[0]?.[0]).not.toHaveProperty("caption");
    });

    it("falls back to a document for an unrecognised extension", async () => {
      const handler = vi.fn(async () => ({ ok: true }));
      registerCrossSendTarget("whatsapp", handler);
      await handleChatFreeAction({
        action: "send_via",
        frontend: "whatsapp",
        target: "+353871234567",
        file_path: "reports/q3.xyz",
      });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ action: "send_file" }),
        0,
      );
    });

    it("honours an explicit media_type over the inferred one", async () => {
      const handler = vi.fn(async () => ({ ok: true }));
      registerCrossSendTarget("whatsapp", handler);
      await handleChatFreeAction({
        action: "send_via",
        frontend: "whatsapp",
        target: "+353871234567",
        file_path: "media/wave.webp",
        media_type: "sticker",
      });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ action: "send_sticker" }),
        0,
      );
    });

    it("rejects an unknown media_type by name", async () => {
      registerCrossSendTarget(
        "whatsapp",
        vi.fn(async () => ({ ok: true })),
      );
      const result = await handleChatFreeAction({
        action: "send_via",
        frontend: "whatsapp",
        target: "+353871234567",
        file_path: "media/x.png",
        media_type: "hologram",
      });
      expect(result?.ok).toBe(false);
      expect(String(result?.error)).toContain('unknown media_type "hologram"');
      expect(String(result?.error)).toContain("photo");
    });

    it("accepts media with no text, but still requires one or the other", async () => {
      registerCrossSendTarget(
        "whatsapp",
        vi.fn(async () => ({ ok: true })),
      );
      const bare = await handleChatFreeAction({
        action: "send_via",
        frontend: "whatsapp",
        target: "+353871234567",
      });
      expect(bare?.error).toContain("text is required");
      expect(String(bare?.error)).toContain("file_path");

      const mediaOnly = await handleChatFreeAction({
        action: "send_via",
        frontend: "whatsapp",
        target: "+353871234567",
        file_path: "media/x.png",
      });
      expect(mediaOnly?.ok).toBe(true);
    });

    it("names the media action when the frontend does not implement it", async () => {
      registerCrossSendTarget(
        "teams",
        vi.fn(async () => null),
      );
      const result = await handleChatFreeAction({
        action: "send_via",
        frontend: "teams",
        target: "42",
        file_path: "media/x.png",
      });
      expect(String(result?.error)).toContain("does not implement send_photo");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // whatsapp_account — cross-frontend account management
  // ════════════════════════════════════════════════════════════════════════

  describe("whatsapp_account (cross-frontend account management)", () => {
    afterEach(() => {
      registerCrossSendTarget("whatsapp", null);
      registerCrossSendTarget("telegram", null);
    });

    it("is chat-free: the account is not a conversation", () => {
      expect(isChatFreeAction("whatsapp_account")).toBe(true);
    });

    it("dispatches to the whatsapp handler with the no-chat sentinel", async () => {
      const handler = vi.fn(async () => ({ ok: true, text: "name: Claudius" }));
      registerCrossSendTarget("whatsapp", handler);
      const result = await handleChatFreeAction({
        action: "whatsapp_account",
        op: "get_profile",
      });
      expect(result).toEqual({ ok: true, text: "name: Claudius" });
      expect(handler).toHaveBeenCalledWith(
        { action: "whatsapp_account", op: "get_profile" },
        0,
      );
    });

    it("forwards the op's own arguments untouched", async () => {
      const handler = vi.fn(
        async (_body: Record<string, unknown>, _chatId: number) => ({
          ok: true,
        }),
      );
      registerCrossSendTarget("whatsapp", handler);
      await handleChatFreeAction({
        action: "whatsapp_account",
        op: "set_privacy",
        setting: "last_seen",
        value: "contacts",
      });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ setting: "last_seen", value: "contacts" }),
        0,
      );
      // No target: the frontend reads body.target as a chat-routing key,
      // and these ops address the logged-in identity instead.
      expect(handler.mock.calls[0]?.[0]).not.toHaveProperty("target");
    });

    it("requires an op", async () => {
      registerCrossSendTarget(
        "whatsapp",
        vi.fn(async () => ({ ok: true })),
      );
      const result = await handleChatFreeAction({
        action: "whatsapp_account",
      });
      expect(result?.ok).toBe(false);
      expect(String(result?.error)).toContain("op is required");
    });

    it("errors cleanly when WhatsApp is not enabled", async () => {
      registerCrossSendTarget(
        "telegram",
        vi.fn(async () => ({ ok: true })),
      );
      const result = await handleChatFreeAction({
        action: "whatsapp_account",
        op: "get_profile",
      });
      expect(result?.ok).toBe(false);
      expect(String(result?.error)).toContain(
        "whatsapp frontend is not enabled",
      );
      expect(String(result?.error)).toContain("telegram");
    });

    it("surfaces a frontend too old to serve the action", async () => {
      registerCrossSendTarget(
        "whatsapp",
        vi.fn(async () => null),
      );
      const result = await handleChatFreeAction({
        action: "whatsapp_account",
        op: "get_profile",
      });
      expect(result?.ok).toBe(false);
      expect(String(result?.error)).toContain("older build");
    });
  });
});
