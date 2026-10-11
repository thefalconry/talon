package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Heartbeat cadence matches the companion app: the daemon flips a device
// offline after ~90s without a beat (and evicts presence at 180s), so 60s
// keeps the node solidly "online" while tolerating one dropped beat.
const heartbeatInterval = 60 * time.Second

// streamIdleTimeout bounds how long the event stream may stay silent. The
// daemon writes an SSE ping comment every 25s, so three missed pings means
// the connection is half-open (a NAT dropped the flow, a proxy stalled):
// tear it down and reconnect instead of blocking in Read until kernel TCP
// keepalive gives up minutes later — all while the separate heartbeat keeps
// the node looking online and commands sent to it time out (#1061).
// A var only so tests can shorten it.
var streamIdleTimeout = 75 * time.Second

// Reconnect backoff: doubles per failed attempt up to maxReconnectBackoff,
// and drops back to minReconnectBackoff once a stream has stayed up for
// stableStreamAfter — otherwise one flaky hour left every later reconnect
// waiting the full 30s, with commands sent in that gap lost (#1061).
const (
	minReconnectBackoff = time.Second
	maxReconnectBackoff = 30 * time.Second
	stableStreamAfter   = 10 * time.Second
)

// capabilities every node advertises at registration (a platform may add
// more: see platformCapabilities). The daemon gates commands on the list,
// so it must exactly cover what dispatch() handles.
// locate is deliberately absent (servers have no GPS); install_apk is the
// Android self-update path and does not apply.
var nodeCapabilities = []string{
	"ring",
	"status",
	"exec",
	"read_file",
	"write_file",
	"list_dir",
	"stat",
	"delete",
	"mkdir",
	"move",
	"upload_file",
	"download_file",
	"update_node",
}

// Node is the running mesh client: pinned-TLS HTTP to the bridge plus the
// SSE consumer that turns device_command events into local work.
type Node struct {
	cfg *Config
	// endpoints is every way to reach the bridge — the configured URL
	// first, then any the daemon advertised — each with its own pinned
	// HTTP client (endpoints.go).
	endpoints *endpointSet
	DeviceID  string
	// seenFingerprint carries the leaf-certificate hash observed during TLS
	// verification of the most recent connection, for TOFU capture. Written
	// from whichever goroutine is handshaking (heartbeat, stream, result
	// POST), so atomic (#1061).
	seenFingerprint atomic.Pointer[string]
	// pinMu guards cfg.Fingerprint: read on every handshake and by every
	// config save (TOFU adoption, credential upgrade), written once by
	// maybeAdoptFingerprint. Lock order: tokenMu before pinMu.
	pinMu sync.RWMutex
	// pendingReexec is set by a successful update_node so handleCommand can
	// restart into the new binary AFTER the command result has been posted
	// (a re-exec replaces the whole process image, so the ack must land
	// first or the caller would hang waiting for a reply that never comes).
	pendingReexec atomic.Bool
	// tokenMu guards cfg.Token, which an in-band credential upgrade swaps
	// while heartbeat, stream and command goroutines read it.
	tokenMu sync.RWMutex
	// upgrading serializes credential exchanges; upgradeDisabled stops them
	// for the run (daemon without per-device credentials, unwritable config).
	upgrading       atomic.Bool
	upgradeDisabled atomic.Bool

	// Commands run on a fixed worker pool (Policy.MaxConcurrent) fed by a
	// bounded queue, never one goroutine per frame: a burst from a buggy or
	// compromised daemon can't fork-bomb the host.
	workersOnce sync.Once
	commands    chan map[string]any
	rejects     chan map[string]any

	// audit is the on-device command log next to config.json (audit.go);
	// nil when the node has no config path to put it beside.
	audit *auditLog
}

func NewNode(cfg *Config) (*Node, error) {
	n := &Node{cfg: cfg, DeviceID: cfg.DeviceID}
	if cfg.Path != "" {
		n.audit = newAuditLog(auditPath(cfg.Path))
	}
	n.endpoints = newEndpointSet(
		n.newEndpoint(Endpoint{URL: cfg.Bridge}, true),
		nil,
	)
	// A list learned on an earlier run, so a node that restarts during a
	// DNS outage can still reach the bridge.
	n.endpoints.replaceLearned(
		sanitizeEndpoints(cfg.Endpoints, cfg.Bridge),
		func(ep Endpoint) *endpoint { return n.newEndpoint(ep, false) },
	)
	return n, nil
}

// verifyPinnedCert implements pin-or-TOFU over the leaf certificate DER —
// the same fingerprint /health advertises and companion pairing screens
// display. With a pin configured, any mismatch kills the handshake. With no
// pin yet, the observed hash is recorded and persisted after the first
// successful authenticated call (see maybeAdoptFingerprint) — unless strict
// TLS is on, which refuses the handshake instead.
func (n *Node) verifyPinnedCert(rawCerts [][]byte, _ [][]*x509.Certificate) error {
	if len(rawCerts) == 0 {
		return errors.New("bridge presented no certificate")
	}
	sum := sha256.Sum256(rawCerts[0])
	got := hex.EncodeToString(sum[:])
	n.seenFingerprint.Store(&got)
	pin := n.pinnedFingerprint()
	if pin == "" && n.strictTLS() {
		return fmt.Errorf("%w (bridge presented %s)", errStrictNoPin, got)
	}
	if pin != "" && pin != got {
		return fmt.Errorf(
			"bridge certificate mismatch: pinned %s, got %s — refusing to connect",
			pin, got,
		)
	}
	return nil
}

// strictTLS reports whether trust-on-first-use is off (Config.StrictTLS).
// Set from config only, never changed while running.
func (n *Node) strictTLS() bool {
	return n.cfg != nil && n.cfg.StrictTLS
}

// maybeAdoptFingerprint persists the first-seen certificate hash so every
// later connect is pinned. Called only after a request that proved the
// token works (register/health), so a rogue endpoint can't get adopted just
// by completing a handshake.
func (n *Node) maybeAdoptFingerprint() {
	seen := n.lastSeenFingerprint()
	n.pinMu.Lock()
	// Strict TLS never adopts: the handshake already refused an unpinned
	// bridge, so this is only a second line of defence.
	if n.cfg.Fingerprint != "" || seen == "" || n.strictTLS() {
		n.pinMu.Unlock()
		return
	}
	n.cfg.Fingerprint = seen
	n.pinMu.Unlock()
	// saveConfig takes tokenMu then pinMu (read), so the write can't
	// serialize a half-swapped credential or race the pin it records.
	if err := n.saveConfig(); err != nil {
		log.Printf("warning: could not persist pinned fingerprint: %v", err)
		return
	}
	logTOFUAdoption(seen, n.cfg.Path)
}

// logTOFUAdoption announces a trust-on-first-use pin loudly: it is the one
// moment an operator can catch a man-in-the-middle, by comparing the pinned
// fingerprint with the one the daemon host reports.
func logTOFUAdoption(fingerprint, configPath string) {
	for _, line := range []string{
		"==================== TRUST ON FIRST USE ====================",
		"Pinned the bridge TLS certificate on first connect:",
		"  " + fingerprint,
		"Compare it with the fingerprint `talon status` shows on the daemon",
		"host (or the bridge's /health). If they differ, stop this node,",
		"remove \"fingerprint\" from " + configPath + " and reconnect",
		"with --fingerprint <the daemon's value>. Use --strict-tls to",
		"refuse unpinned bridges altogether.",
		"============================================================",
	} {
		log.Print(line)
	}
}

// pinnedFingerprint is the configured pin ("" = none yet), safe to call from
// any goroutine's TLS handshake.
func (n *Node) pinnedFingerprint() string {
	n.pinMu.RLock()
	defer n.pinMu.RUnlock()
	return n.cfg.Fingerprint
}

// lastSeenFingerprint is the leaf hash from the most recent handshake.
func (n *Node) lastSeenFingerprint() string {
	if p := n.seenFingerprint.Load(); p != nil {
		return *p
	}
	return ""
}

// drainClose reads what's left of a response body (bounded) before closing
// it. net/http only reuses a keep-alive connection whose body was read to
// EOF; closing a partly-read body — a reply over the 4KB we parse — forces a
// fresh TCP + TLS handshake on the next heartbeat (#1061).
func drainClose(body io.ReadCloser) {
	_, _ = io.Copy(io.Discard, io.LimitReader(body, 64<<10))
	_ = body.Close()
}

func (n *Node) authed(req *http.Request) *http.Request {
	req.Header.Set("Authorization", "Bearer "+n.token())
	return req
}

// postJSON sends one JSON body and decodes the JSON reply (which may be
// discarded by passing nil). Non-2xx becomes an error with the body tail so
// bridge-side validation messages surface in logs.
func (n *Node) postJSON(ctx context.Context, path string, body any, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	_, err = n.postJSONVia(ctx, path, raw, out)
	return err
}

// postJSONVia is postJSON for a JSON body already encoded, also reporting
// the endpoint that carried it.
func (n *Node) postJSONVia(ctx context.Context, path string, raw []byte, out any) (*endpoint, error) {
	res, e, err := n.send(ctx, http.MethodPost, path, nil, bytes.NewReader(raw), func(req *http.Request) {
		req.Header.Set("Content-Type", "application/json")
		n.authed(req)
	})
	if err != nil {
		return e, err
	}
	defer drainClose(res.Body)
	reply, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return e, &httpStatusError{Path: path, Code: res.StatusCode, Body: strings.TrimSpace(string(reply))}
	}
	if out != nil {
		return e, json.Unmarshal(reply, out)
	}
	return e, nil
}

// Health fetches /health (unauthenticated by design — the discovery ping)
// from the endpoint in use.
func (n *Node) Health() (map[string]any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return n.healthOn(ctx, n.endpoints.current())
}

// healthOn fetches /health from one particular endpoint.
func (n *Node) healthOn(ctx context.Context, e *endpoint) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, e.url("/health", nil), nil)
	if err != nil {
		return nil, err
	}
	res, err := e.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer drainClose(res.Body)
	if res.StatusCode != http.StatusOK {
		return nil, &httpStatusError{Path: "/health", Code: res.StatusCode}
	}
	var out map[string]any
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// registrationBody is the POST /devices/register payload — also the 60s
// heartbeat body. Battery fields are omitted entirely: servers don't have
// one, and the registry treats absence correctly. Kept as its own function
// so the protocol conformance test can assert the wire shape against the
// shared fixture (protocol/fixtures/mesh_v1.json).
func (n *Node) registrationBody() map[string]any {
	return map[string]any{
		"id":       n.DeviceID,
		"name":     n.cfg.Name,
		"platform": meshPlatform(),
		// The Go arch (amd64/arm64/arm) — matched against release binary
		// names (talon-node-<os>-<arch>) so the daemon can auto-resolve the
		// right replacement for update_node.
		"arch":         runtime.GOARCH,
		"appVersion":   version,
		"capabilities": n.capabilities(),
	}
}

// capabilities is the command surface this host's policy allows.
func (n *Node) capabilities() []string {
	if n.cfg == nil {
		return allCapabilities()
	}
	return n.cfg.Policy.capabilities()
}

// Register upserts this node in the daemon's mesh registry. The reply may
// ask the node to trade its credential (see credentials.go).
func (n *Node) Register(ctx context.Context) error {
	raw, err := json.Marshal(n.registrationBody())
	if err != nil {
		return err
	}
	var reply registerReply
	e, err := n.postJSONVia(ctx, "/devices/register", raw, &reply)
	if err == nil {
		// Trust on first use only ever happens on the configured bridge.
		if e.primary {
			n.maybeAdoptFingerprint()
		}
		n.learnEndpoints(reply.Endpoints)
		n.maybeUpgradeCredential(ctx, reply)
	}
	return err
}

// resultBody is the POST /devices/command-result payload. Its own function
// so the protocol conformance test can assert the wire shape against the
// shared fixture (protocol/fixtures/mesh_v1.json).
func resultBody(deviceID string, r commandResult) map[string]any {
	return map[string]any{
		"commandId": r.CommandID,
		"deviceId":  deviceID,
		"ok":        r.OK,
		"message":   r.Message,
		"data":      r.Data,
	}
}

// PostCommandResult answers one device_command by correlation id. Every
// command path must end here — success, failure, or unsupported — or the
// daemon-side tool call hangs until its timeout.
func (n *Node) PostCommandResult(ctx context.Context, r commandResult) error {
	return n.postJSON(ctx, "/devices/command-result", resultBody(n.DeviceID, r), nil)
}

// Run is the forever loop: register, heartbeat, and consume the SSE stream,
// reconnecting with capped exponential backoff until ctx is done.
func (n *Node) Run(ctx context.Context) {
	// Heartbeat runs independently of the event stream: registration is how
	// presence works, and it must survive SSE reconnect churn.
	go n.heartbeatLoop(ctx)
	// SIGHUP (unix) restarts into the on-disk binary — a reload after the
	// binary is replaced out of band. No-op on Windows.
	go watchReload(ctx, n)

	backoff := minReconnectBackoff
	for ctx.Err() == nil {
		n.maybeFailBack(ctx)
		uptime, err := n.consumeEvents(ctx)
		if ctx.Err() != nil {
			return
		}
		var wait time.Duration
		wait, backoff = reconnectBackoff(backoff, uptime)
		log.Printf("event stream dropped (%v) — reconnecting in %s", err, wait)
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return
		}
	}
}

// reconnectBackoff returns how long to wait before the next connect attempt
// and the backoff to carry into the one after. A stream that stayed up for
// stableStreamAfter resets to the minimum; failures double up to the cap.
func reconnectBackoff(current, uptime time.Duration) (wait, next time.Duration) {
	if uptime >= stableStreamAfter || current < minReconnectBackoff {
		current = minReconnectBackoff
	}
	next = current * 2
	if next > maxReconnectBackoff {
		next = maxReconnectBackoff
	}
	return current, next
}

func (n *Node) heartbeatLoop(ctx context.Context) {
	// Immediate first beat so the node shows up without waiting a minute.
	for {
		n.maybeFailBack(ctx)
		beatCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		if err := n.Register(beatCtx); err != nil {
			log.Printf("register failed: %v", err)
		}
		cancel()
		select {
		case <-time.After(heartbeatInterval):
		case <-ctx.Done():
			return
		}
	}
}

// errStreamIdle reports a stream torn down by the idle deadline.
var errStreamIdle = errors.New("event stream idle past the deadline (half-open connection?)")

// consumeEvents opens GET /events and dispatches device_command frames
// addressed to this device. Blocks until the stream errors, goes silent for
// streamIdleTimeout, or ctx is done, and reports how long the stream was up
// (0 if it never connected). Each frame is `data: <json>\n\n` (standard
// SSE, no event names).
func (n *Node) consumeEvents(ctx context.Context) (time.Duration, error) {
	// The stream gets its own context so the idle deadline can cancel the
	// read without touching ctx, which running commands still use.
	streamCtx, cancelStream := context.WithCancel(ctx)
	defer cancelStream()
	// Name ourselves on the stream: the daemon addresses device_command
	// frames (which carry transfer tokens and command lines) to the claiming
	// client alone instead of shouting them at every connected device.
	q := url.Values{"deviceId": {n.DeviceID}}
	res, e, err := n.send(streamCtx, http.MethodGet, "/events", q, nil, func(req *http.Request) {
		req.Header.Set("Accept", "text/event-stream")
		n.authed(req)
	})
	if err != nil {
		return 0, err
	}
	defer drainClose(res.Body)
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return 0, fmt.Errorf("events: HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	log.Printf("event stream connected via %s", e.Endpoint)
	connectedAt := time.Now()
	uptime := func() time.Duration { return time.Since(connectedAt) }

	// Re-register on every (re)connect: if the daemon restarted, its registry
	// reloaded from disk but this device may have flipped offline meanwhile.
	go func() {
		regCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		if err := n.Register(regCtx); err != nil {
			log.Printf("post-connect register failed: %v", err)
		}
	}()

	// Any bytes at all — frames or the daemon's ping comments — prove the
	// connection is alive; silence past the deadline cancels the stream.
	idle := time.AfterFunc(streamIdleTimeout, cancelStream)
	defer idle.Stop()
	scanner := bufio.NewScanner(&idleResetReader{r: res.Body, timer: idle, d: streamIdleTimeout})
	// Command payloads (write_file base64 chunks) can approach ~400KB of
	// JSON; give the scanner room well beyond that.
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		event, ok := decodeCommandFrame(scanner.Text(), n.DeviceID)
		if !ok {
			continue
		}
		// Commands run concurrently on purpose (a long exec must not block a
		// status probe; the daemon correlates results by id, not order), but
		// on a bounded pool — see enqueueCommand.
		n.workersOnce.Do(func() { n.startWorkers(ctx) })
		n.enqueueCommand(event)
	}
	if streamCtx.Err() != nil && ctx.Err() == nil {
		// A half-open connection may be this path's fault; the next attempt
		// tries the next endpoint (all of them reach the same bridge).
		n.endpointFailed(e, errStreamIdle)
		return uptime(), errStreamIdle
	}
	if err := scanner.Err(); err != nil {
		return uptime(), err
	}
	return uptime(), errors.New("stream closed")
}

// idleResetReader pushes an idle deadline back every time data arrives.
type idleResetReader struct {
	r     io.Reader
	timer *time.Timer
	d     time.Duration
}

func (r *idleResetReader) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	if n > 0 {
		r.timer.Reset(r.d)
	}
	return n, err
}

// startWorkers starts the command worker pool and the "busy" responder.
// They live as long as ctx (the node's run context), across reconnects.
func (n *Node) startWorkers(ctx context.Context) {
	workers := defaultMaxConcurrent
	if n.cfg != nil {
		workers = n.cfg.Policy.maxConcurrent()
	}
	n.commands = make(chan map[string]any, commandQueueDepth)
	n.rejects = make(chan map[string]any, commandQueueDepth)
	for i := 0; i < workers; i++ {
		go n.drain(ctx, n.commands, n.handleCommand)
	}
	go n.drain(ctx, n.rejects, n.answerBusy)
}

func (n *Node) drain(
	ctx context.Context,
	queue <-chan map[string]any,
	handle func(context.Context, map[string]any),
) {
	for {
		select {
		case event := <-queue:
			handle(ctx, event)
		case <-ctx.Done():
			return
		}
	}
}

// enqueueCommand hands a command to the worker pool without ever blocking
// the stream reader. With every worker busy and the queue full, the command
// is answered "busy" instead (so the daemon's call resolves); if even that
// backlog is full, it is dropped and the daemon's own timeout answers it.
func (n *Node) enqueueCommand(event map[string]any) {
	select {
	case n.commands <- event:
		return
	default:
	}
	select {
	case n.rejects <- event:
	default:
		id, _ := event["id"].(string)
		log.Printf("command backlog full — dropping %s unanswered", id)
	}
}

func (n *Node) answerBusy(ctx context.Context, event map[string]any) {
	id, _ := event["id"].(string)
	if id == "" {
		return
	}
	result := fail(
		"talon-node is busy (all workers running, %d commands queued) — try again shortly.",
		commandQueueDepth,
	)
	result.CommandID = id
	postCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := n.PostCommandResult(postCtx, result); err != nil {
		log.Printf("could not answer busy command %s: %v", id, err)
	}
}

func (n *Node) handleCommand(ctx context.Context, event map[string]any) {
	id, _ := event["id"].(string)
	if id == "" {
		return
	}
	name, _ := event["name"].(string)
	params, _ := event["params"].(map[string]any)
	if params == nil {
		params = map[string]any{}
	}
	log.Printf("command %q (%s)", name, id)
	started := time.Now()
	result := dispatch(ctx, n, name, params)
	elapsed := time.Since(started)
	result.CommandID = id
	postCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := n.PostCommandResult(postCtx, result); err != nil {
		log.Printf("could not answer command %q (%s): %v", name, id, err)
	}
	// Audited after the answer is on its way (so the log never delays a
	// reply) but before any re-exec (so an update is still recorded).
	if n.audit != nil {
		n.audit.record(newAuditEntry(id, name, params, result, elapsed, n.token()))
	}
	// A successful update_node swapped the on-disk binary; now that the ack
	// has been delivered, restart into it. Under systemd/launchd this is an
	// in-place execve (same pid, no exit → the supervisor sees no crash);
	// the daemon confirms via get_device_status once appVersion changes.
	if n.pendingReexec.Load() {
		reexecInto(n)
	}
}

// decodeCommandFrame parses one SSE line into a device_command event
// addressed to deviceID. Everything else — blank separators, comments,
// keepalives, malformed JSON (not for us to crash on), other event kinds,
// commands for other devices — returns false and is skipped.
func decodeCommandFrame(line, deviceID string) (map[string]any, bool) {
	if !strings.HasPrefix(line, "data: ") {
		return nil, false
	}
	var event map[string]any
	if err := json.Unmarshal([]byte(line[len("data: "):]), &event); err != nil {
		return nil, false
	}
	if event["kind"] != "device_command" {
		return nil, false
	}
	if id, _ := event["deviceId"].(string); id != deviceID {
		return nil, false
	}
	return event, true
}

// meshPlatform maps the Go runtime OS onto the mesh's DevicePlatform enum.
func meshPlatform() string {
	switch runtime.GOOS {
	case "darwin":
		return "macos"
	case "windows":
		return "windows"
	default:
		// linux and any other unix all register as linux — the closest enum
		// member the daemon validates against.
		return "linux"
	}
}
