//go:build !linux

package main

// hardenProcess is a no-op outside Linux: macOS relies on the hardened
// runtime (no get-task-allow), Windows on per-user process ACLs.
func hardenProcess() {}
