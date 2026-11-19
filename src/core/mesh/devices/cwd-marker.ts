/**
 * Markers a teleported shell prints so the daemon can recover its working
 * directory. They are wrapper output and must never reach the chat, including
 * when the output is read later through device_exec_job.
 */

export const CWD_OPEN = "__TALON_CWD__";
export const CWD_CLOSE = "__TALON_CWD_END__";

export function stripCwdMarker(stdout: string): string {
  // The wrapper prints the marker last, so only a complete one at the very end
  // is ours. The same text anywhere else is the command's own output.
  if (!stdout.trimEnd().endsWith(CWD_CLOSE)) return stdout;
  const open = stdout.lastIndexOf(CWD_OPEN);
  return open === -1 ? stdout : stdout.slice(0, open);
}
