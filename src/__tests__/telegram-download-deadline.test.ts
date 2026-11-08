import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../util/log.js", () => ({ logWarn: vi.fn() }));

import { downloadTelegramFile } from "../frontend/telegram/handlers/context.js";

/** Never answers until its signal aborts — a black-holed socket. */
function hangUntilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  });
}

const config = { botToken: "123:abc" } as never;

/** AbortSignal.timeout runs on Node's internal clock; route it through the faked one. */
function fakeAbortSignalTimeout(): void {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("timed out", "TimeoutError")),
      ms,
    );
    return controller.signal;
  });
}

describe("downloadTelegramFile deadline", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("gives up on a download body that never arrives", async () => {
    vi.useFakeTimers();
    fakeAbortSignalTimeout();
    const bot = {
      api: { getFile: vi.fn(async () => ({ file_path: "photos/a.jpg" })) },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        hangUntilAborted(init?.signal ?? undefined),
      ),
    );

    const download = downloadTelegramFile(bot as never, config, "f", "a.jpg");
    const settled = expect(download).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(119_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
  });

  it("gives up on a getFile call that never answers", async () => {
    vi.useFakeTimers();
    fakeAbortSignalTimeout();
    const bot = {
      api: {
        getFile: vi.fn((_id: string, signal?: AbortSignal) =>
          hangUntilAborted(signal),
        ),
      },
    };

    const download = downloadTelegramFile(bot as never, config, "f", "a.jpg");
    const settled = expect(download).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(119_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
  });
});
