package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type authFixture struct {
	CredentialPattern  string                     `json:"credentialPattern"`
	SampleCredentials  []string                   `json:"sampleCredentials"`
	SampleSharedTokens []string                   `json:"sampleSharedTokens"`
	UpgradeRequests    map[string]map[string]any  `json:"upgradeRequests"`
	UpgradeReplies     map[string]json.RawMessage `json:"upgradeReplies"`
	RegisterReplies    map[string]json.RawMessage `json:"registerReplies"`
}

func loadAuthFixture(t *testing.T) authFixture {
	t.Helper()
	var fx authFixture
	loadFixture(t, "auth_v1.json", &fx)
	return fx
}

func TestCredentialPatternMatchesFixture(t *testing.T) {
	fx := loadAuthFixture(t)
	if fx.CredentialPattern != deviceCredentialRE.String() {
		t.Fatalf("pattern drift: fixture %q, node %q", fx.CredentialPattern, deviceCredentialRE.String())
	}
	for _, tok := range fx.SampleCredentials {
		if !isDeviceCredential(tok) {
			t.Errorf("%q should be a device credential", tok)
		}
	}
	for _, tok := range fx.SampleSharedTokens {
		if isDeviceCredential(tok) {
			t.Errorf("%q should not be a device credential", tok)
		}
	}
}

func TestUpgradeRequestBodyMatchesFixture(t *testing.T) {
	fx := loadAuthFixture(t)
	want := map[string]any{}
	for k, v := range fx.UpgradeRequests["node"] {
		if v == "{{DEVICE_ID}}" {
			v = "node-abc"
		}
		want[k] = v
	}
	// Round-trip through JSON so types compare as the wire sees them.
	raw, _ := json.Marshal(upgradeRequestBody("node-abc"))
	var got map[string]any
	_ = json.Unmarshal(raw, &got)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("upgrade request drift:\n fixture: %v\n    node: %v", want, got)
	}
}

func TestParseUpgradeReplyFixture(t *testing.T) {
	fx := loadAuthFixture(t)
	up, err := parseUpgradeReply(fx.UpgradeReplies["node"], "dev_node01")
	if err != nil {
		t.Fatalf("fixture reply rejected: %v", err)
	}
	if up.CredentialID != "0123456789abcdef" || !reflect.DeepEqual(up.Scopes, []string{"device"}) {
		t.Fatalf("parsed %+v", up)
	}
	if _, err := parseUpgradeReply(fx.UpgradeReplies["node"], "someone-else"); err == nil {
		t.Fatal("a credential for another device must be refused")
	}
	if _, err := parseUpgradeReply([]byte(`{"ok":true,"token":"hunter2","deviceId":"dev_node01"}`), "dev_node01"); err == nil {
		t.Fatal("a malformed credential must be refused")
	}
	if _, err := parseUpgradeReply([]byte(`{"ok":false,"error":"nope"}`), "dev_node01"); err == nil {
		t.Fatal("ok:false must be an error")
	}
}

func TestRegisterReplyActionsFixture(t *testing.T) {
	fx := loadAuthFixture(t)
	shared, device := fx.SampleSharedTokens[0], fx.SampleCredentials[0]
	cases := []struct {
		reply, token, want string
	}{
		{"none", shared, ""},
		{"upgrade", shared, "upgrade"},
		{"upgrade", device, ""},
		{"rotate", device, "rotate"},
		{"rotate", shared, ""},
		{"forwardCompat", shared, ""},
		{"forwardCompat", device, ""},
	}
	for _, c := range cases {
		var r registerReply
		if err := json.Unmarshal(fx.RegisterReplies[c.reply], &r); err != nil {
			t.Fatalf("%s: %v", c.reply, err)
		}
		if got := r.credentialAction(c.token); got != c.want {
			t.Errorf("%s with %q: action %q, want %q", c.reply, c.token[:6], got, c.want)
		}
	}
}

// fakeBridge serves /devices/register (hinting an upgrade to shared-token
// callers) and /auth/upgrade, recording the bearer of every request.
type fakeBridge struct {
	mu       sync.Mutex
	shared   string
	minted   string
	bearers  []string
	upgrades int
	notFound bool
}

func (f *fakeBridge) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bearer := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		defer f.mu.Unlock()
		f.bearers = append(f.bearers, r.URL.Path+" "+bearer)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/devices/register":
			reply := map[string]any{"ok": true, "deviceId": "node-abc"}
			if bearer == f.shared {
				reply["credential"] = map[string]any{"action": "upgrade"}
			}
			_ = json.NewEncoder(w).Encode(reply)
		case "/auth/upgrade":
			f.upgrades++
			if f.notFound {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"ok":false,"error":"Per-device credentials are not enabled on this bridge"}`))
				return
			}
			var req map[string]any
			_ = json.Unmarshal(body, &req)
			if bearer != f.shared || req["deviceId"] != "node-abc" || req["client"] != "node" {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":           true,
				"token":        f.minted,
				"credentialId": "0123456789abcdef",
				"deviceId":     "node-abc",
				"scopes":       []string{"device"},
			})
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
	})
}

func testNode(t *testing.T, bridgeURL, token, configPath string) *Node {
	t.Helper()
	cfg := &Config{Bridge: bridgeURL, Token: token, Name: "rack", DeviceID: "node-abc", Path: configPath}
	n, err := NewNode(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestNodeUpgradesSharedTokenInBand(t *testing.T) {
	fx := loadAuthFixture(t)
	fb := &fakeBridge{shared: "shared-secret", minted: fx.SampleCredentials[0]}
	srv := httptest.NewServer(fb.handler(t))
	defer srv.Close()
	path := filepath.Join(t.TempDir(), "config.json")
	n := testNode(t, srv.URL, "shared-secret", path)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := n.Register(ctx); err != nil {
		t.Fatal(err)
	}
	if n.token() != fb.minted {
		t.Fatalf("node still on %q after upgrade", n.token())
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var saved Config
	_ = json.Unmarshal(raw, &saved)
	if saved.Token != fb.minted {
		t.Fatalf("config holds %q, want the per-device credential", saved.Token)
	}
	// The next heartbeat authenticates with the new credential and is not
	// asked to upgrade again.
	if err := n.Register(ctx); err != nil {
		t.Fatal(err)
	}
	fb.mu.Lock()
	defer fb.mu.Unlock()
	last := fb.bearers[len(fb.bearers)-1]
	if last != "/devices/register "+fb.minted {
		t.Fatalf("last request %q", last)
	}
	if fb.upgrades != 1 {
		t.Fatalf("%d upgrade requests, want 1", fb.upgrades)
	}
}

func TestNodeKeepsTokenWhenConfigCannotBeWritten(t *testing.T) {
	fx := loadAuthFixture(t)
	fb := &fakeBridge{shared: "shared-secret", minted: fx.SampleCredentials[0]}
	srv := httptest.NewServer(fb.handler(t))
	defer srv.Close()
	// A config path under a regular file can never be created.
	blocker := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(blocker, []byte("x"), 0o600)
	n := testNode(t, srv.URL, "shared-secret", filepath.Join(blocker, "config.json"))

	ctx := context.Background()
	_ = n.Register(ctx)
	if n.token() != "shared-secret" {
		t.Fatal("a credential that could not be persisted must not be adopted")
	}
	_ = n.Register(ctx)
	fb.mu.Lock()
	defer fb.mu.Unlock()
	if fb.upgrades != 1 {
		t.Fatalf("%d upgrade attempts, want 1 (disabled after the failed persist)", fb.upgrades)
	}
}

func TestNodeStopsAskingWhenDaemonHasNoCredentials(t *testing.T) {
	fb := &fakeBridge{shared: "shared-secret", notFound: true}
	srv := httptest.NewServer(fb.handler(t))
	defer srv.Close()
	n := testNode(t, srv.URL, "shared-secret", filepath.Join(t.TempDir(), "c.json"))
	ctx := context.Background()
	_ = n.Register(ctx)
	_ = n.Register(ctx)
	fb.mu.Lock()
	defer fb.mu.Unlock()
	if fb.upgrades != 1 || n.token() != "shared-secret" {
		t.Fatalf("upgrades=%d token=%q", fb.upgrades, n.token())
	}
}
