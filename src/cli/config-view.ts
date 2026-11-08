/**
 * `talon config` — print the current configuration and offer to re-run setup.
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { printBanner, loadConfig, maskToken, type Config } from "./config.js";
import { CONFIG_FILE } from "./context.js";
import { runSetup } from "./setup.js";

function printProviderConfigs(config: Config): void {
  const backendLabel: Record<string, string> = {
    claude: "Anthropic Claude SDK",
    kilo: "Kilo (@kilocode/sdk)",
    opencode: "OpenCode (@opencode-ai/sdk)",
    codex: "OpenAI Codex CLI",
    agy: "Google Antigravity CLI",
    "openai-agents": "OpenAI Agents (@openai/agents)",
  };
  const label =
    backendLabel[config.backend ?? "claude"] ??
    `Anthropic Claude SDK (${config.backend})`;
  console.log(`  ${pc.dim("Backend")}          ${pc.green(label)}`);
  for (const account of config.claudeAccounts ?? [])
    console.log(
      `  ${pc.dim("Claude account")}   ${pc.green(account.id)} ${pc.dim(account.configDir)}`,
    );
  if (config.claudeBinary)
    console.log(
      `  ${pc.dim("Claude binary")}    ${pc.green(config.claudeBinary)}`,
    );
  if (config.agyBinary)
    console.log(
      `  ${pc.dim("Antigravity bin")}  ${pc.green(config.agyBinary)}`,
    );
  if (config.codexApiKey)
    console.log(
      `  ${pc.dim("Codex API key")}    ${maskToken(config.codexApiKey)}`,
    );
  if (config.openaiApiKey)
    console.log(
      `  ${pc.dim("OpenAI API key")}   ${maskToken(config.openaiApiKey)}`,
    );
  if (config.openaiBaseUrl)
    console.log(`  ${pc.dim("OpenAI base URL")}  ${config.openaiBaseUrl}`);
  if (config.openaiApiMode)
    console.log(`  ${pc.dim("OpenAI API mode")}  ${config.openaiApiMode}`);
  if (config.discord?.botToken)
    console.log(
      `  ${pc.dim("Discord bot")}      ${maskToken(config.discord.botToken)} (app ${config.discord.applicationId.slice(0, 6)}…)`,
    );
}

export async function viewConfig(): Promise<void> {
  printBanner();
  if (!existsSync(CONFIG_FILE)) {
    console.log(`  No config found. Running setup...\n`);
    await runSetup();
    return;
  }
  const config = loadConfig();
  p.intro(pc.inverse(" Configuration "));
  console.log();
  console.log(`  ${pc.dim("File")}             ${pc.dim(CONFIG_FILE)}`);
  const fes = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend];
  console.log(`  ${pc.dim("Frontend")}         ${fes.join(", ")}`);
  if (fes.includes("telegram")) {
    console.log(
      `  ${pc.dim("Bot token")}        ${maskToken(config.botToken)}`,
    );
    console.log(
      `  ${pc.dim("Admin")}            ${config.adminUserId || pc.dim("not set")}`,
    );
    console.log(
      `  ${pc.dim("Userbot")}          ${config.apiId ? pc.green("configured") : pc.dim("not set")}`,
    );
  }
  if (fes.includes("teams")) {
    console.log(
      `  ${pc.dim("Teams webhook")}    ${config.teamsWebhookUrl ? pc.green("configured") : pc.red("not set")}`,
    );
    console.log(
      `  ${pc.dim("Teams secret")}     ${config.teamsWebhookSecret ? pc.green("set") : pc.dim("not set")}`,
    );
    console.log(
      `  ${pc.dim("Teams port")}       ${config.teamsWebhookPort || 19878}`,
    );
    console.log(
      `  ${pc.dim("Teams bot name")}   ${config.teamsBotDisplayName || pc.dim("not set")}`,
    );
  }
  printProviderConfigs(config);
  console.log(`  ${pc.dim("Model")}            ${config.model}`);
  console.log(`  ${pc.dim("Concurrency")}      ${config.concurrency}`);
  console.log(
    `  ${pc.dim("Pulse")}            ${config.pulse ? pc.green("on") : pc.dim("off")} ${pc.dim(`(${Math.round(config.pulseIntervalMs / 60000)}m)`)}`,
  );
  if (config.plugins && config.plugins.length > 0)
    console.log(
      `  ${pc.dim("Plugins")}          ${config.plugins.length} loaded`,
    );
  console.log();
  const action = await p.select({
    message: "Action",
    options: [
      { value: "edit", label: "Edit", hint: "re-run setup wizard" },
      { value: "done", label: "Done" },
    ],
  });
  if (action === "edit") await runSetup();
}
