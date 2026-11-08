import { describe, it, expect } from "vitest";
import {
  talonCommit,
  talonVersion,
  talonVersionLabel,
} from "../util/version.js";

describe("talonVersionLabel", () => {
  it("starts with the package version", () => {
    expect(talonVersionLabel().startsWith(`v${talonVersion()}`)).toBe(true);
  });

  it("appends a short commit only when one was read, and caches it", () => {
    const c = talonCommit();
    expect(talonCommit()).toBe(c);
    if (c) {
      expect(c).toMatch(/^[0-9a-f]{7,40}$/);
      expect(talonVersionLabel()).toBe(`v${talonVersion()} (${c})`);
    } else {
      expect(talonVersionLabel()).toBe(`v${talonVersion()}`);
    }
  });
});
