/**
 * `talon setup` must not destroy config it doesn't prompt for.
 *
 * The wizard models roughly half of ~/.talon/config.json. It used to build
 * the saved object from its own named fields alone, so re-running it on a
 * configured install silently deleted every other key — on a real
 * deployment that was 26 of 40 keys, including the `whatsapp` block the
 * loader hard-requires, which left the daemon refusing to boot.
 *
 * The path in is just as load-bearing: `isConfigured` gates the main menu,
 * and it had no WhatsApp case, so it fell through to the fail-closed branch
 * and sent every WhatsApp user into that same wizard on a plain `talon`.
 */

import { describe, it, expect } from "vitest";
import { buildSetupConfig, type SetupAnswers } from "../cli/setup.js";
import { DEFAULTS, isConfigured, type Config } from "../cli/config.js";

const answers = (over: Partial<SetupAnswers> = {}): SetupAnswers => ({
  selectedFrontends: ["telegram"],
  backend: "claude",
  botToken: "123:abc",
  model: "default",
  pulse: true,
  ...over,
});

/** A config shaped like a real deployment: many keys the wizard never asks about. */
const lived = (): Config =>
  ({
    ...DEFAULTS,
    frontend: ["telegram", "native", "whatsapp"],
    botToken: "123:abc",
    whatsapp: {
      allowedJids: ["447700900102"],
      groupPolicy: "with-allowed-user",
    },
    native: { host: "127.0.0.1", port: 19880 },
    soul: { enabled: true },
    github: { enabled: true, token: "ghp_x" },
    memory: { enabled: true, backend: "mempalace" },
    heartbeat: true,
    heartbeatIntervalMinutes: 60,
    dreamModel: "sonnet",
    braveApiKey: "BSA-x",
    adminUserId: 1,
    allowedUsers: [1, 2],
    nativeTools: true,
    timezone: "Europe/London",
  }) as Config;

describe("buildSetupConfig — keys the wizard never prompts for", () => {
  it("preserves every unprompted key", () => {
    const before = lived();
    const after = buildSetupConfig(before, answers()) as Record<
      string,
      unknown
    >;

    for (const key of [
      "native",
      "soul",
      "github",
      "memory",
      "heartbeat",
      "heartbeatIntervalMinutes",
      "dreamModel",
      "braveApiKey",
      "allowedUsers",
      "nativeTools",
      "timezone",
    ]) {
      expect(after[key], `${key} was dropped`).toEqual(
        (before as Record<string, unknown>)[key],
      );
    }
  });

  it("keeps the whatsapp block when WhatsApp is not among the selected frontends", () => {
    // Deselecting (or never selecting) a frontend must not throw away its
    // pairing setup — and dropping this block makes the loader refuse to boot.
    const after = buildSetupConfig(
      lived(),
      answers({ selectedFrontends: ["telegram"] }),
    );
    expect(after.whatsapp).toEqual({
      allowedJids: ["447700900102"],
      groupPolicy: "with-allowed-user",
    });
  });

  it("writes the whatsapp block when WhatsApp is selected", () => {
    const after = buildSetupConfig(
      lived(),
      answers({
        selectedFrontends: ["telegram", "whatsapp"],
        whatsapp: { allowedJids: ["447700900000"], groupPolicy: "all" },
      }),
    );
    expect(after.whatsapp).toEqual({
      allowedJids: ["447700900000"],
      groupPolicy: "all",
    });
    expect(after.frontend).toEqual(["telegram", "whatsapp"]);
  });
});

describe("buildSetupConfig — prompted fields still win", () => {
  it("overrides what the wizard did ask about", () => {
    const after = buildSetupConfig(
      lived(),
      answers({ model: "opus", pulse: false, botToken: "999:zzz" }),
    );
    expect(after.model).toBe("opus");
    expect(after.pulse).toBe(false);
    expect(after.botToken).toBe("999:zzz");
  });

  it("still clears a deselected frontend's credentials", () => {
    // saveConfig strips undefined, so this is the delete path — unchanged.
    const after = buildSetupConfig(
      lived(),
      answers({ selectedFrontends: ["terminal"], botToken: undefined }),
    );
    expect(after.botToken).toBeUndefined();
    expect(after.teamsWebhookUrl).toBeUndefined();
  });

  it("collapses a single frontend to a string, keeps several as an array", () => {
    expect(
      buildSetupConfig(lived(), answers({ selectedFrontends: ["terminal"] }))
        .frontend,
    ).toBe("terminal");
    expect(
      buildSetupConfig(
        lived(),
        answers({ selectedFrontends: ["telegram", "native"] }),
      ).frontend,
    ).toEqual(["telegram", "native"]);
  });
});

describe("isConfigured — the gate into the wizard", () => {
  const cfg = (over: Partial<Config>): Config =>
    ({ ...DEFAULTS, ...over }) as Config;

  it("treats a WhatsApp frontend with its block as configured", () => {
    expect(
      isConfigured(
        cfg({ frontend: "whatsapp", whatsapp: { allowedJids: [] } }),
      ),
    ).toBe(true);
  });

  it("treats a WhatsApp frontend with no block as unconfigured", () => {
    // The loader hard-requires the block, so this genuinely does need setup.
    expect(isConfigured(cfg({ frontend: "whatsapp" }))).toBe(false);
  });

  it("does not push a live telegram+native+whatsapp install into setup", () => {
    expect(
      isConfigured(
        cfg({
          frontend: ["telegram", "native", "whatsapp"],
          botToken: "123:abc",
          adminUserId: 1,
          whatsapp: { allowedJids: ["447700900102"] },
        }),
      ),
    ).toBe(true);
  });

  it("still fails closed on an unknown frontend name", () => {
    expect(isConfigured(cfg({ frontend: "carrier-pigeon" }))).toBe(false);
  });
});

describe("main-menu frontend label", () => {
  it("names every built-in frontend from the registry", async () => {
    // The menu header used to run its own if/else chain that fell through
    // to "Terminal" for anything it didn't name — so a WhatsApp install
    // announced itself as Terminal. Labels now come from the registry.
    const { getFrontendDescriptor } =
      await import("../core/frontend-runtime/routing.js");
    const label = (id: string) => getFrontendDescriptor(id)?.label ?? id;

    expect(label("whatsapp")).toBe("WhatsApp");
    expect(label("telegram")).toBe("Telegram");
    expect(label("native")).toBe("Native");
    expect(label("terminal")).toBe("Terminal");
    expect(label("discord")).toBe("Discord");
    expect(label("teams")).toBe("Teams");
    // An unknown id shows itself rather than impersonating a real frontend.
    expect(label("carrier-pigeon")).toBe("carrier-pigeon");
  });
});

describe("the whatsapp block the wizard writes", () => {
  it("uses only keys the daemon's strict schema accepts", () => {
    // `whatsappConfigSchema` in core/config/index.ts is `.strict()`, so a key the
    // wizard invents here would make the daemon refuse to load the config
    // it just wrote. Keep this list in step with that schema.
    const allowed = new Set([
      "allowedJids",
      "allowedGroups",
      "groupPolicy",
      "respondMode",
      "pairingNumber",
      "sendReadReceipts",
    ]);

    const after = buildSetupConfig(
      lived(),
      answers({
        selectedFrontends: ["whatsapp"],
        whatsapp: {
          allowedJids: ["353871234567"],
          groupPolicy: "listed",
          pairingNumber: "447700900101",
        },
      }),
    );

    for (const key of Object.keys(after.whatsapp ?? {})) {
      expect(allowed.has(key), `"${key}" is not in whatsappConfigSchema`).toBe(
        true,
      );
    }
  });
});

describe("backend credentials belonging to a backend the wizard didn't ask about", () => {
  // The wizard prompts for exactly one backend's credentials — an
  // if/else-if chain on the chosen backend. Taking every answer
  // unconditionally therefore deleted the others, even though
  // `enabledBackends` and per-chat overrides keep them reachable.
  const withKeys = (): Config =>
    ({
      ...DEFAULTS,
      frontend: "telegram",
      botToken: "123:abc",
      backend: "claude",
      claudeBinary: "/usr/bin/claude",
      codexApiKey: "sk-codex",
      openaiApiKey: "sk-or-v1-openrouter",
      openaiBaseUrl: "https://openrouter.ai/api/v1",
      openaiApiMode: "chat_completions",
      enabledBackends: ["claude", "openai-agents"],
    }) as Config;

  it("keeps the OpenAI/OpenRouter credentials when the claude backend is chosen", () => {
    const after = buildSetupConfig(
      withKeys(),
      answers({ backend: "claude", claudeBinary: "/opt/claude" }),
    );
    expect(after.claudeBinary).toBe("/opt/claude"); // prompted → overwritten
    expect(after.openaiApiKey).toBe("sk-or-v1-openrouter"); // not prompted → kept
    expect(after.openaiBaseUrl).toBe("https://openrouter.ai/api/v1");
    expect(after.openaiApiMode).toBe("chat_completions");
    expect(after.codexApiKey).toBe("sk-codex");
  });

  it("keeps claude and codex credentials when openai-agents is chosen", () => {
    const after = buildSetupConfig(
      withKeys(),
      answers({
        backend: "openai-agents",
        openaiApiKey: "sk-new",
        openaiBaseUrl: "https://api.openai.com/v1",
      }),
    );
    expect(after.openaiApiKey).toBe("sk-new");
    expect(after.claudeBinary).toBe("/usr/bin/claude");
    expect(after.codexApiKey).toBe("sk-codex");
  });

  it("keeps all of them when a backend with no credential prompt is chosen", () => {
    // kilo / opencode prompt for nothing — they used to wipe all five.
    const after = buildSetupConfig(withKeys(), answers({ backend: "kilo" }));
    expect(after.claudeBinary).toBe("/usr/bin/claude");
    expect(after.codexApiKey).toBe("sk-codex");
    expect(after.openaiApiKey).toBe("sk-or-v1-openrouter");
    expect(after.openaiBaseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("still clears a credential the user blanks on its own prompt", () => {
    const after = buildSetupConfig(
      withKeys(),
      answers({ backend: "claude", claudeBinary: undefined }),
    );
    expect(after.claudeBinary).toBeUndefined();
  });
});

describe("the exact failure an existing WhatsApp user hit", () => {
  it("keeps `frontend` and the whatsapp block consistent with each other", () => {
    // @clack's multiselect seeds its value straight from `initialValues`
    // without filtering against `options`, so before WhatsApp was an
    // option it still rode through the picker invisibly — `frontend` came
    // back containing "whatsapp" while the rebuilt config had no
    // `whatsapp` block. core/config/index.ts then refuses to load that pairing
    // outright ("WhatsApp frontend requires a whatsapp config block"), so
    // finishing the wizard left a daemon that would not start.
    const after = buildSetupConfig(
      lived(),
      answers({ selectedFrontends: ["telegram", "whatsapp"] }),
    );
    const fes = Array.isArray(after.frontend)
      ? after.frontend
      : [after.frontend];
    if (fes.includes("whatsapp")) expect(after.whatsapp).toBeDefined();
  });
});
