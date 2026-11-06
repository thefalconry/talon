//go:build !windows

package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

// watchReload restarts the node into the on-disk binary on SIGHUP — the
// reload primitive (`systemctl reload`, or after an out-of-band binary
// swap). Runs until ctx is done.
func watchReload(ctx context.Context, n *Node) {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGHUP)
	defer signal.Stop(ch)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ch:
			log.Printf("SIGHUP — reloading into on-disk binary")
			reexecInto(n)
		}
	}
}

// swapBinary replaces the running executable in place. On Unix a live
// process keeps its open inode, so a plain rename over the file is safe and
// atomic (same filesystem, guaranteed by staging next to the executable).
func swapBinary(staged, exe string) error {
	return os.Rename(staged, exe)
}

// reexecInto replaces the current process image with the freshly-installed
// binary via execve — same pid, no exit. systemd/launchd see a continuous
// process (no crash/restart accounting), and a cron watchdog sees the pid
// stay alive. All args and env carry over, so `run --config …` resumes.
//
// A short delay lets the heartbeat and result POST flush over the wire
// before the address space is swapped.
func reexecInto(_ *Node) {
	time.Sleep(750 * time.Millisecond)
	exe, err := os.Executable()
	if err != nil {
		log.Printf("update_node: re-exec aborted (no executable path): %v", err)
		return
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	log.Printf("update_node: restarting into %s", exe)
	// execve drops the job table, and a job left running would have nothing
	// to report it, kill it or enforce its lifetime limit.
	execJobs.killAll()
	if err := syscall.Exec(exe, os.Args, os.Environ()); err != nil {
		// If execve fails the process keeps running the OLD image; the
		// supervisor will pick up the new one on the next restart anyway.
		log.Printf("update_node: execve failed (%v); exiting to let the supervisor restart", err)
		os.Exit(0)
	}
}
