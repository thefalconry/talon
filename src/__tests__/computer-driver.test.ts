/**
 * The node's macOS JXA driver (apps/node/computer_darwin.js) only runs under
 * osascript on a Mac, but its pure helpers are plain JavaScript. Load the
 * script into a sandbox with the ObjC bridge stubbed out and check the parts
 * that decide what a snapshot says: on/off state and the item shape.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type Item = Record<string, unknown> | null;
interface Driver {
  toggleState(a: Record<string, unknown>): string;
  axItem(a: Record<string, unknown>, geo: Geo, keepAll: boolean): Item;
  isSecureField(role: unknown, subrole: unknown): boolean;
}
interface Geo {
  f: number;
  w: number;
  h: number;
}

function loadDriver(): Driver {
  const source = readFileSync(
    join(__dirname, "../../apps/node/computer_darwin.js"),
    "utf-8",
  );
  const sandbox: Record<string, unknown> = {
    ObjC: { import: () => undefined },
    $: {},
  };
  runInNewContext(source, sandbox);
  return sandbox as unknown as Driver;
}

const retina: Geo = { f: 2, w: 1280, h: 831 };

describe("computer_darwin.js helpers", () => {
  const driver = loadDriver();

  it.each([
    [{ AXRole: "AXCheckBox", AXValue: 1 }, "on"],
    [{ AXRole: "AXCheckBox", AXValue: 0 }, "off"],
    [{ AXRole: "AXCheckBox", AXValue: 2 }, "mixed"],
    [{ AXRole: "AXSwitch", AXValue: true }, "on"],
    [{ AXRole: "AXRadioButton", AXValue: 0 }, "off"],
    [{ AXRole: "AXMenuItem", AXMenuItemMarkChar: "✓" }, "on"],
    [{ AXRole: "AXMenuItem", AXMenuItemMarkChar: null }, ""],
    [{ AXRole: "AXButton", AXValue: 1 }, ""],
    [{ AXRole: "AXCheckBox", AXValue: "x" }, ""],
  ])("reads the state of %j as %j", (attrs, want) => {
    expect(driver.toggleState(attrs)).toBe(want);
  });

  it("maps a toggle into the click space with its state, not a raw value", () => {
    const item = driver.axItem(
      {
        AXRole: "AXCheckBox",
        AXTitle: "Background",
        AXValue: 1,
        AXPosition: [2000, 400],
        AXSize: [200, 80],
        AXEnabled: true,
      },
      retina,
      false,
    );
    expect(item).toEqual({
      role: "CheckBox",
      label: "Background",
      state: "on",
      x: 1050,
      y: 220,
      w: 100,
      h: 40,
    });
  });

  it("falls back to the description, then the identifier, for a label", () => {
    const fromDescription = driver.axItem(
      {
        AXRole: "AXMenuBarItem",
        AXDescription: "Wi‑Fi, connected",
        AXPosition: [100, 0],
        AXSize: [30, 30],
      },
      retina,
      false,
    );
    expect(fromDescription?.label).toBe("Wi‑Fi, connected");
    const fromIdentifier = driver.axItem(
      {
        AXRole: "AXButton",
        AXIdentifier: "videoEffects",
        AXPosition: [10, 10],
        AXSize: [20, 20],
      },
      retina,
      false,
    );
    expect(fromIdentifier?.label).toBe("videoEffects");
  });

  it("drops what is off the primary display, sizeless, or unlabeled scenery", () => {
    const base = { AXRole: "AXButton", AXTitle: "OK", AXSize: [20, 20] };
    expect(
      driver.axItem({ ...base, AXPosition: [3000, 10] }, retina, false),
    ).toBeNull();
    expect(
      driver.axItem({ ...base, AXPosition: [-500, 10] }, retina, false),
    ).toBeNull();
    expect(
      driver.axItem(
        { ...base, AXPosition: [10, 10], AXSize: [0, 0] },
        retina,
        false,
      ),
    ).toBeNull();
    const group = {
      AXRole: "AXGroup",
      AXPosition: [10, 10],
      AXSize: [20, 20],
    };
    expect(driver.axItem(group, retina, false)).toBeNull();
    expect(driver.axItem(group, retina, true)).toMatchObject({ role: "Group" });
  });

  it("never reports what is typed into a password field", () => {
    const item = driver.axItem(
      {
        AXRole: "AXSecureTextField",
        AXTitle: "Password",
        AXValue: "hunter2",
        AXPosition: [10, 10],
        AXSize: [100, 20],
      },
      retina,
      false,
    );
    expect(item?.value).toBeUndefined();
  });

  it("never reports a password field's value as macOS really exposes it (AXTextField + AXSecureTextField subrole)", () => {
    for (const keepAll of [false, true]) {
      const item = driver.axItem(
        {
          AXRole: "AXTextField",
          AXSubrole: "AXSecureTextField",
          AXTitle: "Password",
          AXValue: "hunter2",
          AXPosition: [10, 10],
          AXSize: [100, 20],
        },
        retina,
        keepAll,
      );
      expect(item).toMatchObject({ role: "TextField", label: "Password" });
      expect(item?.value).toBeUndefined();
    }
    // The System Events snapshot path uses the same check on its role and
    // subrole properties.
    expect(driver.isSecureField("AXTextField", "AXSecureTextField")).toBe(true);
    expect(driver.isSecureField("AXSecureTextField", undefined)).toBe(true);
    expect(driver.isSecureField("AXTextField", "AXSearchField")).toBe(false);
  });

  it("flags selected, expanded, disabled and focused controls", () => {
    const item = driver.axItem(
      {
        AXRole: "AXTab",
        AXTitle: "FaceTime",
        AXSelected: true,
        AXExpanded: true,
        AXEnabled: false,
        AXFocused: true,
        AXPosition: [0, 0],
        AXSize: [10, 10],
      },
      retina,
      false,
    );
    expect(item).toMatchObject({
      selected: true,
      expanded: true,
      disabled: true,
      focused: true,
    });
  });
});
