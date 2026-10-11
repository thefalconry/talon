package main

// Endpoint failover (mesh high availability, phase 1).
//
// The node used to know one way to reach the bridge: Config.Bridge. The
// daemon may now advertise more in its register reply (the 60s heartbeat)
// — the same URL dialled at a fixed IP, so a DNS outage doesn't take the
// mesh down, or a second name. The node keeps them as an ordered set:
//
//   - entry 0 is always the configured bridge (Config.Bridge); a list
//     learned from the daemon can never remove or reorder it;
//   - the node sticks with the entry that works, and moves to the next on a
//     transport failure (DNS, connect, TLS/pin, timeout, or a proxy's
//     502/503/504) — never on an auth or application error;
//   - while off the configured bridge it probes that bridge's /health every
//     failbackProbeInterval and returns to it once it answers.
//
// Trust does not change: every entry must present the certificate the node
// already pins. Trust-on-first-use only ever happens on the configured
// bridge — a learned entry with no pin to check against is refused, and a
// learned entry presenting another certificate is refused without touching
// the pin. A daemon that sends no list (older daemons) leaves the node on
// exactly one endpoint, as before.

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Endpoint is one way to reach the bridge.
type Endpoint struct {
	// URL is the base URL. Its host goes in TLS SNI and the Host header,
	// so a reverse proxy still routes the request to the bridge.
	URL string `json:"url"`
	// Dial, when set, is the IP literal and port to connect to instead of
	// resolving URL's host ("203.0.113.7:443", "[2001:db8::1]:443").
	Dial string `json:"dial,omitempty"`
	// Label is a note for status output.
	Label string `json:"label,omitempty"`
}

// advertisedEndpoints is the register reply's `endpoints` field.
type advertisedEndpoints struct {
	// V identifies the list; the node only compares it to spot a change.
	V    string     `json:"v"`
	List []Endpoint `json:"list"`
}

// maxEndpoints bounds a learned list (the daemon sends at most 8 too).
const maxEndpoints = 8

// endpointDialTimeout bounds one TCP connect, so a black-holed address
// fails over in seconds instead of waiting out the OS connect timeout.
const endpointDialTimeout = 15 * time.Second

// failbackProbeInterval is how often the node, while on a fallback entry,
// checks whether the configured bridge answers again. A var for tests.
var failbackProbeInterval = 5 * time.Minute

// errLearnedNoPin refuses a learned endpoint when the node holds no pin.
var errLearnedNoPin = errors.New(
	"refusing a learned bridge endpoint: no certificate is pinned yet, and " +
		"trust-on-first-use only ever happens on the configured bridge",
)

// endpoint is a live entry: its address plus its own HTTP client, so the
// dial override and the certificate check can be told apart per entry.
type endpoint struct {
	Endpoint
	primary bool
	client  *http.Client
}

// key identifies an entry (URL + dial); labels don't count.
func (e Endpoint) key() string { return e.URL + "\n" + e.Dial }

// String is the entry as logs show it.
func (e Endpoint) String() string {
	if e.Dial != "" {
		return e.URL + " (dialling " + e.Dial + ")"
	}
	return e.URL
}

// url builds a request URL on this entry.
func (e *endpoint) url(path string, query url.Values) string {
	u := e.URL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	return u
}

// endpointSet is the ordered entries and which one is in use. Entry 0 is
// the configured bridge.
type endpointSet struct {
	mu   sync.Mutex
	list []*endpoint
	cur  int
	// nextProbe is the earliest time a failback probe may run.
	nextProbe time.Time
	now       func() time.Time
}

func newEndpointSet(primary *endpoint, learned []*endpoint) *endpointSet {
	return &endpointSet{list: append([]*endpoint{primary}, learned...), now: time.Now}
}

// current is the entry requests should use now.
func (s *endpointSet) current() *endpoint {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.list[s.cur]
}

// snapshot is a copy of the entries and the current index.
func (s *endpointSet) snapshot() ([]*endpoint, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*endpoint(nil), s.list...), s.cur
}

// failed moves past e after a transport failure, if e is still the entry
// in use (a heartbeat and the stream failing on the same entry at once
// must move one step, not two). Returns the new entry, or nil when
// nothing changed.
func (s *endpointSet) failed(e *endpoint) *endpoint {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.list) < 2 || s.list[s.cur] != e {
		return nil
	}
	s.cur = (s.cur + 1) % len(s.list)
	if s.cur != 0 {
		// Give the fallback a full interval before probing the primary,
		// which only just failed.
		s.nextProbe = s.now().Add(failbackProbeInterval)
	}
	return s.list[s.cur]
}

// failbackDue returns the configured bridge when the node is on a fallback
// and a probe is due (scheduling the next one), else nil.
func (s *endpointSet) failbackDue() *endpoint {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur == 0 || s.now().Before(s.nextProbe) {
		return nil
	}
	s.nextProbe = s.now().Add(failbackProbeInterval)
	return s.list[0]
}

// restorePrimary goes back to the configured bridge.
func (s *endpointSet) restorePrimary() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cur = 0
}

// replaceLearned swaps the learned entries (everything after the primary).
// Unchanged entries keep their client (and its open connections); the
// node stays on the entry it is using if that entry is still listed, and
// otherwise returns to the configured bridge.
func (s *endpointSet) replaceLearned(learned []Endpoint, build func(Endpoint) *endpoint) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing := map[string]*endpoint{}
	for _, e := range s.list[1:] {
		existing[e.key()] = e
	}
	inUse := s.list[s.cur]
	next := []*endpoint{s.list[0]}
	s.cur = 0
	for _, ep := range learned {
		// An entry is immutable once built (other goroutines read it), so a
		// changed label alone keeps the old one until the next restart.
		e, ok := existing[ep.key()]
		if !ok {
			e = build(ep)
		}
		if e == inUse {
			s.cur = len(next)
		}
		next = append(next, e)
	}
	s.list = next
}

// sanitizeEndpoints keeps the well-formed entries of an advertised list:
// https only, a bare base URL (no credentials, query or fragment), a dial
// that is an IP literal and port. The configured bridge itself (no dial)
// is dropped — it is always entry 0 already — as are duplicates, and the
// list is capped at maxEndpoints.
func sanitizeEndpoints(list []Endpoint, primary string) []Endpoint {
	out := []Endpoint{}
	seen := map[string]bool{
		(Endpoint{URL: strings.TrimRight(primary, "/")}).key(): true,
	}
	for _, ep := range list {
		ep.URL = strings.TrimRight(strings.TrimSpace(ep.URL), "/")
		ep.Dial = strings.TrimSpace(ep.Dial)
		ep.Label = strings.TrimSpace(ep.Label)
		if len(ep.Label) > 64 {
			ep.Label = ep.Label[:64]
		}
		if !validEndpointURL(ep.URL) || (ep.Dial != "" && !validDial(ep.Dial)) {
			log.Printf("bridge: ignoring malformed advertised endpoint %q", ep.String())
			continue
		}
		if seen[ep.key()] || len(out) >= maxEndpoints {
			continue
		}
		seen[ep.key()] = true
		out = append(out, ep)
	}
	return out
}

func validEndpointURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host != "" &&
		u.User == nil && u.RawQuery == "" && u.Fragment == "" && !u.ForceQuery
}

// validDial accepts "ip:port" / "[ipv6]:port" and nothing else: a dial
// override exists to skip name resolution, so a hostname makes no sense.
func validDial(raw string) bool {
	host, port, err := net.SplitHostPort(raw)
	if err != nil {
		return false
	}
	if _, err := netip.ParseAddr(host); err != nil {
		return false
	}
	p, err := strconv.Atoi(port)
	return err == nil && p >= 1 && p <= 65535
}

// newEndpoint builds an entry with its own HTTP client. The primary keeps
// the pin-or-TOFU check (verifyPinnedCert); learned entries get the strict
// one (verifyLearnedCert).
func (n *Node) newEndpoint(ep Endpoint, primary bool) *endpoint {
	verify := n.verifyLearnedCert
	if primary {
		verify = n.verifyPinnedCert
	}
	dialer := &net.Dialer{Timeout: endpointDialTimeout, KeepAlive: 30 * time.Second}
	dial := dialer.DialContext
	if ep.Dial != "" {
		// Connect to the fixed address whatever the URL's host resolves to.
		// TLS ServerName is still taken from the URL (the transport does
		// that), so SNI and the proxy's site routing are unchanged.
		target := ep.Dial
		dial = func(ctx context.Context, network, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, target)
		}
	}
	transport := &http.Transport{
		// The bridge mints a self-signed certificate; identity is proven by
		// pinning its SHA-256 (exactly like the companion app), not by a CA
		// chain or hostname. VerifyPeerCertificate is the real check.
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify:    true,
			VerifyPeerCertificate: verify,
		},
		DialContext:         dial,
		TLSHandshakeTimeout: endpointDialTimeout,
		// SSE responses are unbounded; only bound the dial + TLS handshake.
		ResponseHeaderTimeout: 30 * time.Second,
	}
	return &endpoint{Endpoint: ep, primary: primary, client: &http.Client{Transport: transport}}
}

// verifyLearnedCert is the certificate check for a learned entry: the pin
// the node already holds must match. Nothing is recorded for TOFU, and no
// pin means no connection.
func (n *Node) verifyLearnedCert(rawCerts [][]byte, _ [][]*x509.Certificate) error {
	if len(rawCerts) == 0 {
		return errors.New("bridge presented no certificate")
	}
	sum := sha256.Sum256(rawCerts[0])
	got := hex.EncodeToString(sum[:])
	pin := n.pinnedFingerprint()
	if pin == "" {
		return fmt.Errorf("%w (it presented %s)", errLearnedNoPin, got)
	}
	if pin != got {
		return fmt.Errorf(
			"bridge certificate mismatch on a learned endpoint: pinned %s, got %s — refusing to connect",
			pin, got,
		)
	}
	return nil
}

// httpStatusError is a non-2xx bridge reply. Its text is what the node
// always logged ("<path>: HTTP <code>: <body>").
type httpStatusError struct {
	Path string
	Code int
	Body string
}

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("%s: HTTP %d: %s", e.Path, e.Code, e.Body)
}

// failoverStatus is a reply that says "this path to the bridge is broken"
// rather than "the bridge said no": a proxy that can't reach upstream.
func failoverStatus(code int) bool {
	return code == http.StatusBadGateway ||
		code == http.StatusServiceUnavailable ||
		code == http.StatusGatewayTimeout
}

// isFailoverError reports whether err means the entry in use is
// unreachable — DNS, connect, TLS or pin, timeouts, a proxy's 502/503/504 —
// as opposed to an answer from the bridge (401, 403, 404, 409, 429 …) or
// the node shutting down, which another entry would not change.
func isFailoverError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) {
		return false
	}
	var status *httpStatusError
	if errors.As(err, &status) {
		return failoverStatus(status.Code)
	}
	return true
}

// endpointFailed records a failure on e and moves to the next entry when
// it is a transport failure.
func (n *Node) endpointFailed(e *endpoint, err error) {
	if !isFailoverError(err) {
		return
	}
	if next := n.endpoints.failed(e); next != nil {
		log.Printf("bridge: %s failed (%v) — switching to %s", e.Endpoint, err, next.Endpoint)
	}
}

// send performs one request on the entry in use, marking it failed on a
// transport error or a failover status. The caller owns res.Body.
func (n *Node) send(
	ctx context.Context,
	method, path string,
	query url.Values,
	body io.Reader,
	prepare func(*http.Request),
) (*http.Response, *endpoint, error) {
	e := n.endpoints.current()
	req, err := http.NewRequestWithContext(ctx, method, e.url(path, query), body)
	if err != nil {
		return nil, e, err
	}
	if prepare != nil {
		prepare(req)
	}
	res, err := e.client.Do(req)
	if err != nil {
		n.endpointFailed(e, err)
		return nil, e, err
	}
	if failoverStatus(res.StatusCode) {
		n.endpointFailed(e, &httpStatusError{Path: path, Code: res.StatusCode})
	}
	return res, e, nil
}

// maybeFailBack returns to the configured bridge when the node is on a
// fallback, a probe is due, and the configured bridge answers /health
// (over its pinned handshake).
func (n *Node) maybeFailBack(ctx context.Context) {
	primary := n.endpoints.failbackDue()
	if primary == nil {
		return
	}
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if _, err := n.healthOn(probeCtx, primary); err != nil {
		log.Printf("bridge: %s still unreachable (%v)", primary.Endpoint, err)
		return
	}
	n.endpoints.restorePrimary()
	log.Printf("bridge: %s answers again — back on it", primary.Endpoint)
}

// learnEndpoints adopts the list a register reply advertised. No field
// (an older daemon) changes nothing. A list is only learned by a node that
// holds a pin — the reply then came over a pinned channel — and is
// persisted next to the config so it survives a restart.
func (n *Node) learnEndpoints(adv *advertisedEndpoints) {
	if adv == nil || n.pinnedFingerprint() == "" {
		return
	}
	learned := sanitizeEndpoints(adv.List, n.cfg.Bridge)
	n.tokenMu.Lock()
	unchanged := adv.V == n.cfg.EndpointsVersion &&
		(adv.V != "" || slices.Equal(learned, n.cfg.Endpoints))
	if unchanged {
		n.tokenMu.Unlock()
		return
	}
	n.cfg.Endpoints = learned
	n.cfg.EndpointsVersion = adv.V
	err := n.saveConfigLocked()
	n.tokenMu.Unlock()
	if err != nil {
		// Still use it this run; the daemon re-sends it every heartbeat.
		log.Printf("warning: could not persist the bridge endpoint list: %v", err)
	}
	n.endpoints.replaceLearned(learned, func(ep Endpoint) *endpoint {
		return n.newEndpoint(ep, false)
	})
	log.Printf("bridge: daemon advertises %d alternate endpoint(s)", len(learned))
	for _, ep := range learned {
		log.Printf("bridge:   %s", ep)
	}
}
