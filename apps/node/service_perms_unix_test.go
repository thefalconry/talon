//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRequireOwnedPathsAcceptsOwnFiles(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "talon-node")
	if err := os.WriteFile(bin, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := requireOwnedPaths(uint32(os.Getuid()), bin); err != nil {
		t.Fatalf("own binary refused: %v", err)
	}
}

func TestRequireOwnedPathsRefusesAnotherUsersFiles(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("running as root: every temp file is root-owned")
	}
	bin := filepath.Join(t.TempDir(), "talon-node")
	if err := os.WriteFile(bin, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	// As root (uid 0), a file owned by this unprivileged test user is
	// exactly what a root unit must not run.
	err := requireOwnedPaths(0, bin)
	if err == nil || !strings.Contains(err.Error(), "owned by uid") {
		t.Fatalf("expected an ownership refusal, got %v", err)
	}
}

func TestRequireOwnedPathsRefusesWorldWritableDirs(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "shared")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "talon-node")
	if err := os.WriteFile(bin, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	err := requireOwnedPaths(uint32(os.Getuid()), bin)
	if err == nil || !strings.Contains(err.Error(), "writable by every user") {
		t.Fatalf("expected a world-writable refusal, got %v", err)
	}
}

func TestRequireOwnedPathsAllowsStickyDirs(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sticky")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o777|os.ModeSticky); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "talon-node")
	if err := os.WriteFile(bin, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := requireOwnedPaths(uint32(os.Getuid()), bin); err != nil {
		t.Fatalf("sticky directory refused: %v", err)
	}
}

func TestRequireOwnedPathsIgnoresMissingPaths(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "not-yet", "config.json")
	if err := requireOwnedPaths(uint32(os.Getuid()), missing); err != nil {
		t.Fatalf("missing path refused: %v", err)
	}
}
