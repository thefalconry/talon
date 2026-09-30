/**
 * Classified errors for the fetch ladder (see core/errors.ts). A rung that
 * throws one of these is recorded as a "network" outcome and the ladder
 * climbs on; setup failures (no binary, bad digest) are "unknown".
 */

import { TalonError } from "../errors.js";

export function fetchError(
  message: string,
  reason: "network" | "unknown" = "network",
): TalonError {
  return new TalonError(message, { reason, retryable: false });
}
