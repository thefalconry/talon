/**
 * Operator commands — `/metrics`, `/doctor`, `/dream`, `/restart`.
 *
 * Gated on the `operator` scope by the dispatcher (see definitions.ts).
 * `/restart` and `/dream` are the same actions the app's Settings screen
 * fires through `POST /control`, so a typed command and a tap take the
 * one code path.
 */

import { collectDoctorReport } from "../../../core/doctor/index.js";
import { getMetrics, getTodayMetrics } from "../../../storage/metrics.js";
import {
  renderDoctorReport,
  renderMetricsMessages,
} from "../../presentation/reports.js";
import { control } from "../surface/control.js";
import { NATIVE_REPORTS } from "./format.js";
import type { NativeCommandContext, NativeCommandHandler } from "./types.js";

async function metrics(ctx: NativeCommandContext): Promise<void> {
  const all = ctx.arg.toLowerCase() === "all";
  const parts = renderMetricsMessages(
    all ? getMetrics() : getTodayMetrics(),
    NATIVE_REPORTS,
    undefined,
    all ? "📊 Metrics — all time" : "📊 Metrics — today (UTC)",
  );
  ctx.reply(
    parts.join("\n\n") +
      (all ? "" : "\n\n`/metrics all` for the all-time view."),
  );
}

async function doctor(ctx: NativeCommandContext): Promise<void> {
  try {
    const report = await collectDoctorReport({
      config: ctx.runtime.config,
      hasConfigFile: true,
    });
    ctx.reply(renderDoctorReport(report, NATIVE_REPORTS));
  } catch (err) {
    ctx.reply(
      `🩺 Doctor failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function dream(ctx: NativeCommandContext): Promise<void> {
  const result = await control("dream");
  ctx.reply(result.ok ? `🌙 ${result.message}` : `⚠️ ${result.message}`);
}

async function restart(ctx: NativeCommandContext): Promise<void> {
  // Reply first: the restart takes this process down with it.
  ctx.reply("♻️ Restarting Talon — back online in a few seconds.");
  await control("restart");
}

export const adminCommands = {
  metrics,
  doctor,
  dream,
  restart,
} satisfies Record<string, NativeCommandHandler>;
