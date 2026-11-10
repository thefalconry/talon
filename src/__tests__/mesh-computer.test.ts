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

  it("forwards a snapshot scope and the click verify switch", () => {
    expect(
      computerCommandParams({ action: "snapshot", scope: "all", limit: 80 }),
    ).toEqual({
      action: "snapshot",
      params: { action: "snapshot", scope: "all", limit: 80 },
    });
    expect(
      computerCommandParams({ action: "click", x: 1, y: 2, verify: false }),
    ).toEqual({
      action: "click",
      params: { action: "click", x: 1, y: 2, verify: false },
    });
  });

  it("refuses an unknown snapshot scope", () => {
    const built = computerCommandParams({ action: "snapshot", scope: "menus" });
    expect((built as { error: string }).error).toContain("front, all");
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

  it("says how to map a shrunk screenshot back to click coordinates", () => {
    const result = formatComputerResult(
      mac,
      "screenshot",
      answer({
        ok: true,
        data: {
          base64: "aGVsbG8=",
          width: 1024,
          height: 665,
          scale: 1.25,
          space: [1280, 831],
          cursor: [1, 1],
        },
      }),
    );
    expect(result.text).toContain("screenshot 1024x665");
    expect(result.text).toContain("1280x831 space");
    expect(result.text).toContain("multiply an image pixel by 1.25");
    expect(result.text).not.toContain("a pixel in this image is the x,y");
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
            {
              role: "CheckBox",
              label: "bold",
              value: "0",
              state: "off",
              x: 155,
              y: 85,
            },
          ],
        },
      }),
    );
    expect(result.ok).toBe(true);
    const lines = result.text.split("\n");
    expect(lines[0]).toBe('[mac-mini] Calculator — window "Calculator"');
    expect(lines[1]).toContain("4 actionable of 37 elements");
    expect(lines[1]).toContain("cut at the element limit");
    expect(lines[1]).toContain("1280x720");
    expect(lines).toContain('Button "Seven" @342,500 32x32');
    expect(lines).toContain(
      'TextField "Search" = "abc" @10,20 100x22 (focused)',
    );
    expect(lines).toContain("Button @5,6 8x8 (disabled)");
    expect(lines).toContain('CheckBox "bold" @155,85 (off)');
    expect(lines).toContain("Open apps: Finder, Calculator");
  });

  it("lists the system UI a scope-all snapshot found", () => {
    const result = formatComputerResult(
      mac,
      "snapshot",
      answer({
        ok: true,
        data: {
          app: "FaceTime",
          window: "FaceTime",
          total: 2,
          space: [1280, 831],
          cursor: [0, 0],
          elements: [{ role: "Button", label: "Mute", x: 600, y: 700 }],
          system: {
            menuBar: [
              { label: "Apple", x: 19, y: 14 },
              { label: "FaceTime", x: 60, y: 14 },
            ],
            extras: [
              {
                label: "Video Effects",
                app: "Control Center",
                x: 1000,
                y: 14,
                w: 16,
                h: 16,
              },
              { label: "Battery", value: "100%", x: 1053, y: 14 },
            ],
            windows: [
              {
                app: "Control Center",
                title: "Control Center",
                x: 900,
                y: 0,
                w: 300,
                h: 400,
                layer: 22,
                walked: 2,
              },
              { app: "Safari", title: "News", x: 0, y: 30, w: 600, h: 500 },
            ],
            elements: [
              {
                role: "Button",
                label: "FaceTime",
                x: 950,
                y: 40,
                selected: true,
                app: "Control Center",
                window: "Control Center",
              },
              {
                role: "CheckBox",
                label: "Background",
                state: "off",
                x: 1100,
                y: 200,
                w: 90,
                h: 40,
                app: "Control Center",
                window: "Control Center",
              },
            ],
            truncated: "time",
          },
        },
      }),
    );
    const lines = result.text.split("\n");
    expect(lines).toContain('Button "Mute" @600,700');
    expect(lines).toContain("Menu bar: Apple @19,14 · FaceTime @60,14");
    expect(lines).toContain('  "Video Effects" @1000,14 [Control Center]');
    expect(lines).toContain('  "Battery" = "100%" @1053,14');
    expect(lines).toContain(
      '  Control Center "Control Center" at 900,0 300x400, 2 controls below',
    );
    expect(lines).toContain('  Safari "News" at 0,30 600x500');
    expect(lines).toContain(
      '  Button "FaceTime" @950,40 (selected) [Control Center]',
    );
    expect(lines).toContain(
      '  CheckBox "Background" @1100,200 90x40 (off) [Control Center]',
    );
    expect(result.text).toContain("(cut at the time budget)");
  });

  it("reports what a click hit and how its state changed", () => {
    const result = formatComputerResult(
      mac,
      "click",
      answer({
        ok: true,
        data: {
          cursor: [1097, 201],
          trusted: true,
          target: {
            role: "CheckBox",
            label: "Dark Mode",
            state: "on",
            x: 1097,
            y: 201,
            app: "Control Center",
          },
          targetAfter: {
            role: "CheckBox",
            label: "Dark Mode",
            state: "off",
            x: 1097,
            y: 201,
            app: "Control Center",
          },
          under: {
            role: "Window",
            x: 640,
            y: 360,
            app: "AquaAppearanceHelper",
          },
        },
      }),
    );
    expect(result.text).toContain("click done");
    expect(result.text).toContain(
      'Hit: CheckBox "Dark Mode" @1097,201 (on) [Control Center]',
    );
    expect(result.text).toContain("switched on → off");
    expect(result.text).toContain(
      "Under the pointer now: Window @640,360 [AquaAppearanceHelper]",
    );
  });

  it("says when the clicked control disappeared", () => {
    const result = formatComputerResult(
      mac,
      "click",
      answer({
        ok: true,
        data: {
          cursor: [86, 32],
          target: { role: "MenuItem", label: "About This Mac", x: 86, y: 32 },
          targetGone: true,
        },
      }),
    );
    expect(result.text).toContain('Hit: MenuItem "About This Mac" @86,32');
    expect(result.text).toContain("that control is gone");
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

describe("device_computer tool → bridge envelope", () => {
  it("keeps the gateway route when the desktop action is also called `action`", async () => {
    const { meshTools } = await import("../core/tools/ops/mesh.js");
    const tool = meshTools.find((t) => t.name === "device_computer");
    expect(tool).toBeDefined();
    let envelope: Record<string, unknown> = {};
    // Mirror bridge.ts, which posts `{ action, ...params }`.
    await tool!.execute(
      { device: "mac-mini", action: "screenshot" },
      async (action, params) => {
        envelope = { action, ...params };
        return undefined;
      },
    );
    expect(envelope.action).toBe("device_computer");
    expect(envelope.computer_action).toBe("screenshot");
  });
});
