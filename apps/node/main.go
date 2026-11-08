// talon-node — a headless Talon mesh device.
//
// A single static binary that attaches any server or VM to a Talon daemon's
// device mesh WITHOUT the full companion app. It speaks the same client
// bridge protocol the Flutter companion does — register + heartbeat over
// POST /devices/register, device_command events over the /events SSE stream,
// answers over POST /devices/command-result, and streamed file transfers via
// /devices/file — so the daemon (and every companion app) sees it as just
// another mesh device, and teleport works out of the box because it is built
// entirely on the exec/fs command surface implemented here.
//
// Design constraints (why Go, why one package):
//   - Zero runtime dependencies on the host: CGO_ENABLED=0 + stdlib only
//     yields a fully static binary for linux/macos/windows.
//   - Outbound-only networking: the node dials the bridge; nothing listens.
//   - TLS via certificate-fingerprint pinning (the bridge mints a
//     self-signed cert; clients pin its SHA-256, exactly like the app).
package main

import (
	"context"
	_ "embed"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

// talonVersion is the Talon release this node was compiled against, embedded
// from version.txt. That file carries the version plus an
// `x-release-please-version` annotation so release-please bumps it in lockstep
// with the root package.json on every release PR (CI also verifies the two
// match). It is the fallback identity so even a bare `go build .` reports the
// right Talon version rather than a placeholder.
//
//go:embed version.txt
var talonVersion string

// ldflagsVersion is stamped at build time via -ldflags "-X main.ldflagsVersion=…"
// with the full "<talon-version>+<sha>" string. Release/CI builds set it;
// ad-hoc builds leave it empty and fall back to the embedded Talon version.
var ldflagsVersion = ""

// version is the resolved identity reported over the mesh (appVersion). It
// always tracks the Talon version the binary was built from.
var version = resolveVersion()

func resolveVersion() string {
	if v := strings.TrimSpace(ldflagsVersion); v != "" {
		return v
	}
	// version.txt carries a trailing "# x-release-please-version" annotation;
	// take the first whitespace-delimited field so only the semver is reported.
	if fields := strings.Fields(talonVersion); len(fields) > 0 {
		return fields[0]
	}
	return "dev"
}

func usage() {
	fmt.Fprintf(os.Stderr, `talon-node %s — headless Talon mesh device

Usage:
  talon-node run        Connect to the bridge and serve mesh commands
  talon-node install    Install and start as a system service (systemd/launchd/sc)
  talon-node uninstall  Stop and remove the system service
  talon-node status     Show config, bridge reachability, service state, and
                        the last commands run here
  talon-node audit      Print the on-device command log (-n <count>, --json)
  talon-node permissions
                        macOS: open the Screen Recording and Accessibility
                        panes the computer capability needs
  talon-node version    Print the version

Flags (run/install/status):
  --config <path>       Config file (default: %s)
  --bridge <url>        Bridge base URL, e.g. https://host:19880
  --token <token>       Bridge bearer token (a per-device credential; a shared
                        token is swapped for one automatically on connect)
  --name <name>         Device name shown in the mesh (default: hostname)
  --fingerprint <hex>   Pinned bridge TLS certificate SHA-256 (TOFU when empty)
  --strict-tls          Refuse to connect without a configured fingerprint
                        (no trust-on-first-use; https only). Saved to the
                        config; --strict-tls=false turns it back off.

Config file fields mirror the flags; flags override the file. The first
successful TLS connect stores the bridge certificate fingerprint back into
the config (trust-on-first-use) and every later connect requires a match.
`, version, defaultConfigPath())
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	args := os.Args[1:]
	if len(args) == 0 {
		usage()
		os.Exit(2)
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "run":
		cfg := mustLoadConfig(rest)
		runNode(cfg)
	case "install":
		cfg := mustLoadConfig(rest)
		if err := serviceInstall(cfg); err != nil {
			log.Fatalf("install failed: %v", err)
		}
	case "uninstall":
		if err := serviceUninstall(); err != nil {
			log.Fatalf("uninstall failed: %v", err)
		}
	case "status":
		cfg := mustLoadConfig(rest)
		statusCmd(cfg)
	case "audit":
		auditCmd(rest)
	case "permissions":
		permissionsCmd()
	case "version", "--version", "-v":
		fmt.Println(version)
	case "help", "--help", "-h":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", cmd)
		usage()
		os.Exit(2)
	}
}

// tlsModeLabel describes the bridge trust mode for `talon-node status`.
func tlsModeLabel(strict bool) string {
	if strict {
		return "strict (a configured fingerprint is required)"
	}
	return "trust-on-first-use (default; --strict-tls requires a configured fingerprint)"
}

// runNode is the long-lived service loop: register, keep a heartbeat, and
// consume the SSE event stream, reconnecting forever with backoff. It only
// returns on SIGINT/SIGTERM.
func runNode(cfg *Config) {
	if err := cfg.Validate(); err != nil {
		log.Fatalf("config: %v", err)
	}
	hardenProcess()
	ctx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()

	node, err := NewNode(cfg)
	if err != nil {
		log.Fatalf("init: %v", err)
	}
	log.Printf(
		"talon-node %s starting — device %q (%s), bridge %s",
		version, cfg.Name, node.DeviceID, cfg.Bridge,
	)
	node.Run(ctx)
	log.Printf("talon-node stopped")
}

// statusCmd prints local config plus a live probe of the bridge /health
// endpoint — the quick "is this node wired up correctly?" check.
func statusCmd(cfg *Config) {
	fmt.Printf("talon-node %s\n", version)
	fmt.Printf("config:      %s\n", cfg.Path)
	fmt.Printf("bridge:      %s\n", cfg.Bridge)
	for _, ep := range cfg.Endpoints {
		if ep.Label != "" {
			fmt.Printf("fallback:    %s — %s\n", ep, ep.Label)
		} else {
			fmt.Printf("fallback:    %s\n", ep)
		}
	}
	fmt.Printf("device name: %s\n", cfg.Name)
	fmt.Printf("device id:   %s\n", cfg.DeviceID)
	switch {
	case cfg.Fingerprint != "":
		fmt.Printf("pinned cert: %s\n", cfg.Fingerprint)
	case cfg.StrictTLS:
		fmt.Printf("pinned cert: (none — strict TLS will refuse to connect)\n")
	default:
		fmt.Printf("pinned cert: (none — trust-on-first-use)\n")
	}
	fmt.Printf("tls mode:    %s\n", tlsModeLabel(cfg.StrictTLS))
	fmt.Printf("credential:  %s\n", credentialKind(cfg.Token))
	fmt.Printf("service:     %s\n", serviceState())
	printAuditTail(cfg.Path)
	if cfg.Bridge == "" {
		return
	}
	node, err := NewNode(cfg)
	if err != nil {
		fmt.Printf("bridge:      error: %v\n", err)
		return
	}
	health, err := node.Health()
	if err != nil {
		fmt.Printf("health:      unreachable: %v\n", err)
		return
	}
	fmt.Printf(
		"health:      ok — %s, protocol %v, auth required: %v\n",
		health["botName"], health["protocol"], health["authRequired"],
	)
}
