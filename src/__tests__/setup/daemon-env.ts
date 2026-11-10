/**
 * Global test setup — drop an inherited daemon owner stamp.
 *
 * A running daemon stamps TALON_DAEMON_PID / TALON_DAEMON_STARTTIME into
 * its own environment (core/daemon/pidfile.ts → stampDaemonOwner), so every
 * process it spawns names it as owner. A test run launched from inside a
 * daemon — an agent's shell, run_preflight — inherits that stamp, and so does
 * every process a suite spawns. The orphan sweeps then see those test
 * processes as "another live daemon's children" and leave them alone, and a
 * suite that expects its stand-in orphan to be killed fails on that host only.
 *
 * Runs in the vitest main process before any worker starts; workers inherit
 * the scrubbed environment. Suites that need a stamp set one explicitly on
 * the child they spawn.
 */

// DAEMON_PID_ENV / DAEMON_STARTTIME_ENV in core/daemon/pidfile.ts. Spelled
// out rather than imported: pidfile.ts pulls in util/paths.ts, which resolves
// the home directory at import — before home-global.ts has swapped it.
const STAMP_VARS = ["TALON_DAEMON_PID", "TALON_DAEMON_STARTTIME"] as const;

export function setup(): () => void {
  const saved = STAMP_VARS.map((name) => [name, process.env[name]] as const);
  for (const [name] of saved) delete process.env[name];

  return () => {
    for (const [name, value] of saved) {
      if (value !== undefined) process.env[name] = value;
    }
  };
}
