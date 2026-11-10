import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyInboundRedaction,
  redactInbound,
  resetRedactionCache,
  shouldDeleteRedacted,
} from "../core/secrets/redact.js";

const emptyDir = mkdtempSync(join(tmpdir(), "talon-redact-empty-"));
const storedDir = mkdtempSync(join(tmpdir(), "talon-redact-stored-"));

afterAll(() => {
  rmSync(emptyDir, { recursive: true, force: true });
  rmSync(storedDir, { recursive: true, force: true });
});

beforeEach(() => resetRedactionCache());

const redact = (text: string, dir = emptyDir) =>
  redactInbound(text, { secretsDir: dir });

describe("password words", () => {
  it.each([
    ["password: hunter2", "password: [REDACTED:password]"],
    ["my password is Tr0ub4dor&3", "my password is [REDACTED:password]"],
    ["pw=abc", "pw=[REDACTED:password]"],
    ["Passcode: letmein.", "Passcode: [REDACTED:password]."],
    [
      "wifi passphrase - c0rrect-horse",
      "wifi passphrase - [REDACTED:password]",
    ],
    ["pin 4821", "pin [REDACTED:pin]"],
    ["the PIN is 004821!", "the PIN is [REDACTED:pin]!"],
    ["pin code: 123", "pin code: [REDACTED:pin]"],
  ])("%s", (input, expected) => {
    const r = redact(input);
    expect(r.text).toBe(expected);
    expect(r.kinds.length).toBe(1);
  });
});

describe("near misses stay untouched", () => {
  it.each([
    "I forgot my password",
    "my password is wrong",
    "the password is in the drawer",
    "password reset link please",
    "pin the message",
    "pin this to the top",
    "pin 12",
    "I'll pass on 2pm-ish",
    "the token was revoked yesterday",
    "api key rotation is due",
    "sk-short",
    "call me at 0871234567",
    "commit 3fd5cfc0a1b2c3d4e5f6",
    "it costs $1,234.56",
    "my pwd is fine",
    "https://example.com/reset-password?step=2",
  ])("%s", (input) => {
    const r = redact(input);
    expect(r.text).toBe(input);
    expect(r.kinds).toEqual([]);
  });
});

describe("key and token shapes", () => {
  it.each([
    ["sk-ant-api03-abcdefghijklmnopqrstuvwx", "api-key"],
    ["sk-proj-ABCDEFGHIJKLMNOPQRSTUV12", "api-key"],
    ["ghp_" + "a1".repeat(18), "token"],
    ["github_pat_" + "A1_".repeat(12), "token"],
    ["AKIAIOSFODNN7EXAMPLE", "api-key"],
    ["AIza" + "b".repeat(35), "api-key"],
    ["sk_live_" + "x9".repeat(10), "api-key"],
    ["xoxb-1234567890-abcdefghij", "token"],
    ["123456789:AA" + "c".repeat(33), "token"],
    ["eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4", "token"],
  ])("%s", (secret, kind) => {
    const r = redact(`here you go ${secret} thanks`);
    expect(r.text).toBe(`here you go [REDACTED:${kind}] thanks`);
    expect(r.text).not.toContain(secret);
  });

  it("keeps the label of a labelled value", () => {
    const r = redact("api_key=" + "Zx81kq0pLmN3vB7rT2");
    expect(r.text).toBe("api_key=[REDACTED:token]");
  });

  it("removes a whole PEM private key", () => {
    const pem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
    const r = redact(`key:\n${pem}\nok`);
    expect(r.text).toBe("key:\n[REDACTED:private-key]\nok");
  });
});

describe("stored secrets", () => {
  it("redacts any value already in the secrets folder", () => {
    writeFileSync(join(storedDir, "gmail"), "plain words value\n", {
      mode: 0o600,
    });
    writeFileSync(join(storedDir, "tiny"), "abc", { mode: 0o600 });
    const r = redact("it's plain words value, and abc stays", storedDir);
    expect(r.text).toBe("it's [REDACTED:stored], and abc stays");
    expect(r.kinds).toEqual(["stored"]);
  });

  it("ignores temp files from an in-flight write", () => {
    writeFileSync(join(storedDir, ".x.1234.tmp"), "dotfile-value-123");
    resetRedactionCache();
    expect(redact("dotfile-value-123 here", storedDir).kinds).toEqual([]);
  });
});

describe("applyInboundRedaction", () => {
  it("is a no-op when disabled", () => {
    const r = applyInboundRedaction("password: hunter2", {
      chatKey: "c-off",
      isDm: true,
      config: { enabled: false },
      secretsDir: emptyDir,
    });
    expect(r).toEqual({
      text: "password: hunter2",
      redacted: false,
      deleteOriginal: false,
    });
  });

  it("nudges toward /secret once per chat, never echoing the value", () => {
    const opts = { chatKey: "c-once", isDm: true, secretsDir: emptyDir };
    const first = applyInboundRedaction("password: hunter2", opts);
    expect(first.redacted).toBe(true);
    expect(first.deleteOriginal).toBe(true);
    expect(first.notice).toContain("/secret");
    expect(first.notice).not.toContain("hunter2");
    const second = applyInboundRedaction("pw: other99", opts);
    expect(second.redacted).toBe(true);
    expect(second.notice).toBeUndefined();
  });

  it("leaves clean messages alone and says nothing", () => {
    const r = applyInboundRedaction("hello there", {
      chatKey: "c-clean",
      isDm: true,
      secretsDir: emptyDir,
    });
    expect(r).toEqual({
      text: "hello there",
      redacted: false,
      deleteOriginal: false,
    });
  });

  it("deletes per config: dm (default), always, never", () => {
    expect(shouldDeleteRedacted(undefined, true)).toBe(true);
    expect(shouldDeleteRedacted(undefined, false)).toBe(false);
    expect(shouldDeleteRedacted("always", false)).toBe(true);
    expect(shouldDeleteRedacted("never", true)).toBe(false);
  });
});

describe("telegram middleware", () => {
  it("rewrites the message before history, deletes in DMs, nudges once", async () => {
    const { makeRedactCredentials } =
      await import("../frontend/telegram/middleware.js");
    const calls: string[] = [];
    const message = { message_id: 5, date: 0, text: "pw: Zq8!xx" };
    const ctx = {
      chat: { id: 777001, type: "private" },
      message,
      deleteMessage: async () => {
        calls.push("delete");
        return true;
      },
      reply: async (t: string) => {
        calls.push(`reply:${t}`);
        return {};
      },
    };
    let seen = "";
    const mw = makeRedactCredentials({ redaction: undefined } as never);
    await mw(ctx as never, async () => {
      seen = message.text;
    });
    expect(seen).toBe("pw: [REDACTED:password]");
    expect(calls[0]).toBe("delete");
    expect(calls[1]).toContain("/secret");
    expect(calls.join(" ")).not.toContain("Zq8!xx");
  });

  it("keeps the message in a group with the default config", async () => {
    const { makeRedactCredentials } =
      await import("../frontend/telegram/middleware.js");
    const calls: string[] = [];
    const message = {
      message_id: 6,
      date: 0,
      caption: "token: " + "Ab12Cd34Ef56Gh78Ij",
    };
    const ctx = {
      chat: { id: -100777, type: "supergroup" },
      message,
      deleteMessage: async () => calls.push("delete"),
      reply: async () => calls.push("reply"),
    };
    const mw = makeRedactCredentials({} as never);
    await mw(ctx as never, async () => {});
    expect(message.caption).toBe("token: [REDACTED:token]");
    expect(calls).toEqual(["reply"]);
  });
});
