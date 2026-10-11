# Daemon watchdog

`talon start` runs Talon as a detached background daemon, and nothing
supervises it. A crash, an OOM kill or a reboot leaves Talon down until
someone notices. The watchdog fixes that: `talon watchdog` makes one check
and starts the daemon if it is down. Run it from a timer.

It is for installs that use `talon start`. If you run Talon under the
`talon run` systemd unit ([server-install.md](server-install.md#4-run-it-as-a-service)),
systemd is already the supervisor: don't add the watchdog as well.

## What it does, and what it never does

Each run:

1. If `talon stop` left a stop marker, it does nothing. The marker is
   cleared by the next `talon start` or `talon restart`, or by any daemon
   boot. Anything else that takes Talon down (a crash, SIGKILL, OOM, a
   reboot, a `/restart` that didn't come back) leaves no marker.
2. It looks for a daemon the way `talon start` does: an identity-checked
   `/health` answer, or a live pid in `~/.talon/talon.pid`. If it finds one,
   that's the end of it: booting, busy and even hung daemons are left alone.
3. If it finds none, it counts a miss. It starts Talon only after **3
   consecutive misses spanning at least 2 minutes**, which is longer than a
   `/restart` handoff (90 s, with its own watcher) and `talon start`'s boot
   wait. The start is `talon start`'s own code path, which checks again
   right before spawning.

It never kills, stops or restarts anything. It can't produce a second
daemon: on top of the checks above, runs are serialised by a lock file
(`~/.talon/data/watchdog.lock`), and the daemon itself refuses to boot
while another one is alive.

One exception to step 2: a pidfile written before the machine last booted
is ignored even if its pid is alive again, because after a reboot that
pid belongs to some other process.

When it does start Talon, the new daemon sends the usual crash alert
("Talon was found down … and the watchdog started it again"), unless the
old daemon left a more specific one.

Each run prints one line, so the unit's journal is the history:

```
watchdog: Talon is running (PID 947484)
watchdog: no daemon found (2 check(s), 60s); waiting before starting it
watchdog: Talon was down; started it (PID 951002, gateway :19876)
watchdog: Talon was stopped on purpose (talon stop, 2026-10-11T00:12:03.000Z); leaving it down until `talon start`
```

It exits 1 only when it tried to start Talon and couldn't.

## Install (systemd user timer)

As the user whose `~/.talon` it is, from a checkout or the installed
package:

```bash
mkdir -p ~/.config/systemd/user
cp packaging/systemd/talon-watchdog.service packaging/systemd/talon-watchdog.timer ~/.config/systemd/user/

# The daemon inherits the unit's environment, and a user unit's PATH is
# minimal. Give it your shell's PATH so it finds bun, claude, git, etc.
mkdir -p ~/.config/systemd/user/talon-watchdog.service.d
printf '[Service]\nEnvironment="PATH=%s"\n' "$PATH" \
  > ~/.config/systemd/user/talon-watchdog.service.d/path.conf

systemctl --user daemon-reload
systemctl --user enable --now talon-watchdog.timer
sudo loginctl enable-linger "$USER"   # run while you're logged out, and after a reboot
```

Check it:

```bash
systemctl --user list-timers talon-watchdog.timer
journalctl --user -u talon-watchdog.service -n 20
```

Talon reads its tokens and plugin secrets from `~/.talon/config.json`, not
from your shell, so PATH is the only variable that normally matters. If
you export anything else Talon relies on, add it to the same drop-in.

The service uses `KillMode=process`. Without it, systemd would kill the
daemon along with the rest of the unit's cgroup as soon as the check
exits. Because of this, the daemon a watchdog run started lives in that
unit's cgroup, and the journal shows "left-over process" notices on later
runs. They are harmless.

After a reboot the timer's first run is at 1 minute, so Talon is back about
3 to 4 minutes after boot.

To turn it off:

```bash
systemctl --user disable --now talon-watchdog.timer
```

## Without systemd

Any scheduler that runs `talon watchdog` about once a minute works, for
example cron (`crontab -e`):

```
* * * * * PATH=/home/you/.bun/bin:/usr/local/bin:/usr/bin:/bin talon watchdog >> ~/.talon/watchdog.log 2>&1
```

cron doesn't kill what its jobs leave behind, so nothing like
`KillMode=process` is needed.
