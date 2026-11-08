/**
 * Tool-surface trimming: every registered MCP tool costs context
 * tokens in EVERY session (name + description + schema). Deployments
 * that never use whole tool groups (stickers, polls, triggers, …) can
 * reclaim that budget via `disabledToolTags` / `disabledTools` in
 * talon.json.
 */

/** The slice of TalonConfig the tool exclusions care about. */
export type ToolExclusionConfig = {
  disabledTools?: readonly string[];
  disabledToolTags?: readonly string[];
};
