package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// meshBridge is a fake pinned bridge: register, /events (an open SSE
// stream), /health. It records what reached it.
type meshBridge struct {
	srv *httptest.Server
	fp  string

	mu        sync.Mutex
	sni       []string
	hosts     []string
	registers int
	streams   int
	requests  int
	// reply is the register reply body ("" = {"ok":true,"deviceId":...}).
	reply string
	// status, when non-zero, answers every request with it.
	status atomic.Int32

	streamOpened chan struct{}
}

func (b *meshBridge) handler(w http.ResponseWriter, r *http.Request) {
	b.mu.Lock()
	b.requests++
	b.hosts = append(b.hosts, r.Host)
	reply := b.reply
	b.mu.Unlock()
	if code := b.status.Load(); code != 0 {
		w.WriteHeader(int(code))
		_, _ = io.WriteString(w, `{"ok":false}`)
		return
	}
	switch r.URL.Path {
	case "/devices/register":
		b.mu.Lock()
		b.registers++
		b.mu.Unlock()
		if reply == "" {
			reply = `{"ok":true,"deviceId":"node-abc"}`
		}
		_, _ = io.WriteString(w, reply)
	case "/health":
		_, _ = io.WriteString(w, `{"app":"talon-bridge","protocol":1}`)
	case "/events":
		b.mu.Lock()
		b.streams++
		b.mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, ": ping\n\n")
		w.(http.Flusher).Flush()
		select {
		case b.streamOpened <- struct{}{}:
		default:
		}
		<-r.Context().Done()
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (b *meshBridge) count(f func() int) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return f()
}

// newMeshBridge starts a fake bridge. cert nil = httptest's built-in
// certificate, which every such bridge shares — like the bridge and the
// Caddy proxy in front of it, which present the same leaf.
func newMeshBridge(t *testing.T, cert *tls.Certificate) *meshBridge {
	t.Helper()
	b := &meshBridge{streamOpened: make(chan struct{}, 4)}
	b.srv = httptest.NewUnstartedServer(http.HandlerFunc(b.handler))
	b.srv.TLS = &tls.Config{
		GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
			b.mu.Lock()
			b.sni = append(b.sni, hello.ServerName)
			b.mu.Unlock()
			return nil, nil
		},
	}
	if cert != nil {
		b.srv.TLS.Certificates = []tls.Certificate{*cert}
	}
	b.srv.StartTLS()
	t.Cleanup(b.srv.Close)
	sum := sha256.Sum256(b.srv.Certificate().Raw)
	b.fp = hex.EncodeToString(sum[:])
	return b
}

// otherCert is a self-signed certificate unlike httptest's.
func otherCert(t *testing.T) *tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(42),
		Subject:      pkix.Name{CommonName: "impostor"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// deadURL is an https URL on a local port nothing listens on.
func deadURL(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close()
	return "https://" + addr
}

// endpointNode is a node on `primary` with `learned` fallbacks (as if
// learned on an earlier run) and pin `fp` ("" = none).
func endpointNode(t *testing.T, primary, fp string, learned ...Endpoint) *Node {
	t.Helper()
	cfg := &Config{
		Bridge:      primary,
		Token:       "test-token",
		Name:        "rack",
		DeviceID:    "node-abc",
		Fingerprint: fp,
		Endpoints:   learned,
		Path:        filepath.Join(t.TempDir(), "config.json"),
	}
	n, err := NewNode(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func currentURL(n *Node) string { return n.endpoints.current().URL }

// The headline case: the configured bridge is down, the node reaches the
// fallback within its normal reconnect backoff, and its pin is untouched.
func TestFailsOverWhenPrimaryRefusesConnections(t *testing.T) {
	live := newMeshBridge(t, nil)
	n := endpointNode(t, deadURL(t), live.fp, Endpoint{URL: live.srv.URL})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { n.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()

	// First attempt fails on the dead primary, the retry after the 1s
	// minimum backoff lands on the fallback.
	select {
	case <-live.streamOpened:
	case <-time.After(minReconnectBackoff + 4*time.Second):
		t.Fatal("event stream never reached the fallback endpoint")
	}
	deadline := time.Now().Add(3 * time.Second)
	for live.count(func() int { return live.registers }) == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if live.count(func() int { return live.registers }) == 0 {
		t.Fatal("never registered through the fallback endpoint")
	}
	if currentURL(n) != live.srv.URL {
		t.Fatalf("current endpoint %s, want the fallback %s", currentURL(n), live.srv.URL)
	}
	if n.pinnedFingerprint() != live.fp {
		t.Fatalf("pin changed to %q", n.pinnedFingerprint())
	}
}

// A dial override connects to the fixed address but keeps the URL's host
// for SNI and Host, so the proxy still routes it and the pin is checked —
// what `curl --resolve` does.
func TestDialOverrideKeepsSNIAndPin(t *testing.T) {
	live := newMeshBridge(t, nil)
	addr := strings.TrimPrefix(live.srv.URL, "https://")
	_, port, _ := net.SplitHostPort(addr)
	named := "https://mesh.invalid:" + port
	n := endpointNode(t, deadURL(t), live.fp, Endpoint{URL: named, Dial: addr})

	if err := registerOnce(t, n); err == nil {
		t.Fatal("register on the dead primary succeeded")
	}
	if err := registerOnce(t, n); err != nil {
		t.Fatalf("register through the dial override: %v", err)
	}
	live.mu.Lock()
	defer live.mu.Unlock()
	if len(live.sni) == 0 || live.sni[0] != "mesh.invalid" {
		t.Fatalf("SNI %v, want mesh.invalid", live.sni)
	}
	if live.hosts[0] != "mesh.invalid:"+port {
		t.Fatalf("Host %q, want mesh.invalid:%s", live.hosts[0], port)
	}
}

// A learned endpoint presenting another certificate is refused before the
// bearer is ever sent, and the pin stays what it was.
func TestLearnedEndpointWithAnotherCertificateIsRefused(t *testing.T) {
	real := newMeshBridge(t, nil)
	impostor := newMeshBridge(t, otherCert(t))
	if impostor.fp == real.fp {
		t.Fatal("test setup: certificates should differ")
	}
	n := endpointNode(t, deadURL(t), real.fp, Endpoint{URL: impostor.srv.URL})

	_ = registerOnce(t, n) // dead primary → move to the impostor
	if currentURL(n) != impostor.srv.URL {
		t.Fatalf("did not move to the learned endpoint (on %s)", currentURL(n))
	}
	err := registerOnce(t, n)
	if err == nil || !strings.Contains(err.Error(), "mismatch") {
		t.Fatalf("register err = %v, want a certificate mismatch", err)
	}
	if got := impostor.count(func() int { return impostor.requests }); got != 0 {
		t.Fatalf("impostor received %d request(s) (and so the bearer)", got)
	}
	if n.pinnedFingerprint() != real.fp {
		t.Fatalf("pin changed to %q", n.pinnedFingerprint())
	}
	// The mismatch is a transport failure: the node moved on (back round to
	// the configured bridge) rather than sticking with the impostor.
	if currentURL(n) == impostor.srv.URL {
		t.Fatal("node stayed on an endpoint that failed the pin")
	}
}

// Trust-on-first-use never happens through a learned endpoint.
func TestLearnedEndpointNeverTOFUs(t *testing.T) {
	live := newMeshBridge(t, nil)
	n := endpointNode(t, deadURL(t), "", Endpoint{URL: live.srv.URL})

	_ = registerOnce(t, n)
	err := registerOnce(t, n)
	if !errors.Is(err, errLearnedNoPin) {
		t.Fatalf("register err = %v, want errLearnedNoPin", err)
	}
	n.maybeAdoptFingerprint()
	if n.pinnedFingerprint() != "" || n.lastSeenFingerprint() != "" {
		t.Fatalf("learned endpoint got pinned (pin %q, seen %q)",
			n.pinnedFingerprint(), n.lastSeenFingerprint())
	}
	if got := live.count(func() int { return live.requests }); got != 0 {
		t.Fatalf("learned endpoint received %d request(s) unpinned", got)
	}
	if _, err := os.Stat(n.cfg.Path); !os.IsNotExist(err) {
		t.Fatalf("config was written (err %v)", err)
	}
}

// Only transport failures move the node: an answer from the bridge (auth,
// not found, rate limit) would be the same on every endpoint. A proxy that
// can't reach the bridge (502/503/504) does move it.
func TestOnlyTransportFailuresFailOver(t *testing.T) {
	for _, tc := range []struct {
		code  int
		moves bool
	}{
		{http.StatusUnauthorized, false},
		{http.StatusForbidden, false},
		{http.StatusNotFound, false},
		{http.StatusConflict, false},
		{http.StatusTooManyRequests, false},
		{http.StatusBadGateway, true},
		{http.StatusServiceUnavailable, true},
		{http.StatusGatewayTimeout, true},
	} {
		t.Run(fmt.Sprint(tc.code), func(t *testing.T) {
			primary := newMeshBridge(t, nil)
			fallback := newMeshBridge(t, nil)
			primary.status.Store(int32(tc.code))
			n := endpointNode(t, primary.srv.URL, primary.fp, Endpoint{URL: fallback.srv.URL})
			if err := registerOnce(t, n); err == nil {
				t.Fatal("register succeeded")
			}
			moved := currentURL(n) == fallback.srv.URL
			if moved != tc.moves {
				t.Fatalf("HTTP %d: moved=%v, want %v", tc.code, moved, tc.moves)
			}
		})
	}
}

// Off the configured bridge, the node probes it every
// failbackProbeInterval and goes back once it answers.
func TestFailsBackToPrimary(t *testing.T) {
	primary := newMeshBridge(t, nil)
	fallback := newMeshBridge(t, nil)
	n := endpointNode(t, primary.srv.URL, primary.fp, Endpoint{URL: fallback.srv.URL})
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	n.endpoints.now = func() time.Time { return time.Unix(0, clock.Load()) }
	advance := func(d time.Duration) { clock.Add(int64(d)) }
	ctx := context.Background()

	primary.status.Store(http.StatusBadGateway)
	_ = registerOnce(t, n)
	if currentURL(n) != fallback.srv.URL {
		t.Fatal("did not fail over")
	}
	// Too early: no probe at all.
	before := primary.count(func() int { return primary.requests })
	n.maybeFailBack(ctx)
	if primary.count(func() int { return primary.requests }) != before {
		t.Fatal("probed the primary before the interval elapsed")
	}
	// Due, but the primary is still down: stay.
	advance(failbackProbeInterval)
	n.maybeFailBack(ctx)
	if currentURL(n) != fallback.srv.URL {
		t.Fatal("failed back to a primary that is still down")
	}
	// Primary recovers; the next due probe brings the node home.
	primary.status.Store(0)
	advance(failbackProbeInterval)
	n.maybeFailBack(ctx)
	if currentURL(n) != primary.srv.URL {
		t.Fatalf("still on %s after the primary recovered", currentURL(n))
	}
	if err := registerOnce(t, n); err != nil {
		t.Fatal(err)
	}
}

// The register reply's list (the shared fixture) is learned, persisted and
// kept behind the configured bridge.
func TestLearnsEndpointsFromRegisterReply(t *testing.T) {
	var fx struct {
		Reply json.RawMessage `json:"registerReplyWithEndpoints"`
	}
	loadFixture(t, "mesh_v1.json", &fx)
	var parsed registerReply
	if err := json.Unmarshal(fx.Reply, &parsed); err != nil || parsed.Endpoints == nil {
		t.Fatalf("fixture reply does not parse into registerReply: %v", err)
	}

	live := newMeshBridge(t, nil)
	live.reply = string(fx.Reply)
	n := endpointNode(t, live.srv.URL, "")
	if err := registerOnce(t, n); err != nil {
		t.Fatal(err)
	}
	list, cur := n.endpoints.snapshot()
	if cur != 0 || !list[0].primary || list[0].URL != live.srv.URL {
		t.Fatalf("configured bridge is not first and current: %v (cur %d)", list[0].Endpoint, cur)
	}
	want := parsed.Endpoints.List
	if len(list) != len(want)+1 {
		t.Fatalf("learned %d endpoints, want %d", len(list)-1, len(want))
	}
	for i, ep := range want {
		if list[i+1].Endpoint != ep {
			t.Errorf("entry %d = %+v, want %+v", i+1, list[i+1].Endpoint, ep)
		}
	}
	// Persisted beside the (TOFU-adopted) pin, for the next start.
	var saved Config
	raw, _ := os.ReadFile(n.cfg.Path)
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.EndpointsVersion != parsed.Endpoints.V || len(saved.Endpoints) != len(want) {
		t.Fatalf("saved endpoints %+v (v %q)", saved.Endpoints, saved.EndpointsVersion)
	}
	if saved.Fingerprint != live.fp {
		t.Fatalf("saved pin %q, want %q", saved.Fingerprint, live.fp)
	}
	// A restart starts from the saved list.
	restarted, _ := NewNode(&saved)
	if l, _ := restarted.endpoints.snapshot(); len(l) != len(want)+1 {
		t.Fatalf("restarted node has %d endpoints", len(l))
	}
}

// A list naming the configured bridge, or malformed entries, can't
// displace or duplicate it.
func TestSanitizeEndpointsKeepsPrimaryFirst(t *testing.T) {
	got := sanitizeEndpoints([]Endpoint{
		{URL: "https://mesh.example.org/"},                          // the primary itself
		{URL: "https://mesh.example.org", Dial: "203.0.113.7:443"},  // ok
		{URL: "https://mesh.example.org", Dial: "203.0.113.7:443"},  // duplicate
		{URL: "http://mesh.example.org", Dial: "203.0.113.7:80"},    // not https
		{URL: "https://mesh.example.org", Dial: "evil.example:443"}, // hostname dial
		{URL: "https://mesh.example.org", Dial: "203.0.113.7"},      // no port
		{URL: "https://user:pw@mesh.example.org"},                   // credentials
		{URL: "https://mesh.example.org/?x=1"},                      // query
		{URL: "https://backup.example.net", Dial: "[2001:db8::1]:443"},
	}, "https://mesh.example.org")
	want := []Endpoint{
		{URL: "https://mesh.example.org", Dial: "203.0.113.7:443"},
		{URL: "https://backup.example.net", Dial: "[2001:db8::1]:443"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("entry %d = %+v, want %+v", i, got[i], want[i])
		}
	}
	many := make([]Endpoint, 20)
	for i := range many {
		many[i] = Endpoint{URL: fmt.Sprintf("https://n%d.example", i)}
	}
	if len(sanitizeEndpoints(many, "https://p.example")) != maxEndpoints {
		t.Fatal("learned list is not capped")
	}
}

// A daemon that sends no list (every daemon before this change) leaves the
// node exactly as it was: one endpoint, nothing new in the config, and a
// failure keeps it on that endpoint.
func TestOldDaemonReplyChangesNothing(t *testing.T) {
	live := newMeshBridge(t, nil)
	n := endpointNode(t, live.srv.URL, "")
	if err := registerOnce(t, n); err != nil {
		t.Fatal(err)
	}
	if l, _ := n.endpoints.snapshot(); len(l) != 1 {
		t.Fatalf("%d endpoints, want only the configured bridge", len(l))
	}
	raw, err := os.ReadFile(n.cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	var saved map[string]any
	_ = json.Unmarshal(raw, &saved)
	for _, key := range []string{"endpoints", "endpointsVersion"} {
		if _, ok := saved[key]; ok {
			t.Errorf("config gained %q from a reply without a list", key)
		}
	}
	live.srv.Close()
	if err := registerOnce(t, n); err == nil {
		t.Fatal("register on a closed bridge succeeded")
	}
	if currentURL(n) != live.srv.URL {
		t.Fatal("a single-endpoint node moved")
	}
}

// A previously learned list survives replies that omit the field, and an
// advertised empty list clears it.
func TestEmptyListClearsAndMissingFieldKeeps(t *testing.T) {
	live := newMeshBridge(t, nil)
	n := endpointNode(t, live.srv.URL, live.fp, Endpoint{URL: "https://b.example"})
	n.cfg.EndpointsVersion = "old"
	if err := registerOnce(t, n); err != nil {
		t.Fatal(err)
	}
	if l, _ := n.endpoints.snapshot(); len(l) != 2 {
		t.Fatalf("list dropped by a reply without the field (%d entries)", len(l))
	}
	live.mu.Lock()
	live.reply = `{"ok":true,"deviceId":"node-abc","endpoints":{"v":"empty","list":[]}}`
	live.mu.Unlock()
	if err := registerOnce(t, n); err != nil {
		t.Fatal(err)
	}
	if l, _ := n.endpoints.snapshot(); len(l) != 1 {
		t.Fatalf("empty list did not clear the learned entries (%d left)", len(l))
	}
}

func TestIsFailoverError(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want bool
	}{
		{nil, false},
		{context.Canceled, false},
		{fmt.Errorf("get: %w", context.Canceled), false},
		{context.DeadlineExceeded, true},
		{&net.OpError{Op: "dial", Err: errors.New("connection refused")}, true},
		{&net.DNSError{Err: "no such host", Name: "mesh.invalid"}, true},
		{errStreamIdle, true},
		{fmt.Errorf("tls: %w", errLearnedNoPin), true},
		{&httpStatusError{Code: 401}, false},
		{&httpStatusError{Code: 429}, false},
		{&httpStatusError{Code: 502}, true},
		{&httpStatusError{Code: 504}, true},
	} {
		if got := isFailoverError(tc.err); got != tc.want {
			t.Errorf("isFailoverError(%v) = %v, want %v", tc.err, got, tc.want)
		}
	}
}
