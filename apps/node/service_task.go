package main

import (
	"fmt"
	"strings"
)

// taskName is the Windows Scheduled Task that runs the node at boot.
const taskName = "TalonNode"

// systemSID is the well-known SID of NT AUTHORITY\SYSTEM (LocalSystem).
const systemSID = "S-1-5-18"

// taskCreateArgs builds the `schtasks /Create` arguments for the boot task.
//
// /RU <account> /NP: run as the installing user, storing no password. The
// task then runs non-interactively (an S4U logon) at boot — no console
// window, no logged-in session needed — with the user's own, unelevated
// rights. Never /RU SYSTEM: the binary and config live in the user's
// profile, so SYSTEM would run files the user can rewrite.
func taskCreateArgs(account, exe, configPath string) []string {
	return []string{
		"/Create", "/F",
		"/TN", taskName,
		"/SC", "ONSTART",
		"/RU", account,
		"/NP",
		"/TR", fmt.Sprintf(`"%s" run --config "%s"`, exe, configPath),
	}
}

// isSystemAccount reports whether a Windows account (SID + name, as
// os/user returns them) is LocalSystem.
func isSystemAccount(sid, name string) bool {
	if sid == systemSID {
		return true
	}
	n := strings.ToUpper(name)
	return n == `NT AUTHORITY\SYSTEM` || n == "SYSTEM"
}

// taskRunsAsSystem reads `schtasks /Query /V /FO LIST` output and reports
// whether the task is registered to run as SYSTEM.
func taskRunsAsSystem(query string) bool {
	for _, line := range strings.Split(query, "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(key) != "Run As User" {
			continue
		}
		return isSystemAccount("", strings.TrimSpace(value))
	}
	return false
}
