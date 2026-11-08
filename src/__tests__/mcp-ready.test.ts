import { describe, it, expect, vi } from "vitest";
import { waitForMcpServersReady } from "../backend/claude-sdk/mcp-ready.js";

type Status = { name: string; status: string };

/** Fake Query whose mcpServerStatus() returns successive scripted snapshots. */
function fakeQuery(snapshots: Status[][]) {
  let call = 0;
  const mcpServerStatus = vi.fn(async () => {
    const snap = snapshots[Math.min(call, snapshots.length - 1)];
    call += 1;
    return snap as never;
  });
  return { mcpServerStatus, calls: () => call };
}

describe("waitForMcpServersReady", () => {
  it("returns immediately when no servers were added", async () => {
    const qi = fakeQuery([]);
    await waitForMcpServersReady(qi as never, []);
    expect(qi.mcpServerStatus).not.toHaveBeenCalled();
  });

  it("resolves once a pending server becomes connected", async () => {
    // First poll: playwright still connecting. Second poll: connected.
    const qi = fakeQuery([
      [{ name: "playwright", status: "pending" }],
      [{ name: "playwright", status: "connected" }],
    ]);
    await waitForMcpServersReady(qi as never, ["playwright"], 5_000, 1);
    expect(qi.mcpServerStatus).toHaveBeenCalledTimes(2);
  });

  it("does not block on a server that settles into 'failed'", async () => {
    const qi = fakeQuery([[{ name: "playwright", status: "failed" }]]);
    await waitForMcpServersReady(qi as never, ["playwright"], 5_000, 1);
    expect(qi.mcpServerStatus).toHaveBeenCalledTimes(1);
  });

  it("waits for ALL named servers to leave pending", async () => {
    const qi = fakeQuery([
      [
        { name: "a", status: "connected" },
        { name: "b", status: "pending" },
      ],
      [
        { name: "a", status: "connected" },
        { name: "b", status: "connected" },
      ],
    ]);
    await waitForMcpServersReady(qi as never, ["a", "b"], 5_000, 1);
    expect(qi.mcpServerStatus).toHaveBeenCalledTimes(2);
  });

  it("gives up after the timeout if a server stays pending", async () => {
    const qi = fakeQuery([[{ name: "stuck", status: "pending" }]]);
    const start = Date.now();
    await waitForMcpServersReady(qi as never, ["stuck"], 30, 5);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("gives up after the timeout even when a status call never answers", async () => {
    // A wedged CLI never answers the control request; the deadline must
    // bound the wait itself, not just the gap between polls.
    const qi = { mcpServerStatus: vi.fn(() => new Promise<never>(() => {})) };
    const start = Date.now();
    await waitForMcpServersReady(qi as never, ["stuck"], 30, 5);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("does not throw when mcpServerStatus returns a non-array (unsupported shape)", async () => {
    const qi = {
      mcpServerStatus: vi.fn(async () => undefined as never),
    };
    await expect(
      waitForMcpServersReady(qi as never, ["x"], 5_000, 1),
    ).resolves.toBeUndefined();
    expect(qi.mcpServerStatus).toHaveBeenCalledTimes(1);
  });

  it("does not throw when mcpServerStatus rejects", async () => {
    const qi = {
      mcpServerStatus: vi.fn(async () => {
        throw new Error("not supported");
      }),
    };
    await expect(
      waitForMcpServersReady(qi as never, ["x"], 5_000, 1),
    ).resolves.toBeUndefined();
    expect(qi.mcpServerStatus).toHaveBeenCalledTimes(1);
  });
});
