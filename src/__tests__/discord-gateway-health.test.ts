/**
 * Discord gateway health: a shard that stays disconnected raises
 * `discord.gateway` after the threshold, a fatal close code raises it at
 * once, and ready/resume resolves it. Driven through a bare EventEmitter
 * standing in for the discord.js Client.
 */

import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("../core/frontend-runtime/alerts.js", () => ({
  raiseAlert: vi.fn(),
  resolveAlert: vi.fn(),
}));

import { Events, type Client } from "discord.js";
import { bindClientDiagnostics } from "../frontend/discord/diagnostics.js";
import { raiseAlert, resolveAlert } from "../core/frontend-runtime/alerts.js";
import { log, logWarn } from "../util/log.js";

const MIN = 60_000;

function fakeClient(): EventEmitter {
  const client = new EventEmitter() as EventEmitter & { rest: EventEmitter };
  client.rest = new EventEmitter();
  bindClientDiagnostics(client as unknown as Client);
  return client;
}

describe("discord gateway health", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(raiseAlert).mockClear();
    vi.mocked(resolveAlert).mockClear();
    vi.mocked(log).mockClear();
    vi.mocked(logWarn).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("raises after 5 min reconnecting, with the latest error, and resolves on resume", () => {
    const client = fakeClient();
    client.emit(Events.ShardReconnecting, 0);
    expect(logWarn).toHaveBeenCalledWith(
      "discord",
      "gateway.reconnecting shard=0 attempt=1 down_ms=0 err=connection closed, reconnecting",
    );
    vi.advanceTimersByTime(2 * MIN);
    client.emit(Events.ShardError, new Error("getaddrinfo ENOTFOUND"), 0);
    vi.advanceTimersByTime(2 * MIN);
    expect(raiseAlert).not.toHaveBeenCalled();

    vi.advanceTimersByTime(MIN);
    expect(raiseAlert).toHaveBeenCalledWith(
      "discord.gateway",
      "The Discord gateway has been disconnected for 5 min: getaddrinfo ENOTFOUND. " +
        "Messages are not being received.",
      { severity: undefined },
    );

    client.emit(Events.ShardResume, 0, 3);
    expect(resolveAlert).toHaveBeenCalledWith(
      "discord.gateway",
      "The Discord gateway is connected again.",
    );
    expect(log).toHaveBeenCalledWith(
      "discord",
      `gateway.resumed shard=0 failed_attempts=2 down_ms=${5 * MIN}`,
    );
  });

  it("does not raise when the shard comes back before the threshold", () => {
    const client = fakeClient();
    client.emit(Events.ShardReconnecting, 0);
    vi.advanceTimersByTime(30_000);
    client.emit(Events.ShardReady, 0, undefined);
    vi.advanceTimersByTime(10 * MIN);
    expect(raiseAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it("ignores an error on a live shard", () => {
    const client = fakeClient();
    client.emit(Events.ShardError, new Error("blip"), 0);
    vi.advanceTimersByTime(10 * MIN);
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it("raises critically at once on a close code discord.js will not recover from", () => {
    const client = fakeClient();
    client.emit(Events.ShardDisconnect, { code: 4014 }, 0);
    expect(raiseAlert).toHaveBeenCalledWith(
      "discord.gateway",
      expect.stringContaining("DISALLOWED_INTENTS"),
      { severity: "critical" },
    );
  });

  it("waits for every down shard before resolving", () => {
    const client = fakeClient();
    client.emit(Events.ShardReconnecting, 0);
    client.emit(Events.ShardReconnecting, 1);
    vi.advanceTimersByTime(5 * MIN);
    expect(raiseAlert).toHaveBeenCalledTimes(1);
    client.emit(Events.ShardReady, 0, undefined);
    expect(resolveAlert).not.toHaveBeenCalled();
    client.emit(Events.ShardReady, 1, undefined);
    expect(resolveAlert).toHaveBeenCalledTimes(1);
  });
});
