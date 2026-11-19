/**
 * Watches commands that outlived their device_exec budget. The job itself runs
 * on the device; the daemon polls exec_job and, when it ends, wakes the chat
 * that started it with the exit code and output tail.
 *
 * Watches live in memory: a daemon restart stops the wake-up, not the job,
 * which device_exec_job can still read for as long as the node holds it.
 */

import type { DeviceCommandResult } from "../types.js";
import {
  isDiscordChatId,
  isNativeChatId,
  isTeamsChatId,
  isTelegramChatId,
  isTerminalChatId,
  isWhatsAppChatId,
} from "../../frontend-runtime/chat-id.js";

const EXEC_JOB_POLL_MS = 15_000;
/**
 * A job still running after this long is polled [EXEC_JOB_SLOW_FACTOR]
 * times less often: a day-long build needs no 15s wake-up precision, and
 * each poll is a command the node has to serve.
 */
const EXEC_JOB_SLOW_AFTER_MS = 5 * 60_000;
const EXEC_JOB_SLOW_FACTOR = 4;
/** Give up after this many failed polls in a row (offline node, lost job). */
export const EXEC_JOB_MAX_POLL_FAILURES = 40;
/** Matches the node's hard stop, plus time for a last poll. */
const EXEC_JOB_MAX_WATCH_MS = 24 * 60 * 60_000 + 5 * 60_000;
const TAIL_CHARS = 2_000;
/** A device's answer for a job it doesn't hold, as opposed to no answer. */
const LOST_JOB = /^no such job\b/i;

export type ExecJobWake = (chatKey: string, prompt: string) => void;

type TrackInput = {
  jobId: string;
  deviceId: string;
  deviceName: string;
  cmd: string;
  /** The chat that ran the command; absent or not a chat id means nobody to wake. */
  wakeChatKey: unknown;
  /** Strips wrapper output the chat shouldn't see, e.g. teleport's cwd marker. */
  cleanOutput?: (text: string) => string;
  poll: (params: Record<string, unknown>) => Promise<DeviceCommandResult>;
};

function tail(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length > TAIL_CHARS
    ? `[…]${trimmed.slice(-TAIL_CHARS)}`
    : trimmed;
}

/**
 * True for a frontend's chat id. Built from the per-frontend predicates in
 * chat-id.ts (the one owner of that grammar), not "anything but agent:",
 * because a background run's label (heartbeat, dream, agent:...) is not a
 * chat and a wake sent to one would start a session nobody reads.
 */
function isWakeableChatKey(chatKey: string): boolean {
  return (
    isTelegramChatId(chatKey) ||
    isNativeChatId(chatKey) ||
    isWhatsAppChatId(chatKey) ||
    isTeamsChatId(chatKey) ||
    isDiscordChatId(chatKey) ||
    isTerminalChatId(chatKey)
  );
}

export class ExecJobTracker {
  private wake: ExecJobWake | null = null;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly pollMs = EXEC_JOB_POLL_MS) {}

  /** Wired at startup, so this module knows nothing about the dispatcher. */
  setWake(wake: ExecJobWake | null): void {
    this.wake = wake;
  }

  /** Whether notify would reach a chat with this key. */
  canNotify(chatKey: string): boolean {
    return isWakeableChatKey(chatKey) && chatKey !== "0" && this.wake !== null;
  }

  /**
   * Whether a command that reaches its budget should keep running as a job.
   *
   * on_timeout:"kill" and "detach" decide outright. Otherwise detaching is
   * the default only when a chat will be woken at the end: a heartbeat,
   * cron or sub-agent run has nobody to wake, so its job would outlive the
   * run unwatched, and a recurring run would pile them up (filling the
   * node's job table for every real chat).
   */
  shouldDetach(onTimeout: unknown, chatKey: unknown): boolean {
    if (onTimeout === "kill") return false;
    if (onTimeout === "detach") return true;
    const key =
      typeof chatKey === "string" || typeof chatKey === "number"
        ? String(chatKey)
        : "";
    return this.canNotify(key);
  }

  /** Wake a chat directly, for a job the daemon watches itself. */
  notify(chatKey: string, prompt: string): boolean {
    if (!this.canNotify(chatKey)) return false;
    this.wake?.(chatKey, prompt);
    return true;
  }

  /** Start watching. True when a chat will be woken at the end. */
  track(input: TrackInput): boolean {
    const chatKey =
      typeof input.wakeChatKey === "string" ||
      typeof input.wakeChatKey === "number"
        ? String(input.wakeChatKey)
        : "";
    if (!this.canNotify(chatKey)) return false;
    this.schedule(input, chatKey, Date.now(), 0);
    return true;
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private key(input: TrackInput): string {
    return `${input.deviceId}/${input.jobId}`;
  }

  private schedule(
    input: TrackInput,
    chatKey: string,
    startedAt: number,
    failures: number,
  ): void {
    const slow = Date.now() - startedAt >= EXEC_JOB_SLOW_AFTER_MS;
    const timer = setTimeout(
      () => {
        void this.check(input, chatKey, startedAt, failures);
      },
      slow ? this.pollMs * EXEC_JOB_SLOW_FACTOR : this.pollMs,
    );
    timer.unref?.();
    this.timers.set(this.key(input), timer);
  }

  private async check(
    input: TrackInput,
    chatKey: string,
    startedAt: number,
    failures: number,
  ): Promise<void> {
    let result: DeviceCommandResult | null = null;
    try {
      result = await input.poll({ jobId: input.jobId, action: "status" });
    } catch {
      result = null;
    }
    const answered = result?.data !== undefined && result.data !== null;
    if (answered && result?.data?.running !== true) {
      this.finish(input, chatKey, this.finishedPrompt(input, result!));
      return;
    }
    // The device answered and no longer holds the job. Retrying can't change
    // that, and "may still be running" would be wrong after a node restart.
    if (!answered && LOST_JOB.test(result?.message ?? "")) {
      this.finish(
        input,
        chatKey,
        `Background job ${input.jobId} on ${input.deviceName} is gone (${input.cmd}): ${(result?.message ?? "").replace(/\.+$/, "")}. ` +
          `Its exit code and output are lost. A node restart stops its jobs, so don't assume the command finished.`,
      );
      return;
    }
    const nextFailures = answered ? 0 : failures + 1;
    if (
      nextFailures >= EXEC_JOB_MAX_POLL_FAILURES ||
      Date.now() - startedAt > EXEC_JOB_MAX_WATCH_MS
    ) {
      this.finish(
        input,
        chatKey,
        `Stopped watching background job ${input.jobId} on ${input.deviceName} (${input.cmd}): ` +
          `${result?.message ?? "the device stopped answering"}. Its outcome is unknown; it may still be running.`,
      );
      return;
    }
    this.schedule(input, chatKey, startedAt, nextFailures);
  }

  private finishedPrompt(
    input: TrackInput,
    result: DeviceCommandResult,
  ): string {
    const d = result.data ?? {};
    const outcome =
      d.timedOut === true
        ? `was killed at the node's 24h job limit (exit ${String(d.exitCode ?? "?")})`
        : `finished, exit ${String(d.exitCode ?? "?")}`;
    const parts = [
      `Background job ${input.jobId} on ${input.deviceName} ${outcome}: ${input.cmd}`,
    ];
    const rawStdout = String(d.stdout ?? "");
    const stdout = tail(input.cleanOutput?.(rawStdout) ?? rawStdout);
    const stderr = tail(String(d.stderr ?? ""));
    if (stdout) parts.push(`--- stdout tail ---\n${stdout}`);
    if (stderr) parts.push(`--- stderr tail ---\n${stderr}`);
    return parts.join("\n");
  }

  private finish(input: TrackInput, chatKey: string, prompt: string): void {
    this.timers.delete(this.key(input));
    this.wake?.(chatKey, prompt);
  }
}
