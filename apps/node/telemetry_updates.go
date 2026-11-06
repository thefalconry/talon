package main

import (
	"fmt"
	"os"
	"regexp"
	"strings"
)

// Files Debian and Ubuntu maintain for pending updates. Other distros have
// none of them, and then the status simply omits these keys: absent means
// "not known", never "up to date".
const (
	rebootRequiredFile = "/var/run/reboot-required"
	rebootPkgsFile     = "/var/run/reboot-required.pkgs"
	updatesNoticeFile  = "/var/lib/update-notifier/updates-available"
)

var updatesNoticeRE = regexp.MustCompile(`(?m)^\s*(\d+) updates? can be applied immediately`)

// parseUpdatesNotice returns the count in update-notifier's message. The
// "additional security updates" ESM line is not matched: those can't be
// applied without enabling ESM.
func parseUpdatesNotice(text string) (string, bool) {
	m := updatesNoticeRE.FindStringSubmatch(text)
	if m == nil {
		return "", false
	}
	return m[1], true
}

// pendingUpdateTelemetry reads the given files. update-notifier's count is
// as old as its last refresh, so it is a hint rather than a live apt query.
func pendingUpdateTelemetry(rebootFile, pkgsFile, noticeFile string) map[string]string {
	out := map[string]string{}
	if _, err := os.Stat(rebootFile); err == nil {
		out["rebootRequired"] = "true"
		if raw, err := os.ReadFile(pkgsFile); err == nil {
			if pkgs := strings.Fields(string(raw)); len(pkgs) > 0 {
				out["rebootRequiredBy"] = fmt.Sprintf("%d packages", len(pkgs))
			}
		}
	}
	if raw, err := os.ReadFile(noticeFile); err == nil {
		if n, ok := parseUpdatesNotice(string(raw)); ok {
			out["updatesAvailable"] = n
		}
	}
	return out
}
