/**
 * `talon mesh` — per-device credentials from the outside.
 *
 *   talon mesh [list]                    every credential + devices still on
 *                                        the shared token
 *   talon mesh revoke <device|credId>    revoke now; live sessions drop
 *   talon mesh rotate <device>           the device swaps credentials on its
 *                                        next heartbeat (old one: 7-day grace)
 *   talon mesh scopes <device> <list>    e.g. device,client,operator
 *   talon mesh audit [--limit N] [--device X]
 *                                        commands the daemon sent to devices
 *                                        (core/mesh/audit.ts)
 *
 * Everything goes through the running daemon's loopback gateway
 * (core/engine/gateway-routes.ts → core/mesh/credentials/admin.ts): the
 * daemon owns the store and the live sessions a revocation must drop, so
 * editing the file behind its back could never take effect in time.
 */

import pc from "picocolors";
import { fetchGateway, requireGatewayPort } from "../daemon-api.js";
import type { DeviceCredential } from "../../core/mesh/credentials/index.js";
import { parseAuditArgs, runMeshAudit } from "./mesh-audit.js";

const USAGE = `
  ${pc.bold("talon mesh")} — per-device mesh credentials and command audit

    ${pc.cyan("list")}                              credentials, scopes, last use (default)
    ${pc.cyan("revoke")} <device|credential-id>     revoke now; drops its live sessions
    ${pc.cyan("rotate")} <device>                   re-issue on the device's next heartbeat
    ${pc.cyan("scopes")} <device> <scope,scope>     set scopes: device, client, operator
    ${pc.cyan("audit")} [--limit N] [--device X]    commands sent to devices (newest last)
`;

type Overview = {
  ok: boolean;
  error?: string;
  credentials?: DeviceCredential[];
  legacyDevices?: { deviceId: string; lastSeen: number }[];
  legacySharedToken?: boolean;
};

type AdminReply = { ok: boolean; text?: string; error?: string };

function ago(ts: number | undefined, now: number): string {
  if (ts === undefined) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172_800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

function stateOf(c: DeviceCredential, now: number): string {
  if (c.revokedAt !== undefined) return pc.dim(`revoked (${c.revokeReason})`);
  if (c.expiresAt !== undefined && now >= c.expiresAt) return pc.dim("expired");
  if (c.supersededBy) return pc.yellow(`superseded by ${c.supersededBy}`);
  if (c.rotateRequestedAt !== undefined) return pc.yellow("rotation pending");
  if (c.deviceId === null) return pc.yellow("unbound (awaiting first use)");
  return pc.green("active");
}

function renderOverview(o: Overview): void {
  const now = Date.now();
  const creds = o.credentials ?? [];
  console.log(`\n  ${pc.bold("Mesh credentials")}\n`);
  if (creds.length === 0) console.log(`  ${pc.dim("(none issued yet)")}`);
  for (const c of creds) {
    console.log(
      `  ${pc.cyan(c.id)}  ${c.deviceId ?? pc.dim("—")}  [${c.scopes.join(", ")}]  ${stateOf(c, now)}`,
    );
    console.log(
      pc.dim(
        `      via ${c.origin}, issued ${ago(c.createdAt, now)}, last used ${ago(c.lastUsedAt, now)}`,
      ),
    );
  }
  const legacy = o.legacyDevices ?? [];
  if (legacy.length > 0) {
    console.log(`\n  ${pc.yellow("Still on the shared native.token:")}`);
    for (const d of legacy) {
      console.log(`  ${d.deviceId}  ${pc.dim(`seen ${ago(d.lastSeen, now)}`)}`);
    }
  }
  console.log(
    `\n  Legacy shared token from remote clients: ${
      o.legacySharedToken ? pc.yellow("accepted") : pc.green("refused")
    }\n`,
  );
}

async function adminOp(
  port: number,
  body: Record<string, unknown>,
): Promise<void> {
  const reply = (await fetchGateway(port, "/mesh/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as AdminReply;
  if (reply.ok) {
    console.log(`\n  ${pc.green("✔")} ${reply.text}\n`);
  } else {
    console.error(`\n  ${pc.red("✖")} ${reply.error}\n`);
    process.exitCode = 1;
  }
}

async function runAudit(args: readonly string[]): Promise<void> {
  const query = parseAuditArgs(args);
  if (typeof query === "string") {
    console.error(`  ${pc.red("✖")} ${query}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const port = await requireGatewayPort();
  if (port === null) {
    process.exitCode = 1;
    return;
  }
  await runMeshAudit(port, query);
}

export async function runMeshCommand(args: string[]): Promise<void> {
  const [sub = "list", target, scopes] = args;
  if (sub === "help" || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return;
  }
  if (sub === "audit") return runAudit(args.slice(1));
  const known = ["list", "revoke", "rotate", "scopes"];
  if (!known.includes(sub)) {
    console.error(`  Unknown mesh command: ${sub}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (sub !== "list" && !target) {
    console.error(
      `  ${pc.red("✖")} talon mesh ${sub} needs a device.\n${USAGE}`,
    );
    process.exitCode = 1;
    return;
  }
  const port = await requireGatewayPort();
  if (port === null) {
    process.exitCode = 1;
    return;
  }
  if (sub === "list") {
    renderOverview((await fetchGateway(port, "/mesh/credentials")) as Overview);
    return;
  }
  await adminOp(port, { op: sub, device: target, scopes });
}
