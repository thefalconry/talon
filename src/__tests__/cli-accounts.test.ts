/**
 * `talon accounts`: list/add/remove go to the running daemon's gateway, and
 * with no daemon edit config.json through the same core code, saying the
 * change applies at the next start.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const daemon = vi.hoisted(() => ({
  instance: null as null | { pid: number; port?: number },
}));
vi.mock("../core/daemon/discovery.js", () => ({
  findRunningInstance: async () => daemon.instance,
}));
const fetchGateway = vi.hoisted(() => vi.fn());
vi.mock("../cli/daemon-api.js", () => ({ fetchGateway }));

const { runAccountsCommand } = await import("../cli/commands/accounts.js");
const { dirs, files } = await import("../util/paths.js");
const { setClaudeAccounts } = await import("../core/config/claude-accounts.js");

let out: string[];

beforeEach(() => {
  daemon.instance = null;
  fetchGateway.mockReset();
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => {
    out.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a) => {
    out.push(a.join(" "));
  });
  mkdirSync(dirs.root, { recursive: true });
  writeFileSync(files.config, JSON.stringify({ backend: "claude" }));
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  setClaudeAccounts([]);
  rmSync(dirs.root, { recursive: true, force: true });
  process.exitCode = undefined;
});

const config = () => JSON.parse(readFileSync(files.config, "utf-8"));

describe("talon accounts", () => {
  it("with no daemon, add and remove edit config.json and say when it applies", async () => {
    await runAccountsCommand(["add", "work"]);
    expect(config().claudeAccounts).toEqual([
      {
        id: "claude-work",
        label: "Claude (work)",
        configDir: "~/.talon/accounts/claude-work",
      },
    ]);
    expect(out.join("\n")).toContain("applies at its next start");

    await runAccountsCommand(["remove", "claude-work", "--keep-credentials"]);
    expect(config().claudeAccounts).toBeUndefined();
    expect(out.join("\n")).toContain("Its sign-in was left at");
    expect(process.exitCode).toBeUndefined();
  });

  it("with a daemon, goes through the gateway", async () => {
    daemon.instance = { pid: 1, port: 4321 };
    fetchGateway.mockResolvedValue({
      ok: true,
      account: { id: "claude-2", label: "Claude (account 2)", configDir: "/d" },
      live: true,
    });
    await runAccountsCommand(["add"]);
    expect(fetchGateway).toHaveBeenCalledWith(
      4321,
      "/claude-accounts/add",
      { method: "POST", body: "{}" },
      30_000,
    );
    expect(config().claudeAccounts).toBeUndefined();
    expect(out.join("\n")).not.toContain("next start");
  });

  it("reports a refusal and exits non-zero", async () => {
    await runAccountsCommand(["remove", "claude"]);
    expect(out.join("\n")).toContain("default Claude account");
    expect(process.exitCode).toBe(1);
  });
});
