/**
 * `talon doctor` — environment + native-module checks, plus whether the bot
 * is currently running.
 */

import pc from "picocolors";
import { existsSync } from "node:fs";
import { findRunningInstance } from "../core/daemon/discovery.js";
import { formatAlertLines } from "./status.js";
import { printBanner, loadConfig } from "./config.js";
import { CONFIG_FILE } from "./context.js";

const DOCTOR_ICONS: Record<string, string> = {
  ok: pc.green("✓"),
  warn: pc.yellow("!"),
  fail: pc.red("✗"),
  info: pc.dim("-"),
};

export async function runDoctor(): Promise<void> {
  printBanner();
  console.log(`  ${pc.bold("Environment check")}\n`);
  const { collectDoctorReport } = await import("../core/doctor/index.js");
  // Doctor composes each backend's own checks off the registry, and the
  // CLI runs standalone — nothing else has registered them yet.
  const { loadBuiltinBackends } = await import("../backend/builtins.js");
  const hasConfigFile = existsSync(CONFIG_FILE);
  const config = hasConfigFile ? loadConfig() : undefined;
  // Extra Claude accounts are backends too, registered from the config.
  await loadBuiltinBackends(config);
  const report = await collectDoctorReport({ config, hasConfigFile });
  const print = (check: (typeof report.checks)[number]): void => {
    const detail = check.detail ? ` ${pc.dim(`(${check.detail})`)}` : "";
    console.log(`  ${DOCTOR_ICONS[check.status]} ${check.label}${detail}`);
  };
  for (const check of report.checks.filter((c) => !c.inactive)) print(check);

  // Configured-but-idle backends describe what a switch would run into,
  // not the state of the running deployment.
  const idle = report.checks.filter((c) => c.inactive);
  if (idle.length > 0) {
    console.log(`\n  ${pc.bold("Other backends")}\n`);
    for (const check of idle) print(check);
    console.log();
  }
  // Native plane, one line per embedded module with provenance.
  for (const mod of report.native) {
    const size = mod.sizeBytes
      ? ` · ${(mod.sizeBytes / 1024).toFixed(1)} KB`
      : "";
    const note = mod.note ? ` ${pc.dim(`(${mod.note})`)}` : "";
    console.log(
      `  ${mod.ok ? pc.green("✓") : pc.red("✗")} Native: ${mod.name} ${pc.dim(`${mod.language} → ${mod.target}${size}`)}${note}`,
    );
  }
  const instance = await findRunningInstance();
  if (instance) {
    console.log(`  ${pc.green("✓")} Bot is running (PID ${instance.pid})`);
    for (const line of formatAlertLines(instance.health ?? {}))
      console.log(line);
  } else {
    console.log(`  ${pc.dim("-")} Bot is not running`);
  }
  console.log(
    report.issues === 0
      ? `\n  ${pc.green("All checks passed.")}\n`
      : `\n  ${pc.yellow(`${report.issues} issue(s) found.`)}\n`,
  );
}
