//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"strings"
)

// serviceInstall registers a Scheduled Task that starts the node at boot as
// the INSTALLING user, never as SYSTEM. The binary (%LOCALAPPDATA%) and the
// config (%APPDATA%) live in that user's profile, which the user can write;
// a task running them as SYSTEM handed SYSTEM to anything that runs as the
// user. Running as the user matches the Unix user-unit model: teleport gets
// exactly the rights of whoever installed the node.
//
// A scheduled task (unlike an SCM service) runs a plain console binary
// without service-control plumbing. Creating a boot-triggered task needs an
// elevated prompt; the task itself then runs unelevated (see taskCreateArgs).
func serviceInstall(cfg *Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	account, err := taskAccount()
	if err != nil {
		return err
	}
	out, err := exec.Command(
		"schtasks", taskCreateArgs(account, exe, cfg.Path)...,
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf("schtasks create: %v: %s", err, out)
	}
	if out, err := exec.Command(
		"schtasks", "/Run", "/TN", taskName,
	).CombinedOutput(); err != nil {
		return fmt.Errorf("schtasks run: %v: %s", err, out)
	}
	fmt.Printf("Installed and started scheduled task %s (runs as %s)\n", taskName, account)
	return nil
}

// taskAccount is the account the task runs as: whoever is installing. An
// install from a SYSTEM context (a remote-management agent, psexec -s) is
// refused rather than silently recreating the SYSTEM task.
func taskAccount() (string, error) {
	u, err := user.Current()
	if err != nil {
		return "", fmt.Errorf("resolve the current user: %w", err)
	}
	if isSystemAccount(u.Uid, u.Username) {
		return "", fmt.Errorf(
			"refusing to register the task as SYSTEM: run `talon-node install` " +
				"from the account the node should run as",
		)
	}
	return u.Username, nil
}

func serviceUninstall() error {
	exec.Command("schtasks", "/End", "/TN", taskName).Run() //nolint:errcheck
	out, err := exec.Command(
		"schtasks", "/Delete", "/F", "/TN", taskName,
	).CombinedOutput()
	if err != nil && !strings.Contains(string(out), "ERROR: The system cannot find") {
		return fmt.Errorf("schtasks delete: %v: %s", err, out)
	}
	fmt.Printf("Removed scheduled task %s\n", taskName)
	return nil
}

func serviceState() string {
	out, err := exec.Command(
		"schtasks", "/Query", "/TN", taskName, "/V", "/FO", "LIST",
	).CombinedOutput()
	if err != nil {
		return "not installed"
	}
	state := "installed (scheduled task)"
	if strings.Contains(string(out), "Running") {
		state = "running (scheduled task)"
	}
	// Tasks registered by older builds run as SYSTEM from a user-writable
	// binary; say so until the task is re-registered.
	if taskRunsAsSystem(string(out)) {
		state += " — runs as SYSTEM from a user-writable location; " +
			"re-run `talon-node install` to run it as your user"
	}
	return state
}
