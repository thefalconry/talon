package main

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"strconv"
)

// launchdJob describes the launchd property list for the node. UserName and
// Home are set only for a LaunchDaemon: launchd starts those as root unless
// told otherwise, and gives them no HOME.
type launchdJob struct {
	Label    string
	Exe      string
	Config   string
	UserName string
	Home     string
}

func xmlEscaped(s string) string {
	var b bytes.Buffer
	// Writing to a bytes.Buffer cannot fail.
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// renderLaunchdPlist returns the property list. Values are escaped because a
// path may legally contain "&" or "<". KeepAlive gives the same
// restart-on-crash behaviour as the systemd unit.
func renderLaunchdPlist(job launchdJob) string {
	account := ""
	if job.UserName != "" {
		account = fmt.Sprintf(`  <key>UserName</key><string>%s</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>%s</string>
  </dict>
`, xmlEscaped(job.UserName), xmlEscaped(job.Home))
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
    <string>run</string>
    <string>--config</string>
    <string>%s</string>
  </array>
%s  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`, xmlEscaped(job.Label), xmlEscaped(job.Exe), xmlEscaped(job.Config), account)
}

// bootAccount picks the account a LaunchDaemon runs as: whoever ran sudo. The
// node never runs as root on macOS, so a root shell with no sudo caller, or
// sudo from root, is refused rather than falling back to root.
func bootAccount(sudoUser, sudoUID string) (string, uint32, error) {
	uid, err := strconv.ParseUint(sudoUID, 10, 32)
	if sudoUser == "" || err != nil {
		return "", 0, fmt.Errorf(
			"can't tell which account the node should run as: run " +
				"`sudo talon-node install --config <path>` from that account")
	}
	if uid == 0 || sudoUser == "root" {
		return "", 0, fmt.Errorf(
			"the node doesn't run as root on macOS: run " +
				"`sudo talon-node install --config <path>` from a normal account")
	}
	return sudoUser, uint32(uid), nil
}
