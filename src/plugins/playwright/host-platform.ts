/**
 * Host-platform override for Ubuntu releases the bundled playwright-core
 * does not know.
 *
 * playwright-core maps the host to a platform key and looks browser builds
 * up by it. For an Ubuntu release newer than its table it returns
 * `ubuntu<version>`, which has no builds, so `install` exits 1 at once and
 * a launch finds no executable. Its own escape hatch is
 * PLAYWRIGHT_HOST_PLATFORM_OVERRIDE; this picks the newest Ubuntu key the
 * bundled version does know, whose builds run on the newer release.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const HOST_PLATFORM_OVERRIDE_ENV = "PLAYWRIGHT_HOST_PLATFORM_OVERRIDE";

/** Distributions playwright-core treats as Ubuntu. */
const UBUNTU_LIKE = new Set(["ubuntu", "pop", "neon", "tuxedo"]);
/** Newest Ubuntu key in the bundled playwright-core's platform table. */
const NEWEST_KNOWN_UBUNTU = "24.04";

export interface HostPlatformDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: Record<string, string | undefined>;
  /** Contents of /etc/os-release (default: read from disk). */
  osRelease?: string;
  /** Whether the bundled playwright-core has builds for an Ubuntu version. */
  knowsUbuntu?: (version: string) => boolean;
}

function readOsRelease(): string {
  try {
    return readFileSync("/etc/os-release", "utf-8");
  } catch {
    return "";
  }
}

function osReleaseField(text: string, key: string): string {
  const line = text.split("\n").find((l) => l.startsWith(`${key}=`));
  return line
    ? line
        .slice(key.length + 1)
        .trim()
        .replace(/^"|"$/g, "")
    : "";
}

/** playwright-core lists every Linux platform it has builds for in nativeDeps. */
function bundledKnowsUbuntu(cliPath: string, version: string): boolean {
  try {
    const deps = readFileSync(
      join(dirname(cliPath), "lib/server/registry/nativeDeps.js"),
      "utf-8",
    );
    return deps.includes(`"ubuntu${version}-`);
  } catch {
    return false;
  }
}

/**
 * The platform key to force, or undefined when playwright-core's own
 * detection is right: not Linux, not Ubuntu-like, a release it knows, an
 * older release, or the operator already set the override.
 */
export function hostPlatformOverride(
  cliPath: string,
  deps: HostPlatformDeps = {},
): string | undefined {
  if ((deps.platform ?? process.platform) !== "linux") return undefined;
  if ((deps.env ?? process.env)[HOST_PLATFORM_OVERRIDE_ENV]) return undefined;
  const text = deps.osRelease ?? readOsRelease();
  if (!UBUNTU_LIKE.has(osReleaseField(text, "ID"))) return undefined;
  const version = osReleaseField(text, "VERSION_ID");
  const major = Number.parseInt(version, 10);
  if (!Number.isFinite(major) || major <= 24) return undefined;
  const knows =
    deps.knowsUbuntu ?? ((v: string) => bundledKnowsUbuntu(cliPath, v));
  if (knows(version)) return undefined;
  const suffix = (deps.arch ?? process.arch) === "arm64" ? "-arm64" : "-x64";
  return `ubuntu${NEWEST_KNOWN_UBUNTU}${suffix}`;
}
