/**
 * Kimi reasoning-effort mapping.
 *
 * Kimi Code CLI (as of v2.0.2) does not expose a command-line flag (such as
 * `--effort`) to control reasoning or thinking effort on prompt turns.
 * While some models in `~/.kimi-code/config.toml` declare `support_efforts`,
 * there is no CLI option to set or override the effort level per turn.
 *
 * Therefore, effort mapping is an explicit no-op that returns undefined rather
 * than silently ignoring a parameter or failing with an unrecognised CLI flag.
 */

import type { ReasoningEffortLevel } from "../../core/types.js";

export type KimiEffort = string;

export function toKimiEffort(
  level: ReasoningEffortLevel | undefined,
): KimiEffort | undefined {
  if (!level) return undefined;
  // Explicit no-op: Kimi CLI does not support an --effort argument on `kimi -p`.
  return undefined;
}
