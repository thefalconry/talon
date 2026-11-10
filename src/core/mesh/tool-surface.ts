/**
 * The mesh's model-facing tool surface — the vocabulary every mesh tool
 * answers in: the result shape, the timeout a single device filesystem
 * command runs under, and the formatters those answer texts are written
 * with.
 *
 * All three concerns speak it (devices/service.ts, links/bridge-links.ts,
 * transfers/device-files.ts), so it sits at the component root.
 */

/** The model-facing shape every mesh tool answers with. */
export type MeshToolResult = {
  ok: boolean;
  text: string;
  /** A picture for the model to look at (a device screenshot). */
  image?: { data: string; mimeType: string };
};

/** Timeout for a single filesystem command (list/stat/one chunk/etc.). */
export const FS_COMMAND_TIMEOUT_MS = 30_000;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function age(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.round(min / 60);
  return `${hrs}h ago`;
}

/** Trim a string path param, returning undefined when blank. */
export function requirePath(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
