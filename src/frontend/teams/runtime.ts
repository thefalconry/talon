/**
 * Teams frontend runtime — the state every module shares.
 *
 * One explicit object, constructed once, that each module (chat-discovery,
 * poll, commands, turn, outbound) takes as its first parameter.
 */

import type { TalonConfig } from "../../core/config/index.js";
import type { Gateway } from "../../core/engine/gateway.js";
import type { GraphClient } from "./graph.js";
import { createOutage, type Outage } from "../health/outage.js";

/** Graph polling must fail this long before `teams.poll` is raised. */
const POLL_OUTAGE_MS = 10 * 60_000;

export type TeamsRuntime = {
  readonly config: TalonConfig;
  readonly gateway: Gateway;
  /** Power Automate workflow webhook URL every outbound card is POSTed to. */
  readonly webhookUrl: string;
  /** Display name the workflow posts under — its messages are skipped. */
  readonly botDisplayName: string;
  readonly pollIntervalMs: number;
  /** Optional topic substring used to pick the chat on first run. */
  readonly configChatTopic: string;
  graphClient: GraphClient | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  /** Newest message id already handled — the poll loop cuts at it. */
  lastSeenMessageId: string | null;
  /** Re-entrancy guard: a slow poll never overlaps the next tick. */
  polling: boolean;
  /** Failed Graph fetches, and the `teams.poll` alert they raise. */
  readonly pollOutage: Outage;
};

export function createTeamsRuntime(
  config: TalonConfig,
  gateway: Gateway,
): TeamsRuntime {
  const raw = config as Record<string, unknown>;
  return {
    config,
    gateway,
    webhookUrl: raw.teamsWebhookUrl as string,
    botDisplayName: (raw.teamsBotDisplayName as string) || "",
    pollIntervalMs: (raw.teamsGraphPollMs as number) || 10_000,
    configChatTopic: (raw.teamsChatTopic as string) || "",
    graphClient: null,
    pollTimer: null,
    lastSeenMessageId: null,
    polling: false,
    pollOutage: createOutage({
      key: "teams.poll",
      thresholdMs: POLL_OUTAGE_MS,
      describe: (err, mins) =>
        `Teams polling has failed for ${mins} min: ${err}. Messages are not being received.`,
      recovered: "Teams polling is working again.",
    }),
  };
}
