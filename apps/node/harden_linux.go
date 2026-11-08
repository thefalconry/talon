//go:build linux

package main

import (
	"log"
	"syscall"
)

const (
	prGetDumpable = 3
	prSetDumpable = 4
)

// hardenProcess marks the node non-dumpable: no core dumps, and other
// processes running as the same user can no longer ptrace it or read its
// memory through /proc — the one memory-protection step a Go process can
// take for the bearer token it holds. Commands the node runs are unaffected
// (dumpability resets on execve).
func hardenProcess() {
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetDumpable, 0, 0); errno != 0 {
		log.Printf("hardening: prctl(PR_SET_DUMPABLE, 0) failed: %v", errno)
	}
}

// processDumpable reports the current PR_GET_DUMPABLE value (for tests).
func processDumpable() (int, error) {
	v, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prGetDumpable, 0, 0)
	if errno != 0 {
		return 0, errno
	}
	return int(v), nil
}
