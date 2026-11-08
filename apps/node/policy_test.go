package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestPolicyCapabilitiesFollowTheSwitches(t *testing.T) {
	if got := (Policy{}).capabilities(); !slices.Equal(got, allCapabilities()) {
		t.Fatalf("default policy must advertise everything, got %v", got)
	}
	got := Policy{DisableExec: true, DisableUpdate: true}.capabilities()
	if slices.Contains(got, "exec") || slices.Contains(got, "update_node") {
		t.Fatalf("disabled commands still advertised: %v", got)
	}
	if !slices.Contains(got, "read_file") {
		t.Fatalf("unrelated commands dropped: %v", got)
	}
}

func TestPolicyRefusesDisabledCommands(t *testing.T) {
	p := Policy{DisableExec: true, DisableUpdate: true}
	for _, name := range []string{"exec", "update_node"} {
		if err := p.check(name, map[string]any{}, nil); !errors.Is(err, errPolicy) {
			t.Errorf("%s: expected a policy refusal, got %v", name, err)
		}
	}
	if err := p.check("status", map[string]any{}, nil); err != nil {
		t.Errorf("status refused: %v", err)
	}
}

func TestPolicyConfinesPaths(t *testing.T) {
	root := t.TempDir()
	share := filepath.Join(root, "share")
	outside := filepath.Join(root, "outside")
	for _, d := range []string{share, outside} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	p := Policy{ReadPaths: []string{share}, WritePaths: []string{share}}

	ok := []struct {
		name   string
		params map[string]any
	}{
		{"read_file", map[string]any{"path": filepath.Join(share, "a.txt")}},
		{"write_file", map[string]any{"path": filepath.Join(share, "new", "b.txt")}},
		{"move", map[string]any{"from": filepath.Join(share, "a"), "to": filepath.Join(share, "b")}},
	}
	for _, c := range ok {
		if err := p.check(c.name, c.params, nil); err != nil {
			t.Errorf("%s %v refused: %v", c.name, c.params, err)
		}
	}

	refused := []struct {
		name   string
		params map[string]any
	}{
		{"read_file", map[string]any{"path": filepath.Join(outside, "a.txt")}},
		{"list_dir", map[string]any{"path": filepath.Join(share, "..", "outside")}},
		{"delete", map[string]any{"path": outside}},
		{"move", map[string]any{"from": filepath.Join(share, "a"), "to": filepath.Join(outside, "a")}},
		{"download_file", map[string]any{"path": filepath.Join(outside, "x")}},
	}
	for _, c := range refused {
		if err := p.check(c.name, c.params, nil); !errors.Is(err, errPolicy) {
			t.Errorf("%s %v: expected a policy refusal, got %v", c.name, c.params, err)
		}
	}
}

func TestPolicyFollowsSymlinksOutOfAllowedTrees(t *testing.T) {
	root := t.TempDir()
	share := filepath.Join(root, "share")
	secret := filepath.Join(root, "secret")
	for _, d := range []string{share, secret} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(secret, filepath.Join(share, "escape")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	p := Policy{WritePaths: []string{share}}
	err := p.check("write_file", map[string]any{"path": filepath.Join(share, "escape", "x")}, nil)
	if !errors.Is(err, errPolicy) {
		t.Fatalf("a symlink out of the allowed tree must be refused, got %v", err)
	}
}

func TestPolicyProtectsTheNodeItself(t *testing.T) {
	cfgDir := t.TempDir()
	cfg := &Config{Path: filepath.Join(cfgDir, "config.json")}
	n := &Node{cfg: cfg}
	protected := n.protectedPaths()

	p := Policy{}
	for _, c := range []struct {
		name   string
		params map[string]any
	}{
		{"write_file", map[string]any{"path": cfg.Path}},
		{"delete", map[string]any{"path": cfgDir}},
		{"move", map[string]any{"from": cfg.Path, "to": filepath.Join(t.TempDir(), "x")}},
		{"download_file", map[string]any{"path": filepath.Join(cfgDir, "bin", "talon-node")}},
	} {
		if err := p.check(c.name, c.params, protected); !errors.Is(err, errPolicy) {
			t.Errorf("%s %v: expected a refusal, got %v", c.name, c.params, err)
		}
	}
	// Reading it is a separate question (ReadPaths) — not refused here.
	if err := p.check("stat", map[string]any{"path": cfg.Path}, protected); err != nil {
		t.Errorf("stat of the config refused: %v", err)
	}
}

func TestPolicyCapsWrites(t *testing.T) {
	p := Policy{MaxWriteBytes: 10}
	small := base64.StdEncoding.EncodeToString([]byte("12345"))
	if err := p.check("write_file", map[string]any{"path": "/tmp/x", "base64": small}, nil); err != nil {
		t.Fatalf("a small write refused: %v", err)
	}
	err := p.check("write_file", map[string]any{
		"path": "/tmp/x", "base64": small, "offset": float64(8),
	}, nil)
	if !errors.Is(err, errPolicy) {
		t.Fatalf("a write past the cap must be refused, got %v", err)
	}

	var buf bytes.Buffer
	w := &limitWriter{w: &buf, max: 4}
	if _, err := w.Write([]byte("abc")); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("de")); !errors.Is(err, errPolicy) {
		t.Fatalf("limitWriter must refuse past its cap, got %v", err)
	}
	if buf.String() != "abc" {
		t.Fatalf("limitWriter wrote %q", buf.String())
	}
}

func TestDispatchAppliesThePolicy(t *testing.T) {
	n := &Node{cfg: &Config{Policy: Policy{DisableExec: true}}}
	res := dispatch(context.Background(), n, "exec", map[string]any{"cmd": "echo hi"})
	if res.OK || !strings.Contains(res.Message, "policy") {
		t.Fatalf("exec must be refused by policy, got %+v", res)
	}
}

func TestEnqueueCommandNeverBlocks(t *testing.T) {
	n := &Node{
		commands: make(chan map[string]any, 1),
		rejects:  make(chan map[string]any, 1),
	}
	for i := 0; i < 3; i++ {
		n.enqueueCommand(map[string]any{"id": "cmd"})
	}
	if len(n.commands) != 1 || len(n.rejects) != 1 {
		t.Fatalf("queue=%d rejects=%d, want 1/1 (third dropped)", len(n.commands), len(n.rejects))
	}
}
