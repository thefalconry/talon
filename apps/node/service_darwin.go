//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	launchdLabel = "com.talon.node"
	daemonPlist  = "/Library/LaunchDaemons/" + launchdLabel + ".plist"
)

func agentPlistIn(home string) string {
	return filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist")
}

func plistPath() string {
	home, _ := os.UserHomeDir()
	return agentPlistIn(home)
}

func daemonInstalled() bool {
	_, err := os.Stat(daemonPlist)
	return err == nil
}

func resolvedPaths(cfg *Config) (exe, config string, err error) {
	if exe, err = os.Executable(); err != nil {
		return "", "", err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return "", "", err
	}
	if config, err = filepath.Abs(cfg.Path); err != nil {
		return "", "", err
	}
	return exe, config, nil
}

// serviceInstall writes a LaunchAgent for the current user, which starts at
// login. Run under sudo it writes a LaunchDaemon instead, which starts at boot
// but still runs as the account that ran sudo.
func serviceInstall(cfg *Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	if os.Geteuid() == 0 {
		return installDaemon(cfg)
	}
	if daemonInstalled() {
		return fmt.Errorf(
			"a LaunchDaemon is already installed (%s): run "+
				"`sudo talon-node uninstall` first, or two nodes would run", daemonPlist)
	}
	exe, config, err := resolvedPaths(cfg)
	if err != nil {
		return err
	}
	path := plistPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	doc := renderLaunchdPlist(launchdJob{Label: launchdLabel, Exe: exe, Config: config})
	if err := os.WriteFile(path, []byte(doc), 0o644); err != nil {
		return err
	}
	exec.Command("launchctl", "unload", path).Run() //nolint:errcheck
	if out, err := exec.Command("launchctl", "load", "-w", path).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl load: %v: %s", err, out)
	}
	fmt.Printf("Installed and started LaunchAgent %s (%s)\n", launchdLabel, path)
	fmt.Println("It starts at login. For start at boot, run: sudo talon-node install --config " + config)
	return nil
}

// installDaemon replaces the caller's LaunchAgent, if any, with a LaunchDaemon.
// Both use one device identity, so they must never run together. If the daemon
// fails to start, the agent is put back.
func installDaemon(cfg *Config) error {
	name, uid, err := bootAccount(os.Getenv("SUDO_USER"), os.Getenv("SUDO_UID"))
	if err != nil {
		return err
	}
	account, err := user.Lookup(name)
	if err != nil {
		return err
	}
	exe, config, err := resolvedPaths(cfg)
	if err != nil {
		return err
	}
	if err := requireOwnedPaths(uid, exe, config); err != nil {
		return err
	}
	if err := requireFileOwner(config, uid); err != nil {
		return err
	}
	doc := renderLaunchdPlist(launchdJob{
		Label: launchdLabel, Exe: exe, Config: config,
		UserName: name, Home: account.HomeDir,
	})
	if err := os.WriteFile(daemonPlist, []byte(doc), 0o644); err != nil {
		return err
	}
	if err := os.Chown(daemonPlist, 0, 0); err != nil {
		os.Remove(daemonPlist) //nolint:errcheck
		return err
	}

	domain := "gui/" + strconv.FormatUint(uint64(uid), 10)
	agent := agentPlistIn(account.HomeDir)
	_, statErr := os.Stat(agent)
	hadAgent := statErr == nil
	exec.Command("launchctl", "bootout", domain+"/"+launchdLabel).Run() //nolint:errcheck
	exec.Command("launchctl", "bootout", "system/"+launchdLabel).Run()  //nolint:errcheck
	exec.Command("launchctl", "enable", "system/"+launchdLabel).Run()   //nolint:errcheck
	if out, err := exec.Command("launchctl", "bootstrap", "system", daemonPlist).CombinedOutput(); err != nil {
		os.Remove(daemonPlist) //nolint:errcheck
		if hadAgent {
			exec.Command("launchctl", "bootstrap", domain, agent).Run() //nolint:errcheck
		}
		return fmt.Errorf("launchctl bootstrap: %v: %s", err, out)
	}
	if hadAgent {
		if err := os.Remove(agent); err != nil {
			fmt.Printf("warning: could not remove old LaunchAgent %s: %v\n", agent, err)
		}
	}
	fmt.Printf("Installed and started LaunchDaemon %s (%s), running as %s\n", launchdLabel, daemonPlist, name)
	fmt.Println("It starts at boot. Until someone logs in, the computer capability has no screen to use.")
	return nil
}

func serviceUninstall() error {
	if daemonInstalled() {
		if os.Geteuid() != 0 {
			return fmt.Errorf("a LaunchDaemon is installed (%s): run `sudo talon-node uninstall`", daemonPlist)
		}
		exec.Command("launchctl", "bootout", "system/"+launchdLabel).Run() //nolint:errcheck
		if err := os.Remove(daemonPlist); err != nil && !os.IsNotExist(err) {
			return err
		}
		fmt.Printf("Removed LaunchDaemon %s\n", launchdLabel)
		return nil
	}
	path := plistPath()
	exec.Command("launchctl", "unload", "-w", path).Run() //nolint:errcheck
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	fmt.Printf("Removed LaunchAgent %s\n", launchdLabel)
	return nil
}

func serviceState() string {
	if daemonInstalled() {
		return "installed (LaunchDaemon, starts at boot)"
	}
	out, err := exec.Command("launchctl", "list").Output()
	if err != nil {
		return "unknown"
	}
	if strings.Contains(string(out), launchdLabel) {
		return "loaded (LaunchAgent)"
	}
	return "not installed"
}
