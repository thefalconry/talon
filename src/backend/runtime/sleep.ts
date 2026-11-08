/**
 * Abort-aware sleep helper.
 *
 * Resolves after `ms` milliseconds, or immediately when the optional
 * `AbortSignal` fires. Used by the remote-server backends (kilo,
 * opencode) for throttled retries and stream pacing.
 */

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => resolve(), ms);
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
