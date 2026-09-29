# Companion root access (Android)

With **Settings → Mesh → Elevated access** on (the default; turn it off there,
or opt into **Ask again for each pairing** to have every new pairing start
without it), device control (teleport) runs at the **highest privilege the
device will give it**, picked per command. The mesh also warms the root grant
when it starts, so a device that reboots often (a car head unit) has root
before the first command arrives. With it off, everything runs at the `app`
tier:

| Tier | uid | How it's reached | What it adds |
| --- | --- | --- | --- |
| `root` | 0 | `su`, an already-root process, the adb agent, or a Shizuku server started as root | Everything: `/data`, other apps' data, `pm`, `settings`, `service call` |
| `system` | 1000 | The APK built into a ROM, platform-signed, with `sharedUserId=android.uid.system` | Most system state; still SELinux-confined to `system_app` |
| `shizuku` | 2000 | The [Shizuku](https://shizuku.rikka.app/) app (see [companion-shizuku.md](companion-shizuku.md)) | Shell/ADB reach without rooting |
| `app` | 10xxx | Always | The app's own storage, plus shared storage with All-files access |

The tier in force is reported in the mesh `status` payload as `execPrivilege`
(with `execVia` naming the mechanism), and shown in the app under
**Settings → Mesh → Device control**. Every `exec` result carries `via`, and a
root result also carries `rootMethod` (`su` / `agent` / `uid0`), so a command's
reply says what it actually ran as.

## Which path to use

**If the bootloader is unlocked, flash Magisk and stop reading.** It is a
one-time job, root then survives every reboot, and Talon needs no setup at all:
the first elevated command takes the grant and keeps it. This is the only
sensible answer for a device that power-cycles constantly — a car head unit
comes up with the ignition, and anything that needs a laptop plugged in per
boot is not a solution there.

The adb agent below is a **workbench tool**: it dies at reboot by design (it is
just a shell process). Use it to try things on a userdebug device you have on a
desk, not as the standing arrangement for an embedded unit.

Talon warms the ladder when the mesh starts rather than on the first command,
so on a device that reboots often the grant is taken at boot instead of a root
dialog appearing mid-drive with a command stuck behind it.

## Two things that are commonly assumed and are not true

**Installing the APK as a system app does not grant root.** Dropping an APK in
`/system/app` or `/system/priv-app` sets `FLAG_SYSTEM` and makes the app
eligible for privileged permissions — it does not change its uid. To actually
run as uid 1000 the build needs *both* `android:sharedUserId="android.uid.system"`
in its manifest *and* a signature from the ROM's platform key. That is a ROM
build, not an install (see [Building a system-uid APK](#building-a-system-uid-apk)).

**`adb root` on a userdebug device does not give the app root either.** It
restarts `adbd` as uid 0, so *the developer* has root over adb. AOSP's `su`
(`system/extras/su`) refuses every caller except uid 0 and uid 2000/shell — so
neither an ordinary app nor even a system-uid app can call it. Something
started from outside has to hold the privilege and hand it over. Two supported
ways to do that are below.

## 1. `su` (Magisk, KernelSU, APatch, or a permissive ROM)

Nothing to set up in Talon. The first elevated command (or **Request root** in
settings) spawns `su`, the root manager prompts once, and the grant sticks
across reboots.

With an unlocked bootloader this is the whole job: patch the device's
`boot.img` with the Magisk app, `fastboot flash boot magisk_patched.img`, then
open Talon and press **Request root**. Many aftermarket Android head units also
ship with `su` already present, in which case even that is unnecessary — press
the button and see what the tier row says.

In Magisk, set Talon's superuser grant to **Allow** (and leave the timeout at
"forever"); a prompt that nobody is there to tap is what turns a rooted device
back into an app-uid one.

`RootShell` keeps **one long-lived su shell for the whole process** rather than
running `su -c <cmd>` per command: one grant prompt instead of one per command,
each later command costing a pipe write instead of a process spawn, and a
denial remembered so a burst of mesh commands can't re-prompt in a loop. The
same shell serves both Flutter engines (the activity's and the foreground
service's) because they share one OS process.

Commands are framed in that shared pipe with a random end-of-command marker
echoed on **both** streams, carrying the exit status on stdout. The command
itself runs as `sh -c` in a group with **stdin closed**, so a program that
reads stdin can't eat the framing out of the pipe and desynchronise every
later command. A timeout tears the shell down rather than reusing a pipe whose
state is unknown.

`su --mount-master` is tried before plain `su` so a Magisk shell sees the
global mount namespace — otherwise `/sdcard` and other per-app mounts differ
from what the daemon expects.

## 2. The adb-root agent (userdebug / eng, no usable `su`)

This is the path for an AOSP `userdebug` build: `adb root` works, but no `su`
will serve an app uid. **It does not survive a reboot** — the agent is a shell
process, and only a root adb session can start another one. Fine on a desk,
wrong for anything embedded; flash Magisk instead (§1).

In the app: **Settings → Mesh → Device control → Root via adb**. It writes the
agent script and shows the one-liner to run from a computer:

```sh
adb root && adb shell "setsid sh /data/user/0/org.talon.companion/files/rootd/agent.sh >/dev/null 2>&1 </dev/null &"
```

The agent is ~20 lines of `/system/bin/sh` and toybox — no binary to build, no
extra app. It runs as uid 0 until the phone reboots and polls a spool
directory:

```
files/rootd/agent.sh              the loop
files/rootd/alive                 touched every tick — the liveness heartbeat
files/rootd/q/<id>.cmd            a request
files/rootd/q/<id>.{out,err,code,done}   the reply
```

Design notes worth keeping:

- **The spool lives in Talon's private storage, and that is the access
  control.** Only uid 0 and this app can enter that directory, so no other app
  can queue work for a root shell. Do not move it somewhere world-writable.
- A request is written to `<id>.tmp` and **renamed** into place, because rename
  is atomic — a plain write would let the agent pick up a half-written command.
- The agent `chmod 0666`s its replies: root creates them inside the app's own
  directory, where the app would otherwise not be able to read its own results.
- Each command runs in a subshell with stdin closed, so a `cd` can't leak into
  the next request and an interactive program can't stall the loop.
- The heartbeat is what the app trusts. A stale `alive` file (>15s) means the
  agent is gone — after a reboot, run the one-liner again.

Stop it with the `stop` file (the bridge's `stopAgent`), or just reboot.

## 3. Shizuku started as root

If Shizuku's own server was started while `adbd` was root, the server runs at
uid 0 and **every command through the Shizuku bridge is already a root
command**. Talon reads `Shizuku.getUid()` and reports the real tier (`root`,
`execVia: shizuku`) rather than calling it shell privilege.

```sh
adb root && adb shell sh /storage/emulated/0/Android/data/moe.shizuku.privileged.api/start.sh
```

## Building a system-uid APK

For a ROM you build yourself, `system` (uid 1000) is a real tier and needs no
runtime setup. It requires all three:

1. `android:sharedUserId="android.uid.system"` on `<manifest>`.
2. Signing with that ROM's `platform` key (`build/target/product/security/platform.{x509.pem,pk8}`).
3. The APK installed to `/system/priv-app/` (or bundled into the image).

This is **not** the shipped build: `sharedUserId` changes the app's identity, so
a device that already has the normal APK must uninstall it first, and an APK
signed with a platform key can't be installed over a Play-signed one. Talon
detects uid 1000 at runtime and reports it, so a ROM build works without any
code change — but the tier still runs commands through the ordinary app-uid
shell, because at uid 1000 `sh -c` already *is* the elevated shell.

Being in `/system/priv-app` without the platform signature gets you privileged
*permissions* (if whitelisted in `privapp-permissions`) and nothing else — not
uid 1000, and not root.

## Diagnosing

Dart's `developer.log` doesn't reach logcat in release builds, so the native
side logs every decision itself:

```sh
adb logcat -s TalonRoot     # root tier: su probes, agent, exec failures
adb logcat -s TalonShizuku  # the Shizuku tier
```

The mesh `status` payload also carries `execPrivilege`, `execVia`, `root` and
`shizuku` — enough to tell "no root on this device" from "root broke mid-command"
without touching adb. A command that fell back to the app uid says why in its
own `stderr`.

## Order and failure handling

`exec` tries root, then Shizuku, then the app uid. Probes are cached for 30s
(and a dead-end `su` probe is remembered natively for 60s) so a stock phone
with no root isn't re-probing on every command. If a root path fails *during* a
command, that tier is demoted for 30s and the command is retried down the
ladder — so one broken agent doesn't cost every later command an elevation
attempt, and a restarted agent heals without restarting the app.
