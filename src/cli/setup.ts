/**
 * Guided setup wizard — collects frontend/backend config interactively and
 * writes talon.json.
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import { printBanner, loadConfig, saveConfig, type Config } from "./config.js";
import { binaryOnPath } from "../util/binary-on-path.js";
import { detectAgyAuth } from "../backend/agy/auth.js";

/** Strip spaces, "+", brackets and dashes from a phone number. */
const bareDigits = (raw: string) => raw.replace(/[\s+()-]/g, "");

/** "353871234567, +44 7700 900000" → ["353871234567", "447700900000"]. */
function parseNumberList(raw: string): string[] {
  return raw
    .split(",")
    .map(bareDigits)
    .filter((entry) => entry.length > 0);
}

/** Empty answers mean "unset"; everything else is trimmed. */
const trimmedOrUndefined = (raw: string) => raw.trim() || undefined;

/**
 * Await a clack prompt; on Esc/Ctrl-C say so and leave the wizard.
 *
 * clack only ever resolves a symbol to mean "cancelled", so narrowing on
 * `typeof` replaces a per-prompt `isCancel` guard and the `as` cast that
 * `@clack/core`'s own unique-symbol narrowing would still need.
 *
 * The answer type is subtracted with `Exclude` rather than inferred from a
 * `Promise<T | symbol>` parameter: clack 1.8.1 retyped `CANCEL_SYMBOL` as a
 * `unique symbol`, which no longer cancels out against a plain `symbol` in
 * the target, so every caller inferred `T` as the whole `answer | symbol`
 * union and leaked the symbol into the config.
 */
async function askOrExit<T>(prompt: Promise<T>): Promise<Exclude<T, symbol>> {
  const value = await prompt;
  if (typeof value === "symbol") {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  return value as Exclude<T, symbol>;
}

// ── Steps: each prompts for one section and returns its slice of the answers ──

async function askFrontends(config: Config): Promise<string[]> {
  const existingFrontends = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend || "telegram"];

  return askOrExit(
    p.multiselect({
      message: "Frontend platforms (space to toggle, enter to confirm)",
      initialValues: existingFrontends,
      options: [
        {
          value: "telegram",
          label: `Telegram  ${pc.dim("— bot via @BotFather")}`,
        },
        {
          value: "whatsapp",
          label: `WhatsApp  ${pc.dim("— a real account via Baileys multi-device")}`,
        },
        {
          value: "discord",
          label: `Discord   ${pc.dim("— bot via Developer Portal (discord.js v14)")}`,
        },
        {
          value: "teams",
          label: `Teams     ${pc.dim("— Microsoft Teams via Power Automate")}`,
        },
        {
          value: "terminal",
          label: `Terminal  ${pc.dim("— local CLI chat")}`,
        },
        {
          value: "native",
          label: `Native    ${pc.dim("— HTTP+SSE bridge for the companion app")}`,
        },
      ],
      required: true,
    }),
  );
}

type TelegramAnswers = Pick<
  SetupAnswers,
  "botToken" | "adminId" | "apiId" | "apiHash"
>;

/**
 * The Telegram admin id is required: it is the bot's owner (admin commands)
 * and the default DM allowlist. The daemon refuses to start without it.
 */
export function validateTelegramAdminId(
  value: string | undefined,
): string | undefined {
  const v = value?.trim() ?? "";
  if (!v) return "Required — the bot answers only its admin (and allowedUsers)";
  if (!/^\d+$/.test(v) || Number(v) <= 0 || !Number.isSafeInteger(Number(v)))
    return "Must be your numeric Telegram user ID";
  return undefined;
}

async function askTelegram(config: Config): Promise<TelegramAnswers> {
  const botToken = await askOrExit(
    p.text({
      message: "Bot token",
      placeholder: "Paste your token from @BotFather",
      initialValue: config.botToken || undefined,
      validate: (v) => {
        if (!v) return "Token is required";
        if (!v.includes(":")) return "Invalid format";
      },
    }),
  );

  const adminId = await askOrExit(
    p.text({
      message: "Your Telegram user ID",
      placeholder: "message @userinfobot to find yours",
      initialValue: config.adminUserId ? String(config.adminUserId) : "",
      validate: validateTelegramAdminId,
    }),
  );

  const wantUserbot = await askOrExit(
    p.confirm({
      message: "Set up userbot for full history access?",
      initialValue: !!(config.apiId && config.apiHash),
    }),
  );
  if (!wantUserbot) return { botToken, adminId };

  p.note(
    "Get these from https://my.telegram.org → API development tools",
    "Telegram API credentials",
  );
  const id = await askOrExit(
    p.text({
      message: "API ID",
      placeholder: "12345678",
      initialValue: config.apiId ? String(config.apiId) : "",
      validate: (v) => {
        if (v && isNaN(parseInt(v, 10))) return "Must be a number";
      },
    }),
  );
  const hash = await askOrExit(
    p.text({
      message: "API Hash",
      initialValue: config.apiHash || "",
    }),
  );
  return {
    botToken,
    adminId,
    ...(id ? { apiId: parseInt(id, 10) } : {}),
    ...(hash ? { apiHash: hash } : {}),
  };
}

type TeamsAnswers = Pick<
  SetupAnswers,
  | "teamsWebhookUrl"
  | "teamsWebhookSecret"
  | "teamsWebhookPort"
  | "teamsBotDisplayName"
>;

async function askTeams(config: Config): Promise<TeamsAnswers> {
  p.note(
    "Set up two Power Automate workflows in Teams:\n" +
      "1. Send: 'Post to a channel when a webhook request is received' — copy the URL below\n" +
      "2. Receive: 'When a new channel message is added' → HTTP POST to your Talon endpoint",
    "Teams Setup",
  );

  const teamsWebhookUrl = await askOrExit(
    p.text({
      message: "Power Automate webhook URL (for sending to Teams)",
      placeholder: "https://prod-XX.westus.logic.azure.com/workflows/...",
      initialValue: config.teamsWebhookUrl || undefined,
      validate: (v) => {
        if (!v) return "Webhook URL is required";
        try {
          new URL(v);
        } catch {
          return "Must be a valid URL";
        }
      },
    }),
  );

  const secret = await askOrExit(
    p.text({
      message: "Webhook secret for inbound verification",
      placeholder: "optional — shared secret to verify incoming webhooks",
      initialValue: config.teamsWebhookSecret || "",
    }),
  );

  const port = await askOrExit(
    p.text({
      message: "Webhook receiver port",
      placeholder: "19878",
      initialValue: config.teamsWebhookPort
        ? String(config.teamsWebhookPort)
        : "19878",
      validate: (v) => {
        if (!v) return "Port is required";
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 1024 || n > 65535) return "Port must be 1024-65535";
      },
    }),
  );

  const botName = await askOrExit(
    p.text({
      message: "Bot display name in Teams (for echo loop prevention)",
      placeholder: "optional — e.g. 'Talon Bot'",
      initialValue: config.teamsBotDisplayName || "",
    }),
  );

  return {
    teamsWebhookUrl,
    teamsWebhookPort: parseInt(port, 10),
    ...(secret ? { teamsWebhookSecret: secret } : {}),
    ...(botName ? { teamsBotDisplayName: botName } : {}),
  };
}

type DiscordAnswers = Pick<
  SetupAnswers,
  "discordBotToken" | "discordApplicationId"
>;

async function askDiscord(config: Config): Promise<DiscordAnswers> {
  p.note(
    "Get bot token + application ID from\n" +
      "https://discord.com/developers/applications → your app → Bot",
    "Discord Setup",
  );

  const discordBotToken = await askOrExit(
    p.text({
      message: "Discord bot token",
      placeholder: "MTxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      initialValue: config.discord?.botToken || undefined,
      validate: (v) => {
        if (!v) return "Bot token is required";
      },
    }),
  );

  const discordApplicationId = await askOrExit(
    p.text({
      message: "Discord application ID",
      placeholder: "1234567890123456789",
      initialValue: config.discord?.applicationId || undefined,
      validate: (v) => {
        if (!v) return "Application ID is required";
      },
    }),
  );

  return { discordBotToken, discordApplicationId };
}

async function askWhatsApp(config: Config): Promise<Config["whatsapp"]> {
  p.note(
    "Talon drives a real WhatsApp account over Baileys multi-device —\n" +
      "the same mechanism as WhatsApp Web. On first start you'll pair it\n" +
      "under WhatsApp → Linked devices.",
    "WhatsApp Setup",
  );

  const pairing = await askOrExit(
    p.text({
      message: "The bot account's own number (E.164 digits, no +)",
      placeholder: "leave blank to pair by QR code instead",
      initialValue: config.whatsapp?.pairingNumber || "",
      validate: (v) => {
        if (v && !/^\d{7,15}$/.test(bareDigits(v)))
          return "Digits only, country code included — e.g. 353871234567";
      },
    }),
  );

  const allowed = await askOrExit(
    p.text({
      message: "Numbers allowed to DM the bot (comma-separated)",
      placeholder: "353871234567, 447700900000 — blank disables DMs",
      initialValue: (config.whatsapp?.allowedJids ?? []).join(", "),
    }),
  );

  const groupPolicy = await askOrExit(
    p.select<"listed" | "with-allowed-user" | "all">({
      message: "Which groups should the bot serve?",
      initialValue: config.whatsapp?.groupPolicy ?? "listed",
      options: [
        {
          value: "listed",
          label: `Listed only     ${pc.dim("— groups you name in allowedGroups")}`,
        },
        {
          value: "with-allowed-user",
          label: `Groups I'm in   ${pc.dim("— any group containing an allowed number")}`,
        },
        {
          value: "all",
          label: `All             ${pc.dim("— every group the account belongs to")}`,
        },
      ],
    }),
  );

  const pairingNumber = bareDigits(pairing);
  return {
    // Preserve allowedGroups / respondMode / sendReadReceipts — the
    // wizard doesn't prompt for them but must not drop them.
    ...config.whatsapp,
    allowedJids: parseNumberList(allowed),
    groupPolicy,
    ...(pairingNumber ? { pairingNumber } : {}),
  };
}

/** Discover models from the SDK; fall back to the static list if it isn't installed. */
async function discoverModels(config: Config) {
  const {
    registerClaudeModels,
    registerClaudeModelsStatic,
    CLAUDE_MODELS_STATIC,
  } = await import("../backend/claude-sdk/models/index.js");
  try {
    const { dirs } = await import("../util/paths.js");
    await registerClaudeModels({
      model: config.model,
      cwd: dirs.workspace,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...(config.claudeBinary
        ? { pathToClaudeCodeExecutable: config.claudeBinary }
        : {}),
    });
  } catch {
    // Setup wizard may run before Claude Code is installed — use static list
    registerClaudeModelsStatic(CLAUDE_MODELS_STATIC);
  }
  const { getModels } = await import("../core/models/catalog.js");
  return getModels();
}

async function askModel(config: Config): Promise<string> {
  const registeredModels = await discoverModels(config);
  return askOrExit(
    p.select({
      message: "Default model",
      initialValue: config.model,
      options: registeredModels.map((m) => ({
        value: m.id,
        label: `${m.displayName.padEnd(12)}${m.description ? pc.dim(`— ${m.description}`) : ""}`,
      })),
    }),
  );
}

/** Pulse only makes sense with a chat platform — terminal-only installs skip it. */
async function askPulse(
  config: Config,
  selectedFrontends: string[],
): Promise<boolean> {
  if (selectedFrontends.every((f) => f === "terminal")) return false;
  return askOrExit(
    p.confirm({
      message: "Enable pulse? (periodic group engagement)",
      initialValue: config.pulse,
    }),
  );
}

async function askBackend(config: Config): Promise<Config["backend"]> {
  return askOrExit(
    p.select({
      message: "AI backend",
      initialValue: config.backend ?? "claude",
      options: [
        {
          value: "claude",
          label: `Claude    ${pc.dim("— Anthropic Claude Agent SDK")}`,
        },
        {
          value: "kilo",
          label: `Kilo      ${pc.dim("— @kilocode/sdk (multi-provider routing)")}`,
        },
        {
          value: "opencode",
          label: `OpenCode  ${pc.dim("— @opencode-ai/sdk")}`,
        },
        {
          value: "codex",
          label: `Codex     ${pc.dim("— OpenAI Codex CLI (@openai/codex)")}`,
        },
        {
          value: "agy",
          label: `Antigravity ${pc.dim("— Google Antigravity CLI (agy, subscription OAuth)")}`,
        },
        {
          value: "openai-agents",
          label: `OpenAI Agents ${pc.dim("— @openai/agents (OpenAI or any OpenAI-compatible endpoint)")}`,
        },
      ],
    }),
  );
}

type BackendAnswers = Pick<
  SetupAnswers,
  | "claudeBinary"
  | "agyBinary"
  | "codexApiKey"
  | "openaiApiKey"
  | "openaiBaseUrl"
  | "openaiApiMode"
>;

async function askClaudeBackend(config: Config): Promise<BackendAnswers> {
  const claudeBinary = await askOrExit(
    p.text({
      message: "Claude Code binary path",
      placeholder: "leave empty for default (claude)",
      initialValue: config.claudeBinary || "",
    }),
  );
  return { claudeBinary: trimmedOrUndefined(claudeBinary) };
}

async function askCodexBackend(config: Config): Promise<BackendAnswers> {
  const codexApiKey = await askOrExit(
    p.text({
      message: "Codex OpenAI API key",
      placeholder:
        "leave empty to use CODEX_API_KEY / TALON_CODEX_KEY env or `codex login` auth",
      initialValue: config.codexApiKey || "",
    }),
  );
  return { codexApiKey: trimmedOrUndefined(codexApiKey) };
}

/**
 * Antigravity has no API key to collect — it authenticates through a
 * consumer Google OAuth flow run once interactively, cached under
 * `~/.gemini/antigravity-cli/`. All the wizard can usefully do is
 * point at the binary and say where the login happens.
 */
async function askAgyBackend(config: Config): Promise<BackendAnswers> {
  const binary = await askOrExit(
    p.text({
      message: "Antigravity CLI binary path",
      placeholder: "leave empty for default (agy on PATH)",
      initialValue: config.agyBinary || "",
    }),
  );
  const resolved = trimmedOrUndefined(binary);
  const probe = resolved || "agy";
  const installed = binaryOnPath(probe);
  if (!installed) {
    p.log.warn(
      `${pc.yellow("!")} \`${probe}\` not found — install the Antigravity CLI ` +
        `and make sure it is on PATH before starting Talon.`,
    );
  }
  const auth = detectAgyAuth();
  if (!auth.present) {
    p.log.warn(
      `${pc.yellow("!")} No cached Antigravity credentials. Run ${pc.cyan("agy")} ` +
        `once on this host and complete the Google sign-in; headless runs ` +
        `then reuse the cache. There is no API key for this backend.`,
    );
  } else {
    p.log.success(
      `Antigravity credentials found (${auth.method ?? "oauth"}) at ${auth.path}`,
    );
  }
  return { agyBinary: resolved };
}

async function askOpenAiAgentsBackend(config: Config): Promise<BackendAnswers> {
  const openaiApiKey = trimmedOrUndefined(
    await askOrExit(
      p.text({
        message:
          "API key (OpenAI, OpenRouter, Azure, or whatever your endpoint requires)",
        placeholder: "leave empty to use OPENAI_API_KEY env",
        initialValue: config.openaiApiKey || "",
      }),
    ),
  );

  const openaiBaseUrl = trimmedOrUndefined(
    await askOrExit(
      p.text({
        message:
          "Base URL " +
          pc.dim(
            "(leave empty for OpenAI direct; e.g. https://openrouter.ai/api/v1)",
          ),
        placeholder: "https://openrouter.ai/api/v1",
        initialValue: config.openaiBaseUrl || "",
      }),
    ),
  );
  if (!openaiBaseUrl) return { openaiApiKey, openaiBaseUrl };

  const openaiApiMode = await askOrExit(
    p.select<NonNullable<Config["openaiApiMode"]>>({
      message: "OpenAI API surface",
      options: [
        {
          value: "chat_completions",
          label: `Chat Completions ${pc.dim("— most third parties (OpenRouter, Ollama, LiteLLM, most Azure)")}`,
        },
        {
          value: "responses",
          label: `Responses ${pc.dim("— OpenAI native, requires proxy support")}`,
        },
      ],
      initialValue: config.openaiApiMode ?? "chat_completions",
    }),
  );
  return { openaiApiKey, openaiBaseUrl, openaiApiMode };
}

/**
 * kilo / opencode need no extra prompts — bundled SDK + per-provider creds
 * configured separately (kilo via `kilo login`, opencode via its own auth
 * flow).
 */
async function askBackendCredentials(
  config: Config,
  backend: Config["backend"],
): Promise<BackendAnswers> {
  switch (backend) {
    case "claude":
      return askClaudeBackend(config);
    case "codex":
      return askCodexBackend(config);
    case "agy":
      return askAgyBackend(config);
    case "openai-agents":
      return askOpenAiAgentsBackend(config);
    default:
      return {};
  }
}

// ── The wizard: the steps above, in order ──

export async function runSetup(): Promise<void> {
  printBanner();
  p.intro(pc.inverse(" Setup Wizard "));

  const config = loadConfig();
  const selectedFrontends = await askFrontends(config);
  const on = (id: string) => selectedFrontends.includes(id);

  const telegram = on("telegram") ? await askTelegram(config) : {};
  const teams = on("teams") ? await askTeams(config) : {};
  const discord = on("discord") ? await askDiscord(config) : {};
  const whatsapp = on("whatsapp") ? await askWhatsApp(config) : undefined;

  const model = await askModel(config);
  const pulse = await askPulse(config, selectedFrontends);
  const backend = await askBackend(config);
  const credentials = await askBackendCredentials(config, backend);

  const newConfig = buildSetupConfig(config, {
    selectedFrontends,
    backend,
    model,
    pulse,
    whatsapp,
    ...telegram,
    ...teams,
    ...discord,
    ...credentials,
  });

  const s = p.spinner();
  s.start("Saving configuration");
  saveConfig(newConfig);
  s.stop("Configuration saved");

  p.outro(`Run ${pc.cyan(pc.bold("talon start"))} to launch Talon`);

  if (on("telegram") && telegram.apiId && telegram.apiHash) {
    console.log(
      `  ${pc.yellow("!")} Run ${pc.cyan("npx tsx src/login.ts")} to authenticate the userbot first.\n`,
    );
  }
}

/** Everything the wizard's prompts collected, in one bag. */
export type SetupAnswers = {
  selectedFrontends: string[];
  backend: Config["backend"];
  botToken?: string;
  claudeBinary?: string;
  agyBinary?: string;
  codexApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiApiMode?: Config["openaiApiMode"];
  model: string;
  pulse: boolean;
  adminId?: string;
  apiId?: number;
  apiHash?: string;
  teamsWebhookUrl?: string;
  teamsWebhookSecret?: string;
  teamsWebhookPort?: number;
  teamsBotDisplayName?: string;
  discordBotToken?: string;
  discordApplicationId?: string;
  whatsapp?: Config["whatsapp"];
};

/**
 * Admin + DM allowlist for the saved config. With Telegram on, the admin id
 * is the one just entered, and an empty allowlist defaults to that admin —
 * a fresh bot answers its owner and no one else. With Telegram off, both are
 * left as they were (other surfaces read `adminUserId` too).
 */
function telegramAccess(
  existing: Config,
  answers: SetupAnswers,
  telegramOn: boolean,
): Pick<Config, "adminUserId" | "allowedUsers"> {
  const adminUserId = answers.adminId
    ? parseInt(answers.adminId, 10) || undefined
    : undefined;
  if (!telegramOn || adminUserId === undefined) {
    return {
      adminUserId: adminUserId ?? existing.adminUserId,
      allowedUsers: existing.allowedUsers,
    };
  }
  return {
    adminUserId,
    allowedUsers: existing.allowedUsers?.length
      ? existing.allowedUsers
      : [adminUserId],
  };
}

/**
 * Fold the wizard's answers onto the existing config.
 *
 * Extracted from `runSetup` so the merge is testable without driving the
 * prompts — the behaviour that matters here is what it *doesn't* touch.
 * The wizard models roughly half of ~/.talon/config.json. Spreading
 * `existing` first keeps every key it does not model (whatsapp, native,
 * memory, github, heartbeat/dream, allowlists, plugin blocks…) — building
 * from the named fields alone silently deletes them. Fields below still
 * override, and an explicit `undefined` still deletes, because
 * `saveConfig` strips undefined.
 */
export function buildSetupConfig(
  existing: Config,
  answers: SetupAnswers,
): Config {
  const on = (id: string) => answers.selectedFrontends.includes(id);
  /** Did the chosen backend's credential prompt actually run? */
  const ownsCredential = (backend: Config["backend"]) =>
    answers.backend === backend;
  return {
    ...existing,
    frontend:
      answers.selectedFrontends.length === 1
        ? answers.selectedFrontends[0]
        : answers.selectedFrontends,
    backend: answers.backend,
    botToken: on("telegram") ? answers.botToken : undefined,
    // Backend credentials: the wizard prompts for exactly one backend's
    // (an if/else-if chain on the chosen backend), so taking the answer
    // unconditionally deleted every other backend's — picking `claude`
    // wiped a stored openaiApiKey/openaiBaseUrl even though the account
    // stays reachable via enabledBackends and per-chat overrides. Each
    // credential is now overwritten only by the prompt that owns it, and
    // left alone otherwise. Blanking a shown prompt still clears it.
    claudeBinary: ownsCredential("claude")
      ? answers.claudeBinary
      : existing.claudeBinary,
    codexApiKey: ownsCredential("codex")
      ? answers.codexApiKey
      : existing.codexApiKey,
    agyBinary: ownsCredential("agy") ? answers.agyBinary : existing.agyBinary,
    openaiApiKey: ownsCredential("openai-agents")
      ? answers.openaiApiKey
      : existing.openaiApiKey,
    openaiBaseUrl: ownsCredential("openai-agents")
      ? answers.openaiBaseUrl
      : existing.openaiBaseUrl,
    openaiApiMode: ownsCredential("openai-agents")
      ? answers.openaiApiMode
      : existing.openaiApiMode,
    model: answers.model,
    concurrency: existing.concurrency,
    pulse: answers.pulse,
    pulseIntervalMs: existing.pulseIntervalMs,
    ...telegramAccess(existing, answers, on("telegram")),
    apiId: answers.apiId,
    apiHash: answers.apiHash,
    maxMessageLength: existing.maxMessageLength,
    plugins: existing.plugins,
    // Teams
    teamsWebhookUrl: on("teams") ? answers.teamsWebhookUrl : undefined,
    teamsWebhookSecret: on("teams") ? answers.teamsWebhookSecret : undefined,
    teamsWebhookPort: on("teams") ? answers.teamsWebhookPort : undefined,
    teamsBotDisplayName: on("teams") ? answers.teamsBotDisplayName : undefined,
    // Discord — bot token + applicationId. Allowlists / admin IDs /
    // mention vs channel-wide reply behaviour are left as defaults in
    // the wizard; advanced users hand-edit talon.json.
    discord:
      on("discord") && answers.discordBotToken && answers.discordApplicationId
        ? {
            ...existing.discord,
            botToken: answers.discordBotToken,
            applicationId: answers.discordApplicationId,
          }
        : existing.discord,
    // Never dropped. Deselecting WhatsApp shouldn't throw away its
    // pairing setup, and dropping it while `frontend` still lists
    // whatsapp produces a config core/config/index.ts refuses to load at all
    // ("WhatsApp frontend requires a whatsapp config block") — a daemon
    // that won't start. The `??` keeps that impossible even if the
    // branch that collects the answer is ever skipped.
    whatsapp: answers.whatsapp ?? existing.whatsapp,
  };
}
