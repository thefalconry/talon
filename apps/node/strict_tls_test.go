package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// tlsBridge is an https bridge that accepts registrations; it returns the
// server and its leaf certificate fingerprint.
func tlsBridge(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	t.Cleanup(srv.Close)
	sum := sha256.Sum256(srv.Certificate().Raw)
	return srv, hex.EncodeToString(sum[:])
}

func registerOnce(t *testing.T, n *Node) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return n.Register(ctx)
}

func TestDefaultModeStillAdoptsOnFirstUse(t *testing.T) {
	srv, fp := tlsBridge(t)
	n := testNode(t, srv.URL, "test-token", filepath.Join(t.TempDir(), "config.json"))
	if err := registerOnce(t, n); err != nil {
		t.Fatal(err)
	}
	if n.pinnedFingerprint() != fp {
		t.Fatalf("TOFU pinned %q, want %q", n.pinnedFingerprint(), fp)
	}
}

func TestStrictTLSRefusesAnUnpinnedBridge(t *testing.T) {
	srv, _ := tlsBridge(t)
	path := filepath.Join(t.TempDir(), "config.json")
	n := testNode(t, srv.URL, "test-token", path)
	n.cfg.StrictTLS = true
	err := registerOnce(t, n)
	if err == nil || !strings.Contains(err.Error(), "strict TLS") {
		t.Fatalf("register err = %v, want a strict TLS refusal", err)
	}
	n.maybeAdoptFingerprint()
	if n.pinnedFingerprint() != "" {
		t.Fatal("strict mode adopted a fingerprint")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("strict refusal wrote the config (err %v)", err)
	}
}

func TestStrictTLSConnectsWithTheRightPinOnly(t *testing.T) {
	srv, fp := tlsBridge(t)
	n := testNode(t, srv.URL, "test-token", filepath.Join(t.TempDir(), "config.json"))
	n.cfg.StrictTLS = true
	n.cfg.Fingerprint = fp
	if err := registerOnce(t, n); err != nil {
		t.Fatalf("strict node with the right pin: %v", err)
	}
	// A fresh node, so the check runs on a new handshake (not a reused
	// keep-alive connection).
	wrong := testNode(t, srv.URL, "test-token", filepath.Join(t.TempDir(), "config.json"))
	wrong.cfg.StrictTLS = true
	wrong.cfg.Fingerprint = strings.Repeat("0", 64)
	if err := registerOnce(t, wrong); err == nil || !strings.Contains(err.Error(), "mismatch") {
		t.Fatalf("wrong pin err = %v", err)
	}
}

func TestValidateStrictTLS(t *testing.T) {
	base := Config{Bridge: "https://host:19880", Token: "t"}
	cases := []struct {
		name    string
		mutate  func(*Config)
		wantErr string
	}{
		{"default without a pin", func(*Config) {}, ""},
		{"default over http", func(c *Config) { c.Bridge = "http://host:19880" }, ""},
		{"strict without a pin", func(c *Config) { c.StrictTLS = true }, "no bridge fingerprint"},
		{"strict over http", func(c *Config) {
			c.StrictTLS = true
			c.Bridge = "http://host:19880"
			c.Fingerprint = strings.Repeat("a", 64)
		}, "not https"},
		{"strict with a pin", func(c *Config) {
			c.StrictTLS = true
			c.Fingerprint = strings.Repeat("a", 64)
		}, ""},
	}
	for _, tc := range cases {
		c := base
		tc.mutate(&c)
		err := c.Validate()
		switch {
		case tc.wantErr == "" && err != nil:
			t.Errorf("%s: unexpected error %v", tc.name, err)
		case tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)):
			t.Errorf("%s: err = %v, want %q", tc.name, err, tc.wantErr)
		}
	}
	strict := base
	strict.StrictTLS = true
	if !errors.Is(strict.Validate(), errStrictNoPin) {
		t.Error("strict without a pin should be errStrictNoPin")
	}
}

func TestStrictTLSFlagIsPersisted(t *testing.T) {
	for _, env := range []string{"TALON_BRIDGE", "TALON_TOKEN", "TALON_NODE_NAME"} {
		t.Setenv(env, "")
	}
	path := filepath.Join(t.TempDir(), "config.json")
	read := func() Config {
		t.Helper()
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var c Config
		if err := json.Unmarshal(raw, &c); err != nil {
			t.Fatal(err)
		}
		return c
	}

	cfg := mustLoadConfig([]string{"--config", path, "--strict-tls", "--fingerprint", "AA:BB"})
	if !cfg.StrictTLS || !read().StrictTLS || read().Fingerprint != "aabb" {
		t.Fatalf("--strict-tls not persisted: %+v", read())
	}
	// Not passing the flag leaves the saved mode alone.
	if cfg := mustLoadConfig([]string{"--config", path}); !cfg.StrictTLS {
		t.Fatal("strict mode lost when the flag was omitted")
	}
	if cfg := mustLoadConfig([]string{"--config", path, "--strict-tls=false"}); cfg.StrictTLS || read().StrictTLS {
		t.Fatal("--strict-tls=false did not turn strict mode off")
	}
}

func TestTLSModeLabel(t *testing.T) {
	if !strings.HasPrefix(tlsModeLabel(true), "strict") {
		t.Error(tlsModeLabel(true))
	}
	if !strings.HasPrefix(tlsModeLabel(false), "trust-on-first-use") {
		t.Error(tlsModeLabel(false))
	}
}
