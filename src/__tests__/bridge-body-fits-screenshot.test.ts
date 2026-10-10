import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "../frontend/native/bridge/server.js";

describe("bridge body limit vs node screenshot cap", () => {
  it("fits the largest computer screenshot a node can send, base64'd", () => {
    const go = readFileSync(
      join(__dirname, "../../apps/node/computer_darwin.go"),
      "utf-8",
    );
    const m = go.match(/computerMaxImageBytes\s*=\s*(\d+)\s*\*\s*(\d+)/);
    expect(m).not.toBeNull();
    const imageBytes = Number(m![1]) * Number(m![2]);
    // base64 grows by 4/3; leave 16 KB for the JSON envelope.
    expect(Math.ceil(imageBytes / 3) * 4 + 16 * 1024).toBeLessThan(
      MAX_BODY_BYTES,
    );
  });
});
