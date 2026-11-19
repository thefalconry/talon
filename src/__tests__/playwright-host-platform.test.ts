import { describe, expect, it } from "vitest";
import { hostPlatformOverride } from "../plugins/playwright/host-platform.js";

const ubuntu = (version: string, id = "ubuntu") =>
  `NAME="Ubuntu"\nVERSION_ID="${version}"\nID=${id}\nID_LIKE=debian\n`;

const base = {
  platform: "linux" as const,
  arch: "x64",
  env: {},
  knowsUbuntu: () => false,
};

describe("hostPlatformOverride", () => {
  it("maps an Ubuntu newer than the bundled table to the newest known key", () => {
    expect(
      hostPlatformOverride("cli.js", { ...base, osRelease: ubuntu("26.04") }),
    ).toBe("ubuntu24.04-x64");
    expect(
      hostPlatformOverride("cli.js", {
        ...base,
        arch: "arm64",
        osRelease: ubuntu("26.04"),
      }),
    ).toBe("ubuntu24.04-arm64");
  });

  it("covers the derivatives playwright-core treats as Ubuntu", () => {
    expect(
      hostPlatformOverride("cli.js", {
        ...base,
        osRelease: ubuntu("26.04", "pop"),
      }),
    ).toBe("ubuntu24.04-x64");
  });

  it("leaves releases playwright-core handles itself alone", () => {
    for (const v of ["20.04", "22.04", "24.04", "24.10"]) {
      expect(
        hostPlatformOverride("cli.js", { ...base, osRelease: ubuntu(v) }),
      ).toBeUndefined();
    }
  });

  it("stands down once the bundled playwright-core knows the release", () => {
    expect(
      hostPlatformOverride("cli.js", {
        ...base,
        osRelease: ubuntu("26.04"),
        knowsUbuntu: (v) => v === "26.04",
      }),
    ).toBeUndefined();
  });

  it("never applies off Linux, on other distros, or over an operator's value", () => {
    expect(
      hostPlatformOverride("cli.js", {
        ...base,
        platform: "darwin",
        osRelease: ubuntu("26.04"),
      }),
    ).toBeUndefined();
    expect(
      hostPlatformOverride("cli.js", {
        ...base,
        osRelease: 'ID=debian\nVERSION_ID="14"\n',
      }),
    ).toBeUndefined();
    expect(
      hostPlatformOverride("cli.js", {
        ...base,
        env: { PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: "ubuntu22.04-x64" },
        osRelease: ubuntu("26.04"),
      }),
    ).toBeUndefined();
    expect(
      hostPlatformOverride("cli.js", { ...base, osRelease: "" }),
    ).toBeUndefined();
  });
});
