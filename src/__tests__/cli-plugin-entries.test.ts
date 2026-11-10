/**
 * `talon plugin` pure helpers — entry naming/matching, enable toggling,
 * npm spec parsing, install-source grammar.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  entryDisplayName,
  entryMatches,
  findConflictIndex,
  isBuiltinPlugin,
  npmSpecName,
  withEnabled,
  type PluginEntryJson,
} from "../core/plugin/entries.js";
import { resolveSource } from "../cli/install-sources.js";

describe("entryDisplayName", () => {
  it("uses the MCP name when present", () => {
    expect(
      entryDisplayName({ name: "fetch", command: "npx", args: ["-y", "x"] }),
    ).toBe("fetch");
  });

  it("uses the folder basename for plain path entries", () => {
    expect(entryDisplayName({ path: "/home/u/.talon/plugins/my-tool" })).toBe(
      "my-tool",
    );
  });

  it("preserves the scoped package name under node_modules", () => {
    expect(
      entryDisplayName({
        path: "/home/u/.talon/plugins/node_modules/@scope/pkg",
      }),
    ).toBe("@scope/pkg");
  });

  it("handles Windows separators", () => {
    expect(
      entryDisplayName({
        path: "C:\\Users\\u\\.talon\\plugins\\node_modules\\pkg",
      }),
    ).toBe("pkg");
  });
});

describe("entryMatches", () => {
  const entry: PluginEntryJson = {
    path: "/home/u/.talon/plugins/node_modules/@scope/pkg",
  };

  it("matches display name, basename, and full path", () => {
    expect(entryMatches(entry, "@scope/pkg")).toBe(true);
    expect(entryMatches(entry, "pkg")).toBe(true);
    expect(
      entryMatches(entry, "/home/u/.talon/plugins/node_modules/@scope/pkg"),
    ).toBe(true);
  });

  it("rejects other tokens", () => {
    expect(entryMatches(entry, "scope")).toBe(false);
    expect(entryMatches(entry, "other")).toBe(false);
  });
});

describe("findConflictIndex", () => {
  it("finds a same-path module entry but not a same-name coincidence", () => {
    const entries: PluginEntryJson[] = [
      { path: "/a/tool" },
      { name: "fetch", command: "npx" },
    ];
    expect(findConflictIndex(entries, { path: "/a/tool" })).toBe(0);
    expect(findConflictIndex(entries, { path: "/b/tool" })).toBe(-1);
    expect(findConflictIndex(entries, { name: "fetch", command: "uvx" })).toBe(
      1,
    );
    expect(findConflictIndex(entries, { name: "other", command: "npx" })).toBe(
      -1,
    );
  });
});

describe("withEnabled", () => {
  it("removes the key when enabling (enabled is the default)", () => {
    expect(withEnabled({ path: "/a", enabled: false }, true)).toEqual({
      path: "/a",
    });
  });

  it("writes enabled: false when disabling", () => {
    expect(withEnabled({ path: "/a" }, false)).toEqual({
      path: "/a",
      enabled: false,
    });
  });
});

describe("npmSpecName", () => {
  it("strips versions and keeps scopes", () => {
    expect(npmSpecName("pkg")).toBe("pkg");
    expect(npmSpecName("pkg@1.2.3")).toBe("pkg");
    expect(npmSpecName("@scope/pkg")).toBe("@scope/pkg");
    expect(npmSpecName("@scope/pkg@^2")).toBe("@scope/pkg");
  });
});

describe("isBuiltinPlugin", () => {
  it("recognises the built-in config sections", () => {
    expect(isBuiltinPlugin("github")).toBe(true);
    expect(isBuiltinPlugin("playwright")).toBe(true);
    expect(isBuiltinPlugin("my-plugin")).toBe(false);
  });
});

describe("resolveSource", () => {
  it("resolves an existing path to local", () => {
    const dir = mkdtempSync(join(tmpdir(), "talon-src-"));
    try {
      expect(resolveSource(dir)).toEqual({ kind: "local", dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recognises git URLs", () => {
    expect(resolveSource("https://github.com/o/r.git")).toEqual({
      kind: "git",
      url: "https://github.com/o/r.git",
    });
    expect(resolveSource("git@github.com:o/r.git")).toEqual({
      kind: "git",
      url: "git@github.com:o/r.git",
    });
  });

  it("expands owner/repo shorthand, with and without subpath", () => {
    expect(resolveSource("anthropics/skills")).toEqual({
      kind: "git",
      url: "https://github.com/anthropics/skills.git",
    });
    expect(resolveSource("anthropics/skills/document-skills/pdf")).toEqual({
      kind: "git",
      url: "https://github.com/anthropics/skills.git",
      subpath: "document-skills/pdf",
    });
  });

  it("reads a #<commit> suffix as a pin on git sources only", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(resolveSource(`https://github.com/o/r.git#${sha}`)).toEqual({
      kind: "git",
      url: "https://github.com/o/r.git",
      commit: sha,
    });
    expect(
      resolveSource("anthropics/skills/document-skills/pdf#ABC1234"),
    ).toEqual({
      kind: "git",
      url: "https://github.com/anthropics/skills.git",
      subpath: "document-skills/pdf",
      commit: "abc1234",
    });
    // A non-hex fragment is not a pin; an npm spec keeps its own grammar.
    expect(resolveSource("o/r#semver:^1.0")).toEqual({
      kind: "other",
      raw: "o/r#semver:^1.0",
    });
    expect(resolveSource("@scope/pkg#abc1234")).toEqual({
      kind: "other",
      raw: "@scope/pkg#abc1234",
    });
  });

  it("treats npm specs as other — scoped names are not shorthand", () => {
    expect(resolveSource("@scope/pkg")).toEqual({
      kind: "other",
      raw: "@scope/pkg",
    });
    expect(resolveSource("plain-package")).toEqual({
      kind: "other",
      raw: "plain-package",
    });
  });
});
