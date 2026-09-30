/**
 * `talon status` — render the running instance's health, or a stopped summary
 * pulled from the config file.
 */

import pc from "picocolors";
import { existsSync, readFileSync } from "node:fs";
import { findRunningInstance } from "../core/daemon/discovery.js";
import { files } from "../util/paths.js";
import { printBanner, loadConfig } from "./config.js";
import { CONFIG_FILE } from "./context.js";

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

type HealthAlert = { key: string; severity: string; message: string };

/** The daemon's active alerts from its /health body (older daemons: none). */
function healthAlerts(health: Record<string, unknown>): HealthAlert[] {
  const raw = health.alerts;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (a): a is HealthAlert =>
      typeof a === "object" &&
      a !== null &&
      typeof a.key === "string" &&
      typeof a.message === "string",
  );
}

/** One line per active alert, coloured by severity. Shared with doctor. */
export function formatAlertLines(health: Record<string, unknown>): string[] {
  return healthAlerts(health).map((a) => {
    const dot = a.severity === "warn" ? pc.yellow("●") : pc.red("●");
    return `  ${dot} ${pc.bold(a.key)}  ${a.message}`;
  });
}

/**
 * The native bridge's TLS certificate fingerprint, from its discovery file —
 * what a talon-node pins on first use, shown so an operator can compare the
 * two. Null when the bridge is off, serves plain http, or never ran.
 */
export function bridgeFingerprint(
  path: string = files.nativeBridge,
): string | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as {
      fingerprint?: unknown;
    };
    return typeof raw.fingerprint === "string" && raw.fingerprint
      ? raw.fingerprint
      : null;
  } catch {
    return null;
  }
}

export async function showStatus(): Promise<void> {
  printBanner();
  const instance = await findRunningInstance();

  if (instance?.health) {
    const h = instance.health;
    const ok = h.ok as boolean;
    console.log(
      `  ${ok ? pc.green("●") : pc.yellow("●")} ${pc.bold("Running")}  ${ok ? pc.green("healthy") : pc.yellow("degraded")}`,
    );
    console.log();
    console.log(`  ${pc.dim("PID")}          ${instance.pid}`);
    if (instance.port)
      console.log(`  ${pc.dim("Gateway")}      127.0.0.1:${instance.port}`);
    console.log(
      `  ${pc.dim("Uptime")}       ${formatUptime(h.uptime as number)}`,
    );
    console.log(`  ${pc.dim("Memory")}       ${h.memory} MB`);
    console.log(`  ${pc.dim("Sessions")}     ${h.sessions}`);
    console.log(`  ${pc.dim("Messages")}     ${h.messages}`);
    console.log(`  ${pc.dim("Queue")}        ${h.queue} pending`);
    console.log(`  ${pc.dim("Errors")}       ${h.errors}`);
    const fingerprint = bridgeFingerprint();
    if (fingerprint) console.log(`  ${pc.dim("Bridge TLS")}   ${fingerprint}`);
    console.log(`  ${pc.dim("Last active")}  ${h.lastActivity}\n`);
    const alerts = formatAlertLines(h);
    if (alerts.length > 0) {
      console.log(`  ${pc.bold("Active alerts")}\n`);
      for (const line of alerts) console.log(line);
      console.log();
    }
    return;
  }

  if (instance) {
    console.log(
      `  ${pc.yellow("●")} ${pc.bold("Running")}  (PID ${instance.pid}) ${pc.dim("— health endpoint not reachable, possibly still starting")}`,
    );
    console.log(`  Check ${pc.cyan("talon logs")} for details.\n`);
    return;
  }

  console.log(`  ${pc.red("●")} ${pc.bold("Stopped")}\n`);
  if (existsSync(CONFIG_FILE)) {
    const config = loadConfig();
    const fes = Array.isArray(config.frontend)
      ? config.frontend
      : [config.frontend];
    console.log(`  ${pc.dim("Frontend")} ${fes.join(", ")}`);
    if (fes.includes("telegram"))
      console.log(
        `  ${pc.dim("Token")}    ${config.botToken ? pc.green("configured") : pc.red("not set")}`,
      );
    if (fes.includes("teams"))
      console.log(
        `  ${pc.dim("Teams")}    ${config.teamsWebhookUrl ? pc.green("configured") : pc.red("not set")}`,
      );
    console.log(`  ${pc.dim("Model")}    ${config.model}`);
    console.log(`  ${pc.dim("Config")}   ${pc.dim(CONFIG_FILE)}\n`);
    console.log(
      `  Start with ${pc.cyan("talon start")} or ${pc.cyan("talon chat")}\n`,
    );
  } else {
    console.log(`  Run ${pc.cyan("talon setup")} to get started.\n`);
  }
}
