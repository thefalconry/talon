//go:build windows

package main

import (
	"context"
	"log"
	"os"
	"os/exec"
	"time"
)

// watchReload is a no-op on Windows — there is no SIGHUP, and the
// rename-aside swap already takes effect on the next start.
func watchReload(_ context.Context, _ *Node) {}

// swapBinary replaces the running executable on Windows, where the live
// .exe is locked and cannot be renamed over directly. Windows DOES allow
// renaming a running image's own file aside, so move it to <exe>.old first,
// then move the new binary into place. The stale .old is best-effort
// cleaned on the next start (it may still be locked until this process
// exits during reexecInto).
func swapBinary(staged, exe string) error {
	old := exe + ".old"
	os.Remove(old) // clear any leftover from a prior update
	if err := os.Rename(exe, old); err != nil {
		return err
	}
	if err := os.Rename(staged, exe); err != nil {
		// Roll back so the node isn't left with no binary at exe.
		os.Rename(old, exe)
		return err
	}
	return nil
}

// reexecInto restarts into the new binary on Windows, where a running .exe
// cannot be execve'd in place. The binary was already swapped on disk (the
// old file was renamed aside during the rename-over), so here we launch a
// fresh detached copy and exit — the scheduled task's own restart is not
// relied upon, so the update takes effect immediately.
func reexecInto(_ *Node) {
	time.Sleep(750 * time.Millisecond)
	exe, err := os.Executable()
	if err != nil {
		log.Printf("update_node: restart aborted (no executable path): %v", err)
		return
	}
	// Re-run with the ORIGINAL args (run --config …), detached from this
	// process so our imminent exit doesn't take it down.
	args := []string{}
	if len(os.Args) > 1 {
		args = os.Args[1:]
	}
	// os.Exit skips Run's cleanup, and a job left running would have nothing
	// to report it, kill it or enforce its lifetime limit.
	execJobs.killAll()
	cmd := exec.Command(exe, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		log.Printf("update_node: could not launch new binary (%v); exiting for supervisor restart", err)
	} else {
		log.Printf("update_node: launched new binary (pid %d); exiting", cmd.Process.Pid)
	}
	os.Exit(0)
}
