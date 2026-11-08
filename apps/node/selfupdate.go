package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// cmdUpdateNode is the headless analogue of the companion's install_apk: a
// remote self-update. The daemon has already streamed the replacement binary
// to `path` (via download_file) and passes its SHA-256; this verifies the
// bytes, atomically swaps the binary in place, and arms an in-place restart
// that fires only AFTER the command result is delivered (see handleCommand).
//
// Robustness mirrors the APK path:
//   - The SHA-256 is mandatory (the daemon always sends it) and the pushed
//     file is re-hashed here; a missing digest or a mismatch aborts before
//     anything is swapped, so unverified or truncated bytes never install.
//   - The pushed binary's embedded version must be newer than the running
//     one (or a different build of the same release); a rollback or a
//     same-build reinstall needs an explicit allow_downgrade: true.
//   - The swap is a rename over the running executable — on Unix the live
//     process keeps its open inode, so replacing the file is safe; the new
//     inode is only loaded on the subsequent execve.
//   - The staging copy lands next to the executable, guaranteeing a
//     same-filesystem (atomic) rename regardless of where the daemon pushed.
func cmdUpdateNode(n *Node, params map[string]any) commandResult {
	path, _ := params["path"].(string)
	if path == "" {
		return fail("update_node needs the path of the pushed binary.")
	}
	wantSha, _ := params["sha256"].(string)
	if !isSHA256Hex(wantSha) {
		return fail("update_node needs the binary's sha256 (64 hex characters) — refusing to install unverified bytes.")
	}
	allowDowngrade, _ := params["allow_downgrade"].(bool)

	exe, err := ownExecutable()
	if err != nil {
		return fail("update_node: cannot locate own binary: %v", err)
	}
	pushed, err := installUpdate(exe, updateRequest{
		src:            path,
		sha256:         wantSha,
		running:        version,
		allowDowngrade: allowDowngrade,
	})
	if err != nil {
		return fail("update_node: %v", err)
	}
	// Best effort: drop the original pushed copy now it's installed.
	if path != exe {
		os.Remove(path)
	}

	n.pendingReexec.Store(true)
	return commandResult{
		OK: true,
		Message: fmt.Sprintf(
			"Update staged at %s — restarting into the new binary now; "+
				"confirm with get_device_status once appVersion changes.", exe,
		),
		Data: map[string]any{
			"installedTo":     exe,
			"restarting":      true,
			"previousVersion": version,
			"newVersion":      pushed,
		},
	}
}

// updateRequest is one update_node install: the pushed file, its mandatory
// SHA-256, and the version gate's inputs.
type updateRequest struct {
	src            string
	sha256         string
	running        string
	allowDowngrade bool
}

// isSHA256Hex reports whether s is a 64-character hex SHA-256.
func isSHA256Hex(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

// ownExecutable resolves this process's binary path (symlinks followed).
func ownExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return exe, nil
}

// installUpdate verifies a replacement binary at req.src against req.sha256
// (required) and the version gate, then atomically swaps it in for the
// binary at exe. It never touches exe until the bytes are staged and
// verified, so a truncated, mismatched or refused payload leaves the running
// binary untouched. Split out from cmdUpdateNode so the swap/verify mechanics
// are unit-testable without a live mesh. Returns the pushed binary's
// embedded version ("" when it carries none).
func installUpdate(exe string, req updateRequest) (string, error) {
	if !isSHA256Hex(req.sha256) {
		return "", fmt.Errorf("no valid sha256 given — refusing to install unverified bytes")
	}
	src, err := os.Open(req.src)
	if err != nil {
		return "", fmt.Errorf("cannot open %s: %w", req.src, err)
	}
	defer src.Close()

	// Stage next to the executable so the final rename is same-filesystem.
	staged := filepath.Join(filepath.Dir(exe), ".talon-node-update")
	dst, err := os.OpenFile(staged, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return "", fmt.Errorf("cannot stage next to binary: %w", err)
	}
	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(dst, hasher), src); err != nil {
		dst.Close()
		os.Remove(staged)
		return "", fmt.Errorf("staging copy failed: %w", err)
	}
	if err := dst.Close(); err != nil {
		os.Remove(staged)
		return "", fmt.Errorf("staging copy failed: %w", err)
	}

	// Integrity gate BEFORE the swap — never install unverified bytes.
	got := hex.EncodeToString(hasher.Sum(nil))
	if !strings.EqualFold(got, req.sha256) {
		os.Remove(staged)
		return "", fmt.Errorf(
			"integrity check failed (expected %s, got %s) — aborting",
			req.sha256, got,
		)
	}

	pushed, err := verifyStaged(staged, req)
	if err != nil {
		os.Remove(staged)
		return pushed, err
	}
	if err := swapBinary(staged, exe); err != nil {
		os.Remove(staged)
		return pushed, fmt.Errorf("could not replace running binary: %w", err)
	}
	return pushed, nil
}

// verifyStaged runs the post-hash gates on the staged copy: non-empty, the
// version gate, and the executable bit. The caller removes the staged file
// on error.
func verifyStaged(staged string, req updateRequest) (string, error) {
	bin, err := os.ReadFile(staged)
	if err != nil {
		return "", fmt.Errorf("cannot read staged binary: %w", err)
	}
	if len(bin) == 0 {
		return "", fmt.Errorf("staged binary is empty")
	}
	pushed, err := checkUpdateVersion(req.running, bin, req.allowDowngrade)
	if err != nil {
		return pushed, err
	}
	if err := os.Chmod(staged, 0o755); err != nil {
		return pushed, fmt.Errorf("chmod failed: %w", err)
	}
	return pushed, nil
}
