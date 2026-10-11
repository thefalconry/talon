package main

// Per-device credentials (#1042 phase 2).
//
// The daemon used to authenticate every device with one shared bearer
// token. It now mints each device its own credential — installers already
// embed one — and a node still running on the shared token trades it in
// band: the /devices/register reply (the 60s heartbeat) carries
// `credential: {action: "upgrade"}`, the node POSTs /auth/upgrade, persists
// the returned `tdc1.…` token to its config (next to the pinned
// fingerprint) and uses it from then on. The same exchange rotates a
// per-device credential when the operator asks (`action: "rotate"`).
//
// The swap is persist-then-adopt: a token that could not be written to the
// config is never used, so a restart can't strand the node on a credential
// it no longer has. The daemon keeps the old credential valid until the new
// one is first presented, so a lost reply is harmless too.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"regexp"
	"strings"
)

// deviceCredentialRE is the per-device credential shape (protocol/fixtures/
// auth_v1.json credentialPattern). Anything else is the shared token.
var deviceCredentialRE = regexp.MustCompile(`^tdc1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$`)

func isDeviceCredential(token string) bool {
	return deviceCredentialRE.MatchString(token)
}

// registerReply is the POST /devices/register response.
type registerReply struct {
	OK         bool            `json:"ok"`
	DeviceID   string          `json:"deviceId"`
	Credential *credentialHint `json:"credential,omitempty"`
	// Endpoints is the other ways to reach the bridge (endpoints.go);
	// absent from older daemons.
	Endpoints *advertisedEndpoints `json:"endpoints,omitempty"`
}

type credentialHint struct {
	Action string `json:"action"`
}

// credentialAction is what the node should do about the reply's hint given
// the token it is using: "upgrade", "rotate", or "" (nothing — including
// for any action this build does not know, which must be ignored).
func (r registerReply) credentialAction(token string) string {
	if r.Credential == nil {
		return ""
	}
	switch r.Credential.Action {
	case "upgrade":
		if !isDeviceCredential(token) {
			return "upgrade"
		}
	case "rotate":
		if isDeviceCredential(token) {
			return "rotate"
		}
	}
	return ""
}

// upgradeRequestBody is the POST /auth/upgrade payload. A node only ever
// asks for the device scope.
func upgradeRequestBody(deviceID string) map[string]any {
	return map[string]any{
		"deviceId": deviceID,
		"client":   "node",
		"scopes":   []string{"device"},
	}
}

type upgradeReply struct {
	OK           bool     `json:"ok"`
	Token        string   `json:"token"`
	CredentialID string   `json:"credentialId"`
	DeviceID     string   `json:"deviceId"`
	Scopes       []string `json:"scopes"`
	Error        string   `json:"error"`
}

// parseUpgradeReply decodes and validates an /auth/upgrade reply: it must
// carry a well-formed credential bound to THIS node.
func parseUpgradeReply(raw []byte, deviceID string) (upgradeReply, error) {
	var r upgradeReply
	if err := json.Unmarshal(raw, &r); err != nil {
		return r, fmt.Errorf("upgrade reply: %w", err)
	}
	if !r.OK {
		return r, fmt.Errorf("upgrade refused: %s", r.Error)
	}
	if !isDeviceCredential(r.Token) {
		return r, errors.New("upgrade reply carried no valid credential")
	}
	if r.DeviceID != deviceID {
		return r, fmt.Errorf("credential is for %q, not this node (%q)", r.DeviceID, deviceID)
	}
	return r, nil
}

// token is the bearer in use right now (it changes on upgrade/rotation).
func (n *Node) token() string {
	n.tokenMu.RLock()
	defer n.tokenMu.RUnlock()
	return n.cfg.Token
}

// saveConfig writes the config under the token lock, so a save never
// serializes a half-swapped credential.
func (n *Node) saveConfig() error {
	n.tokenMu.Lock()
	defer n.tokenMu.Unlock()
	return n.saveConfigLocked()
}

// saveConfigLocked writes the config; the caller holds tokenMu. It also
// holds pinMu for reading, since Save serializes cfg.Fingerprint, which a
// concurrent TOFU adoption may be writing (lock order: tokenMu, pinMu).
func (n *Node) saveConfigLocked() error {
	n.pinMu.RLock()
	defer n.pinMu.RUnlock()
	return n.cfg.Save()
}

// adoptCredential persists `token` and only then starts using it.
func (n *Node) adoptCredential(token string) error {
	n.tokenMu.Lock()
	defer n.tokenMu.Unlock()
	prev := n.cfg.Token
	n.cfg.Token = token
	if err := n.saveConfigLocked(); err != nil {
		n.cfg.Token = prev
		return err
	}
	return nil
}

// maybeUpgradeCredential acts on a register reply's credential hint. Runs
// at most one exchange at a time; a daemon without per-device credentials
// (404) or a config the node cannot write turns it off for this run.
func (n *Node) maybeUpgradeCredential(ctx context.Context, reply registerReply) {
	action := reply.credentialAction(n.token())
	if action == "" || n.upgradeDisabled.Load() {
		return
	}
	if !n.upgrading.CompareAndSwap(false, true) {
		return
	}
	defer n.upgrading.Store(false)

	var raw json.RawMessage
	err := n.postJSON(ctx, "/auth/upgrade", upgradeRequestBody(n.DeviceID), &raw)
	if err != nil {
		log.Printf("credential %s failed: %v", action, err)
		if strings.Contains(err.Error(), "HTTP 404") {
			n.upgradeDisabled.Store(true)
		}
		return
	}
	up, err := parseUpgradeReply(raw, n.DeviceID)
	if err != nil {
		log.Printf("credential %s failed: %v", action, err)
		return
	}
	if err := n.adoptCredential(up.Token); err != nil {
		// Never use a credential the config does not hold: stay on the old
		// one (still valid daemon-side) and stop asking for this run.
		log.Printf("credential %s: could not persist the new credential (%v) — keeping the current one", action, err)
		n.upgradeDisabled.Store(true)
		return
	}
	log.Printf(
		"credential %s: now using per-device credential %s (scopes %v)",
		action, up.CredentialID, up.Scopes,
	)
}

// credentialKind describes the configured bearer for `talon-node status`.
func credentialKind(token string) string {
	switch {
	case token == "":
		return "(none)"
	case isDeviceCredential(token):
		return "per-device credential " + strings.SplitN(token, ".", 3)[1]
	default:
		return "shared bridge token (legacy — upgraded automatically on connect)"
	}
}
