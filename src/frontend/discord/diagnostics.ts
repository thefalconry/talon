/**
 * Client diagnostics — the error/warn/disconnect/rate-limit listeners.
 * discord.js handles reconnects and retries itself; these exist so a
 * silent failure mode (a fatal close code, an approaching IP ban) is
 * visible in the daemon log, and so the operator hears when the gateway
 * stays down: `discord.gateway` is raised once a shard has been
 * disconnected for `GATEWAY_OUTAGE_MS` (at once, critically, for a close
 * code discord.js will never recover from) and resolved on ready/resume.
 */

import { type Client, Events } from "discord.js";
import { log, logError, logWarn } from "../../util/log.js";
import { createOutage, errorText, type Outage } from "../health/outage.js";

/** A gateway down this long reaches the operator. */
const GATEWAY_OUTAGE_MS = 5 * 60_000;

function shardDisconnectLabel(code: number | undefined): string {
  return code === 4004
    ? "AUTHENTICATION_FAILED — bot token invalid/revoked"
    : code === 4013
      ? "INVALID_INTENTS — declared intent doesn't exist"
      : code === 4014
        ? "DISALLOWED_INTENTS — privileged intent (GuildMembers/MessageContent/Presence) not enabled in Developer Portal"
        : `code=${code}`;
}

function createGatewayOutage(thresholdMs: number): Outage {
  return createOutage({
    key: "discord.gateway",
    thresholdMs,
    describe: (err, mins) =>
      `The Discord gateway has been disconnected for ${mins} min: ${err}. Messages are not being received.`,
    recovered: "The Discord gateway is connected again.",
  });
}

/**
 * Gateway connection health: which shards are down, and the outage that
 * spans them. Reconnect attempts, errors and recoveries are logged with
 * the shard, attempt number and time down.
 */
function bindGatewayHealth(client: Client, thresholdMs: number): void {
  const outage = createGatewayOutage(thresholdMs);
  const down = new Set<number>();

  const lost = (shardId: number, event: string, err: unknown): void => {
    down.add(shardId);
    const { attempt, downMs } = outage.fail(err);
    logWarn(
      "discord",
      `gateway.${event} shard=${shardId} attempt=${attempt} down_ms=${downMs} err=${errorText(err)}`,
    );
  };
  const back = (shardId: number, event: string): void => {
    down.delete(shardId);
    if (down.size > 0) return;
    const ended = outage.ok();
    if (ended) {
      log(
        "discord",
        `gateway.${event} shard=${shardId} failed_attempts=${ended.attempts} down_ms=${ended.downMs}`,
      );
    }
  };

  client.on(Events.ShardReconnecting, (shardId) =>
    lost(shardId, "reconnecting", "connection closed, reconnecting"),
  );
  client.on(Events.ShardError, (err, shardId) => {
    // An error on a live shard is followed by a close if it matters; only
    // an error during an outage is part of it (its text is the useful one).
    if (down.has(shardId)) lost(shardId, "error", err);
  });
  client.on(Events.ShardDisconnect, (event, shardId) => {
    const code = event?.code;
    lost(shardId, "disconnect", shardDisconnectLabel(code));
    if (code === 4004 || code === 4013 || code === 4014) {
      outage.raiseNow(
        `The Discord gateway closed and will not reconnect: ${shardDisconnectLabel(code)}. ` +
          "Messages are not being received until this is fixed and Talon restarts.",
        "critical",
      );
    }
  });
  client.on(Events.Invalidated, () =>
    lost(0, "invalidated", "session invalidated"),
  );
  client.on(Events.ShardReady, (shardId) => back(shardId, "ready"));
  client.on(Events.ShardResume, (shardId) => back(shardId, "resumed"));
}

export function bindClientDiagnostics(
  client: Client,
  gatewayOutageMs = GATEWAY_OUTAGE_MS,
): void {
  bindGatewayHealth(client, gatewayOutageMs);
  client.on("error", (err) => {
    logError("discord", "Client error", err);
  });
  client.on("warn", (msg) => {
    logWarn("discord", msg);
  });

  // Surface gateway close codes — discord.js auto-reconnects on most, but
  // 4004 (auth failed), 4013 (invalid intents), 4014 (disallowed intents)
  // are terminal: the bot will hang silent in IDENTIFY without an alert.
  client.on(Events.ShardDisconnect, (event, shardId) => {
    const code = event?.code;
    const reason = event?.reason || "(no reason)";
    const fatal = code === 4004 || code === 4013 || code === 4014;
    const label = shardDisconnectLabel(code);
    if (fatal) {
      logError(
        "discord",
        `Shard ${shardId} disconnected fatally: ${label} (${reason})`,
      );
    } else {
      logWarn("discord", `Shard ${shardId} disconnected: ${label} (${reason})`);
    }
  });

  // Rate-limit / invalid-request observability. discord.js handles retries
  // automatically; we just want logs so we know when we're flirting with
  // the Cloudflare 10k-invalid-requests/10min cap.
  client.rest.on("rateLimited", (info) => {
    logWarn(
      "discord",
      `Rate-limited ${info.method} ${info.route} — wait ${info.timeToReset}ms (global=${info.global})`,
    );
  });
  client.rest.on("invalidRequestWarning", (info) => {
    logError(
      "discord",
      `Invalid-request warning: ${info.count} bad requests in last ${info.remainingTime}ms — approaching IP ban threshold`,
    );
  });
}
