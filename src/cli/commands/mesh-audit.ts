/**
 * `talon mesh audit [--limit N] [--device X]` — the daemon's record of
 * every command it sent to a mesh device (core/mesh/audit.ts), read
 * through the loopback gateway. Arguments were never recorded, only their
 * hash; the short form here is its first 12 hex characters.
 */

import pc from "picocolors";
import { fetchGateway } from "../daemon-api.js";
import type { MeshAuditEntry } from "../../core/mesh/audit.js";

type AuditQuery = { limit?: number; device?: string };

/** Parse `--limit N` / `--device X` (either `--flag value` or `--flag=value`). */
export function parseAuditArgs(args: readonly string[]): AuditQuery | string {
  const query: AuditQuery = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (flag !== "--limit" && flag !== "--device") {
      return `Unknown option: ${arg}`;
    }
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || value === "") return `${flag} needs a value`;
    if (flag === "--device") {
      query.device = value;
      continue;
    }
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1) {
      return `--limit must be a positive integer, got "${value}"`;
    }
    query.limit = limit;
  }
  return query;
}

function issuerText(entry: MeshAuditEntry): string {
  const i = entry.issuer;
  if (!i) return pc.dim("no turn");
  return [
    i.source && i.source !== "message" ? i.source : null,
    i.sender ? `by ${i.sender}` : null,
    `chat ${i.chatId}`,
    i.turnId,
  ]
    .filter(Boolean)
    .join(" · ");
}

function renderEntry(entry: MeshAuditEntry): void {
  const mark = entry.ok ? pc.green("✔") : pc.red("✖");
  console.log(
    `  ${pc.dim(entry.time)}  ${mark} ${pc.cyan(entry.command)} → ${entry.deviceName} ${pc.dim(`(${entry.deviceId})`)}  ${entry.durationMs}ms`,
  );
  console.log(
    pc.dim(
      `      ${issuerText(entry)} · args ${entry.argsHash.slice(0, 12)}` +
        (entry.error ? ` · ${entry.error}` : ""),
    ),
  );
}

export async function runMeshAudit(
  port: number,
  query: AuditQuery,
): Promise<void> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.device) params.set("device", query.device);
  const qs = params.size > 0 ? `?${params.toString()}` : "";
  const reply = (await fetchGateway(port, `/mesh/audit${qs}`)) as {
    ok: boolean;
    entries?: MeshAuditEntry[];
    error?: string;
  };
  if (!reply.ok) {
    console.error(`\n  ${pc.red("✖")} ${reply.error}\n`);
    process.exitCode = 1;
    return;
  }
  const entries = reply.entries ?? [];
  console.log(`\n  ${pc.bold("Mesh command audit")}\n`);
  if (entries.length === 0)
    console.log(`  ${pc.dim("(no commands recorded)")}`);
  for (const entry of entries) renderEntry(entry);
  console.log("");
}
