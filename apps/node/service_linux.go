//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const unitName = "talon-node.service"

// serviceInstall writes a systemd unit pointing at the CURRENT binary and
// config, then enables + starts it. Root installs a system unit; a normal
// user gets a user unit (which needs `loginctl enable-linger` to survive
// logout — surfaced in the output rather than silently assumed).
func serviceInstall(cfg *Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return err
	}
	system := os.Geteuid() == 0
	if system {
		// A system unit runs as root: its binary and config must not be
		// replaceable by any other user (e.g. TALON_NODE_DIR pointed at a
		// user-writable directory).
		if err := requireOwnedPaths(0, exe, cfg.Path); err != nil {
			return err
		}
	}
	unitPath, ctl := unitLocation(system)
	unit := fmt.Sprintf(`[Unit]
Description=Talon headless mesh node
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%s run --config %s
Restart=always
RestartSec=5

[Install]
WantedBy=%s
`, exe, cfg.Path, map[bool]string{true: "multi-user.target", false: "default.target"}[system])

	if err := os.MkdirAll(filepath.Dir(unitPath), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(unitPath, []byte(unit), 0o644); err != nil {
		return err
	}
	for _, args := range [][]string{
		append(ctl, "daemon-reload"),
		append(ctl, "enable", "--now", unitName),
	} {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			return fmt.Errorf("%s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	fmt.Printf("Installed and started %s (%s)\n", unitName, unitPath)
	if !system {
		fmt.Println(
			"Note: user unit — run `loginctl enable-linger` so it survives logout/boot.",
		)
	}
	return nil
}

func serviceUninstall() error {
	system := os.Geteuid() == 0
	unitPath, ctl := unitLocation(system)
	exec.Command(ctl[0], append(ctl[1:], "disable", "--now", unitName)...).Run() //nolint:errcheck
	if err := os.Remove(unitPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	exec.Command(ctl[0], append(ctl[1:], "daemon-reload")...).Run() //nolint:errcheck
	fmt.Printf("Removed %s\n", unitName)
	return nil
}

func serviceState() string {
	for _, ctl := range [][]string{
		{"systemctl"},
		{"systemctl", "--user"},
	} {
		out, err := exec.Command(
			ctl[0], append(ctl[1:], "is-active", unitName)...,
		).Output()
		state := strings.TrimSpace(string(out))
		if err == nil || state == "activating" || state == "failed" {
			scope := "system"
			if len(ctl) > 1 {
				scope = "user"
			}
			return fmt.Sprintf("%s (%s unit)", state, scope)
		}
	}
	return "not installed"
}

func unitLocation(system bool) (unitPath string, ctl []string) {
	if system {
		return "/etc/systemd/system/" + unitName, []string{"systemctl"}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "systemd", "user", unitName),
		[]string{"systemctl", "--user"}
}
