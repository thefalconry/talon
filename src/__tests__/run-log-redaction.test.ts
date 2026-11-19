import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRunLog } from "../core/background/run-log.js";
import {
  redactCredentials,
  resetRedactionCache,
} from "../core/secrets/redact.js";

const GITHUB_TOKEN = `ghp_${"a1B2".repeat(9)}`;

describe("run log redaction", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-log-"));
    resetRedactionCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a token in a tool call out of the file", async () => {
    const file = join(dir, "logs", "agent.md");
    const append = await openRunLog(file, "# header\n");
    await append(`git remote add o https://x:${GITHUB_TOKEN}@github.com/a/b\n`);
    await append("plain line\n");

    const written = readFileSync(file, "utf8");
    expect(written).not.toContain(GITHUB_TOKEN);
    expect(written).toContain("[REDACTED:token]");
    expect(written).toContain("# header\n");
    expect(written).toContain("plain line\n");
  });

  it("redacts a stored secret that has no known shape", () => {
    const secretsDir = join(dir, "secrets");
    mkdirSync(secretsDir);
    writeFileSync(join(secretsDir, "plain"), "correct-horse-battery\n");
    expect(
      redactCredentials("value correct-horse-battery end", { secretsDir }),
    ).toBe("value [REDACTED:stored] end");
  });

  it("does not apply the chat password matchers to log text", () => {
    const text = "pin 4821 of the header, password: hunter2";
    expect(redactCredentials(text, { secretsDir: dir })).toBe(text);
  });
});
