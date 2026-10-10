import { describe, expect, it } from "vitest";
import {
  COMPUTER_ACTIONS,
  computerCommandParams,
  formatComputerResult,
} from "../core/mesh/devices/computer.js";
import { textResult } from "../core/tools/bridge.js";
import type { DeviceCommandResult, DeviceInfo } from "../core/mesh/types.js";

const mac = { id: "dev_mac", name: "mac-mini" } as DeviceInfo;

/** A device answer with the correlation fields every result carries. */
function answer(
  body: Pick<DeviceCommandResult, "ok" | "message" | "data">,
): DeviceCommandResult {
  return { commandId: "cmd_1", deviceId: mac.id, ...body };
}

describe("computerCommandParams", () => {
  it("maps tool names onto the wire names the node reads", () => {
    const built = computerCommandParams({
      device: "mac-mini",
      action: "drag",
      x: 10,
      y: 20,
      to_x: 300,
      to_y: 400,
    });
    expect(built).toEqual({
      action: "drag",
      params: { action: "drag", x: 10, y: 20, toX: 300, toY: 400 },
    });
  });

  it("never forwards the device selector or unknown keys", () => {
    const built = computerCommandParams({
      device: "mac-mini",
      deviceId: "dev_mac",
      action: "click",
      x: "640",
      y: 360,
      cmd: "rm -rf /",
      modifiers: ["cmd", 7, ""],
    });
    expect(built).toEqual({
      action: "click",
      params: { action: "click", x: 640, y: 360, modifiers: ["cmd"] },
    });
  });

  it("rejects an unknown action and names the valid ones", () => {
    const built = computerCommandParams({ action: "reboot" });
    expect(built).toHaveProperty("error");
    for (const action of COMPUTER_ACTIONS) {
      expect((built as { error: string }).error).toContain(action);
    }
  });

  it.each([
    [{ action: "click", x: 5 }, "y"],
    [{ action: "drag", x: 1, y: 2 }, "to_x, to_y"],
    [{ action: "type" }, "text"],
    [{ action: "key", keys: "" }, "keys"],
    [{ action: "scroll" }, "dy or dx"],
    [{ action: "move", x: "left", y: 2 }, "x must be a number"],
  ])("refuses %j before it reaches the device", (input, mention) => {
    const built = computerCommandParams(input);
    expect(built).toHaveProperty("error");
    expect((built as { error: string }).error).toContain(mention);
  });

  it("lets a click at the origin through (0 is a coordinate, not a gap)", () => {
    expect(computerCommandParams({ action: "click", x: 0, y: 0 })).toEqual({
      action: "click",
      params: { action: "click", x: 0, y: 0 },
    });
  });
});

describe("formatComputerResult", () => {
  it("returns a screenshot as an image the model can see", () => {
    const result = formatComputerResult(
      mac,
      "screenshot",
      answer({
        ok: true,
        data: {
          base64: "aGVsbG8=",
          mimeType: "image/jpeg",
          width: 1280,
          height: 720,
          cursor: [400, 300],
          space: [1280, 720],
          trusted: true,
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain("1280x720");
    expect(result.text).toContain("400,300");
    expect(result.text).not.toContain("aGVsbG8=");
    // …and the MCP wrapper turns that into a real image block.
    expect(textResult(result).content).toContainEqual({
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/jpeg",
    });
  });

  it("fails a screenshot that arrived without an image", () => {
    const result = formatComputerResult(
      mac,
      "screenshot",
      answer({
        ok: true,
        data: { width: 1280, height: 720 },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.image).toBeUndefined();
  });

  it("lists snapshot elements with the point to click", () => {
    const result = formatComputerResult(
      mac,
      "snapshot",
      answer({
        ok: true,
        data: {
          app: "Calculator",
          window: "Calculator",
          total: 37,
          truncated: "limit",
          space: [1280, 720],
          cursor: [1, 2],
          apps: ["Finder", "Calculator"],
          elements: [
            { role: "Button", label: "Seven", x: 342, y: 500, w: 32, h: 32 },
            {
              role: "TextField",
              label: "Search",
              value: "abc",
              x: 10,
              y: 20,
              w: 100,
              h: 22,
              focused: true,
            },
            { role: "Button", x: 5, y: 6, w: 8, h: 8, disabled: true },
          ],
        },
      }),
    );
    expect(result.ok).toBe(true);
    const lines = result.text.split("\n");
    expect(lines[0]).toBe('[mac-mini] Calculator — window "Calculator"');
    expect(lines[1]).toContain("3 actionable of 37 elements");
    expect(lines[1]).toContain("cut at the element limit");
    expect(lines[1]).toContain("1280x720");
    expect(lines).toContain('Button "Seven" @342,500 32x32');
    expect(lines).toContain(
      'TextField "Search" = "abc" @10,20 100x22 (focused)',
    );
    expect(lines).toContain("Button @5,6 8x8 (disabled)");
    expect(lines).toContain("Open apps: Finder, Calculator");
  });

  it("warns when the node cannot post input events", () => {
    const result = formatComputerResult(
      mac,
      "click",
      answer({
        ok: true,
        data: { cursor: [3, 4], trusted: false },
      }),
    );
    expect(result.text).toContain("click done");
    expect(result.text).toContain("Accessibility");
  });

  it("passes a device refusal through untouched", () => {
    const result = formatComputerResult(
      mac,
      "type",
      answer({
        ok: false,
        message:
          "refused by this host's talon-node policy: computer is disabled",
      }),
    );
    expect(result).toEqual({
      ok: false,
      text: "refused by this host's talon-node policy: computer is disabled",
    });
  });
});
