/**
 * `talon doctor` checks for the Kimi backend: the binary, its
 * version, config / credentials, and whether the model catalog answers.
 */

import { execFileSync } from "node:child_process";
import type {
  DoctorCheck,
  DoctorConfigSlice,
} from "../../core/doctor/types.js";
import { binaryOnPath } from "../../util/binary-on-path.js";
import { KIMI_MIN_VERSION } from "./constants.js";
import { detectKimiAuth } from "./auth.js";
import { parseKimiModels } from "./models.js";

/** Resolve the binary the same way the runtime does: env, config, PATH. */
function resolveBinary(config: DoctorConfigSlice | undefined): string {
  const configured = (config as { kimiBinary?: string } | undefined)?.kimiBinary;
  return process.env.KIMI_BINARY || configured || "kimi";
}

function parseVersion(text: string): number[] {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return [];
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function versionAtLeast(found: number[], required: number[]): boolean {
  for (let i = 0; i < required.length; i++) {
    const a = found[i] ?? 0;
    const b = required[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

function run(binary: string, args: string[]): string {
  return execFileSync(binary, args, {
    encoding: "utf-8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
}

function versionCheck(binary: string): DoctorCheck {
  let output: string;
  try {
    output = run(binary, ["--version"]).trim();
  } catch (err) {
    return {
      label: "Kimi CLI version unreadable",
      status: "warn",
      detail: err instanceof Error ? err.message : String(err),
      issue: true,
    };
  }
  const found = parseVersion(output);
  const required = parseVersion(KIMI_MIN_VERSION);
  if (found.length === 0) {
    return {
      label: "Kimi CLI version unrecognised",
      status: "warn",
      detail: output,
      issue: true,
    };
  }
  if (!versionAtLeast(found, required)) {
    return {
      label: `Kimi CLI too old (${output})`,
      status: "fail",
      detail: `stream-json needs >= ${KIMI_MIN_VERSION}`,
    };
  }
  return { label: "Kimi CLI version", status: "ok", detail: output };
}

function authCheck(): DoctorCheck {
  const auth = detectKimiAuth();
  if (!auth.present) {
    return {
      label: "Kimi auth missing",
      status: "warn",
      detail: `${auth.problem ?? "no config file"} — run \`kimi provider add\` or \`kimi login\``,
      issue: true,
    };
  }
  const detail = `providers: ${auth.providers.join(", ")} (${auth.path})`;
  return { label: "Kimi auth", status: "ok", detail };
}

function modelsCheck(binary: string): DoctorCheck {
  try {
    const models = parseKimiModels(run(binary, ["provider", "list", "--json"]));
    if (models.length === 0) {
      return {
        label: "Kimi models empty",
        status: "warn",
        detail: "`kimi provider list --json` returned no models",
        issue: true,
      };
    }
    return {
      label: "Kimi models",
      status: "ok",
      detail: `${models.length} available (${models[0].id}…)`,
    };
  } catch (err) {
    return {
      label: "Kimi models unavailable",
      status: "warn",
      detail: err instanceof Error ? err.message : String(err),
      issue: true,
    };
  }
}

export async function kimiDoctorChecks(
  config: DoctorConfigSlice | undefined,
  isActive = true,
): Promise<DoctorCheck[]> {
  const binary = resolveBinary(config);
  const found =
    binary.includes("/") || binary.includes("\\") ? true : binaryOnPath(binary);
  if (!found) {
    return [
      {
        label: "Kimi CLI not found",
        status: "fail",
        detail:
          "install Kimi Code CLI (@moonshot-ai/kimi-code) and put `kimi` on PATH, or set `kimiBinary` / KIMI_BINARY",
      },
    ];
  }

  const checks: DoctorCheck[] = [
    { label: "Kimi CLI installed", status: "ok", detail: binary },
    versionCheck(binary),
    authCheck(),
  ];
  if (isActive) checks.push(modelsCheck(binary));
  return checks;
}
