/**
 * Storage paths that swallow a failure must still say what failed:
 * which key/chat/job, and the SQLite result code the message alone
 * doesn't carry (node:sqlite puts SQLITE_FULL in `errcode`, not the
 * text). Control flow is unchanged — these assert the log line and the
 * degraded return value, nothing else.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** The shape node:sqlite throws for a full disk. */
function sqliteFullError(): Error {
  return Object.assign(new Error("database or disk is full"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 13,
    errstr: "database or disk is full",
  });
}

function mockLog() {
  const mocks = {
    log: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
    logDebug: vi.fn(),
  };
  vi.doMock("../util/log.js", () => mocks);
  return mocks;
}

describe("kvSet — a failed write is logged with key and SQLite code", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns false and logs key, size and errcode on a full disk", async () => {
    const logs = mockLog();
    vi.doMock("../storage/repositories/kv-repo.js", () => ({
      get: vi.fn(),
      set: vi.fn(() => {
        throw sqliteFullError();
      }),
      remove: vi.fn(),
    }));
    const { kvSet } = await import("../storage/kv.js");

    expect(kvSet("heartbeat.state", { last_run: 1 })).toBe(false);

    expect(logs.logError).toHaveBeenCalledTimes(1);
    const [component, message, err] = logs.logError.mock.calls[0] as [
      string,
      string,
      Error,
    ];
    expect(component).toBe("kv");
    expect(message).toContain("Failed to write heartbeat.state");
    expect(message).toContain("bytes=14");
    expect(message).toContain("code=ERR_SQLITE_ERROR");
    expect(message).toContain("errcode=13");
    // The error object itself is passed so the stack survives.
    expect(err.message).toBe("database or disk is full");
  });

  it("returns true when the write lands", async () => {
    vi.doUnmock("../storage/repositories/kv-repo.js");
    const logs = mockLog();
    const { kvSet, kvGet, kvDelete } = await import("../storage/kv.js");

    expect(kvSet("test.kv-swallow", { a: 1 })).toBe(true);
    expect(kvGet("test.kv-swallow")).toEqual({ a: 1 });
    kvDelete("test.kv-swallow");
    expect(logs.logError).not.toHaveBeenCalled();
  });
});

describe("dbErrorFields", () => {
  it("reads node:sqlite errcode, bun errno, and nothing from plain errors", async () => {
    const { dbErrorFields } = await import("../storage/db.js");
    expect(dbErrorFields(sqliteFullError())).toBe(
      " code=ERR_SQLITE_ERROR errcode=13",
    );
    expect(
      dbErrorFields(
        Object.assign(new Error("database is locked"), {
          code: "SQLITE_BUSY",
          errno: 5,
        }),
      ),
    ).toBe(" code=SQLITE_BUSY errcode=5");
    expect(dbErrorFields(new Error("plain"))).toBe("");
    expect(dbErrorFields("string")).toBe("");
  });
});

describe("history — a dropped message names the chat and message", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("logs chat, msg and errcode when the insert throws", async () => {
    const logs = mockLog();
    vi.doMock("../util/watchdog.js", () => ({ recordError: vi.fn() }));
    vi.doMock("../storage/repositories/history-repo.js", () => ({
      insert: vi.fn(() => {
        throw sqliteFullError();
      }),
    }));
    const { pushMessage } = await import("../storage/history.js");

    expect(() =>
      pushMessage("chat-42", {
        msgId: 7,
        senderId: 1,
        senderName: "u",
        text: "hi",
        timestamp: Date.now(),
      }),
    ).not.toThrow();

    expect(logs.logError).toHaveBeenCalledWith(
      "history",
      expect.stringMatching(
        /Failed to persist message chat=chat-42 msg=7 .*errcode=13/,
      ),
      expect.any(Error),
    );
  });
});

describe("journal — corrupt rows are skipped, and counted", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("warns once per read with the skipped seqs", async () => {
    const logs = mockLog();
    vi.doMock("../storage/repositories/journal-repo.js", () => ({
      recent: vi.fn(() => [
        { seq: 3, at: 3, payload: '{"type":"ok"}' },
        { seq: 2, at: 2, payload: "{not json" },
        { seq: 1, at: 1, payload: "" },
      ]),
    }));
    const { readJournal } = await import("../storage/journal.js");

    expect(readJournal()).toHaveLength(1);
    expect(logs.logWarn).toHaveBeenCalledTimes(1);
    expect(logs.logWarn).toHaveBeenCalledWith(
      "journal",
      expect.stringContaining("Skipped 2 corrupt journal row(s) seq=2,1"),
    );
  });
});

describe("cron — an unparseable stored schedule warns once", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("names the job and schedule, and does not repeat per tick", async () => {
    const logs = mockLog();
    const { nextRunAt } = await import("../storage/cron.js");
    const job = {
      id: "job-bad",
      chatId: "chat-1",
      schedule: "not a cron",
      type: "message" as const,
      content: "x",
      name: "bad",
      enabled: true,
      createdAt: 0,
      runCount: 0,
    };

    expect(nextRunAt(job)).toBeNull();
    expect(nextRunAt(job)).toBeNull();

    expect(logs.logWarn).toHaveBeenCalledTimes(1);
    expect(logs.logWarn).toHaveBeenCalledWith(
      "cron",
      expect.stringMatching(
        /Job will not fire: unparseable schedule job=job-bad chat=chat-1 schedule="not a cron"/,
      ),
    );
  });
});
