/**
 * `talon doctor` checks for one extra Claude account: its config dir, its
 * sign-in, and whether its `projects` resolves to the default account's
 * transcript store (without which a chat switched onto it starts over).
 * Read-only — the link itself is made when the backend starts.
 */

import { stat } from "node:fs/promises";
import type { DoctorCheck } from "../../../core/doctor/types.js";
import { inspectProjectsLink } from "../../../core/auth/claude-projects.js";
import {
  describeProviderStatus,
  readProviderStatus,
} from "../../../core/auth/status.js";
import {
  defaultClaudeConfigDir,
  type ClaudeAccountId,
} from "../../../core/config/claude-accounts.js";
import type { ClaudeRunAccount } from "./account.js";

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function signInHint(configDir: string): string {
  return `sign in with /auth, or run: CLAUDE_CONFIG_DIR=${configDir} claude auth login`;
}

export async function claudeAccountDoctorChecks(
  account: ClaudeRunAccount,
  isActive: boolean,
): Promise<DoctorCheck[]> {
  const configDir = account.configDir;
  const name = `Claude account ${account.backendId}`;
  if (!configDir) return [];
  if (!(await isDirectory(configDir))) {
    return [
      {
        label: `${name}: config dir missing`,
        status: "fail",
        detail: `${configDir} — ${signInHint(configDir)}`,
        issue: isActive,
      },
    ];
  }
  const checks: DoctorCheck[] = [];

  const status = await readProviderStatus(account.backendId as ClaudeAccountId);
  const usable = status.loggedIn && !status.expired;
  checks.push({
    label: `${name}: ${describeProviderStatus(status)}`,
    status: usable ? "ok" : "fail",
    ...(usable ? {} : { detail: signInHint(configDir) }),
    issue: !usable && isActive,
  });

  const link = await inspectProjectsLink(
    configDir,
    defaultClaudeConfigDir(),
  ).catch(() => undefined);
  if (!link) {
    checks.push({
      label: `${name}: could not inspect ${configDir}/projects`,
      status: "warn",
    });
  } else if (link.state === "linked") {
    checks.push({
      label: `${name}: sessions shared with the default account`,
      status: "ok",
    });
  } else if (link.state === "missing") {
    checks.push({
      label: `${name}: sessions link not created yet`,
      status: "info",
      detail: `${link.path} → ${link.target} is made when the backend starts`,
    });
  } else {
    checks.push({
      label: `${name}: sessions not shared with the default account`,
      status: "warn",
      detail:
        link.state === "separate"
          ? `${link.path} is a real directory; move its contents into ${link.target} and remove it`
          : `${link.path} links to ${link.pointsAt}, expected ${link.target}`,
      issue: isActive,
    });
  }
  return checks;
}
