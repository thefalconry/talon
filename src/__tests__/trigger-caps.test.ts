/**
 * Per-chat trigger caps — defaults, configured values, the separate
 * persistent budget, and the error copy that names the config key.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TRIGGER_CAPS,
  getTriggerCaps,
  triggerCapError,
} from "../core/background/triggers/index.js";
import { setTriggerCaps } from "../core/background/triggers/caps.js";

const adHoc = (n: number) =>
  Array.from({ length: n }, () => ({ persistent: false }));
const persistent = (n: number) =>
  Array.from({ length: n }, () => ({ persistent: true }));

afterEach(() => setTriggerCaps());

describe("trigger caps", () => {
  it("defaults to 5 active per chat with no persistent budget", () => {
    expect(DEFAULT_TRIGGER_CAPS).toEqual({ maxActivePerChat: 5 });
    expect(getTriggerCaps()).toEqual({ maxActivePerChat: 5 });
    expect(triggerCapError(adHoc(4), false)).toBeNull();
    expect(triggerCapError(adHoc(5), false)).not.toBeNull();
  });

  it("counts persistent and ad-hoc triggers together by default", () => {
    const active = [...persistent(4), ...adHoc(1)];
    const err = triggerCapError(active, false);
    expect(err).toBe(
      "Per-chat trigger cap reached (5 active). Cancel one before creating " +
        "another, or raise triggers.maxActivePerChat in ~/.talon/config.json.",
    );
    expect(triggerCapError(active, true)).toBe(err);
  });

  it("honours a configured maxActivePerChat", () => {
    setTriggerCaps({ maxActivePerChat: 12 });
    expect(getTriggerCaps().maxActivePerChat).toBe(12);
    expect(triggerCapError(adHoc(11), false)).toBeNull();
    expect(triggerCapError(adHoc(12), false)).toContain("(12 active)");
  });

  it("falls back to defaults for missing fields", () => {
    setTriggerCaps({ maxPersistentPerChat: 3 });
    expect(getTriggerCaps()).toEqual({
      maxActivePerChat: 5,
      maxPersistentPerChat: 3,
    });
    setTriggerCaps();
    expect(getTriggerCaps()).toEqual({ maxActivePerChat: 5 });
  });

  describe("with a separate persistent budget", () => {
    it("persistent watchers don't starve ad-hoc triggers", () => {
      setTriggerCaps({ maxActivePerChat: 2, maxPersistentPerChat: 4 });
      const active = [...persistent(4), ...adHoc(1)];
      expect(triggerCapError(active, false)).toBeNull();
      expect(triggerCapError([...active, ...adHoc(1)], false)).toBe(
        "Per-chat ad-hoc trigger cap reached (2 non-persistent active). " +
          "Cancel one before creating another, or raise " +
          "triggers.maxActivePerChat in ~/.talon/config.json.",
      );
    });

    it("bounds persistent triggers by their own budget", () => {
      setTriggerCaps({ maxActivePerChat: 2, maxPersistentPerChat: 4 });
      expect(triggerCapError([...persistent(3), ...adHoc(2)], true)).toBeNull();
      expect(triggerCapError([...persistent(4), ...adHoc(0)], true)).toBe(
        "Per-chat persistent trigger cap reached (4 persistent active). " +
          "Cancel one before creating another, or raise " +
          "triggers.maxPersistentPerChat in ~/.talon/config.json.",
      );
    });
  });
});
