package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Policy is the device-local capability policy: what this host agrees to do
// for the mesh, decided by whoever owns the host. It lives in config.json
// and can never be changed over the mesh (filesystem commands refuse to
// touch the config directory and the node's own binary).
//
// Zero values keep the historic behaviour, so an existing config.json
// without a "policy" block behaves as before apart from the caps.
type Policy struct {
	// DisableExec refuses the exec command (arbitrary shell).
	DisableExec bool `json:"disableExec,omitempty"`
	// DisableUpdate refuses update_node (remote self-update).
	DisableUpdate bool `json:"disableUpdate,omitempty"`
	// DisableComputer refuses computer (screen capture, pointer and keyboard
	// control) on platforms that offer it.
	DisableComputer bool `json:"disableComputer,omitempty"`
	// ReadPaths, when set, confines read_file / list_dir / stat /
	// upload_file to these directory trees.
	ReadPaths []string `json:"readPaths,omitempty"`
	// WritePaths, when set, confines write_file / delete / mkdir / move /
	// download_file to these directory trees.
	WritePaths []string `json:"writePaths,omitempty"`
	// MaxConcurrent bounds how many commands run at once (default 8); up to
	// commandQueueDepth more wait for a free slot, beyond that a command is
	// answered "busy" at once.
	MaxConcurrent int `json:"maxConcurrent,omitempty"`
	// MaxWriteBytes caps the size of a file written by write_file or
	// download_file (default 4 GiB).
	MaxWriteBytes int64 `json:"maxWriteBytes,omitempty"`
}

const (
	defaultMaxConcurrent = 8
	defaultMaxWriteBytes = int64(4) << 30
)

// commandQueueDepth is how many commands may wait for a free worker; beyond
// it new commands are answered "busy" straight away.
const commandQueueDepth = 32

func (p Policy) maxConcurrent() int {
	if p.MaxConcurrent > 0 {
		return p.MaxConcurrent
	}
	return defaultMaxConcurrent
}

func (p Policy) maxWriteBytes() int64 {
	if p.MaxWriteBytes > 0 {
		return p.MaxWriteBytes
	}
	return defaultMaxWriteBytes
}

// capabilities filters the full command surface down to what the policy
// allows, so the daemon never offers a tool this host will refuse. The
// surface is the commands every node has plus the ones this platform adds.
func (p Policy) capabilities() []string {
	out := make([]string, 0, len(nodeCapabilities)+len(platformCapabilities))
	for _, c := range allCapabilities() {
		if (c == "exec" && p.DisableExec) ||
			(c == "update_node" && p.DisableUpdate) ||
			(c == "computer" && p.DisableComputer) {
			continue
		}
		out = append(out, c)
	}
	return out
}

// allCapabilities is everything this build can do before policy is applied.
func allCapabilities() []string {
	out := make([]string, 0, len(nodeCapabilities)+len(platformCapabilities))
	out = append(out, nodeCapabilities...)
	return append(out, platformCapabilities...)
}

// readPathParams names, per command, the params holding a path it reads.
var readPathParams = map[string][]string{
	"read_file":   {"path"},
	"list_dir":    {"path"},
	"stat":        {"path"},
	"upload_file": {"path"},
}

// writePathParams names, per command, the params holding a path it writes
// (a move's source counts: moving a file away removes it).
var writePathParams = map[string][]string{
	"write_file":    {"path"},
	"delete":        {"path"},
	"mkdir":         {"path"},
	"move":          {"from", "to"},
	"download_file": {"path"},
}

// errPolicy marks a refusal by the local policy (as opposed to an I/O error).
var errPolicy = errors.New("refused by this host's talon-node policy")

// check decides whether a command may run here. protected lists paths the
// mesh may never write (the node's config directory and binary).
func (p Policy) check(name string, params map[string]any, protected []string) error {
	switch name {
	case "exec":
		if p.DisableExec {
			return fmt.Errorf("%w: exec is disabled", errPolicy)
		}
	case "update_node":
		if p.DisableUpdate {
			return fmt.Errorf("%w: update_node is disabled", errPolicy)
		}
	case "computer":
		if p.DisableComputer {
			return fmt.Errorf("%w: computer is disabled", errPolicy)
		}
	}
	for _, key := range readPathParams[name] {
		if err := p.allowPath(params, key, p.ReadPaths, nil); err != nil {
			return err
		}
	}
	for _, key := range writePathParams[name] {
		if err := p.allowPath(params, key, p.WritePaths, protected); err != nil {
			return err
		}
	}
	if name == "write_file" {
		size := int64(intParam(params, "offset", 0))
		if b64, ok := params["base64"].(string); ok {
			size += int64(len(b64) / 4 * 3)
		}
		if size > p.maxWriteBytes() {
			return fmt.Errorf("%w: write would exceed maxWriteBytes (%d)", errPolicy, p.maxWriteBytes())
		}
	}
	return nil
}

func (p Policy) allowPath(params map[string]any, key string, allowed, protected []string) error {
	raw, _ := params[key].(string)
	if raw == "" {
		// Missing paths are the command's own error to report.
		return nil
	}
	path := canonicalPath(raw)
	for _, prot := range protected {
		if within(path, canonicalPath(prot)) {
			return fmt.Errorf("%w: %s is part of talon-node itself", errPolicy, raw)
		}
	}
	if len(allowed) == 0 {
		return nil
	}
	for _, root := range allowed {
		if within(path, canonicalPath(root)) {
			return nil
		}
	}
	return fmt.Errorf("%w: %s is outside the allowed paths", errPolicy, raw)
}

// canonicalPath makes a path absolute and clean and resolves symlinks in
// the longest prefix that exists, so a symlink can't smuggle a write out of
// an allowed tree (or into a protected one).
func canonicalPath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	rest := ""
	cur := abs
	for {
		if resolved, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(resolved, rest)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return abs
		}
		rest = filepath.Join(filepath.Base(cur), rest)
		cur = parent
	}
}

// within reports whether path is root or inside it.
func within(path, root string) bool {
	if path == root {
		return true
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	if filepath.IsAbs(rel) || rel == ".." {
		return false
	}
	return !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// protectedPaths are what the mesh may never write: the directory holding
// config.json (the policy itself, the token) and the running binary, plus
// its update staging names.
func (n *Node) protectedPaths() []string {
	var out []string
	if n.cfg != nil && n.cfg.Path != "" {
		out = append(out, filepath.Dir(n.cfg.Path))
	}
	if exe, err := os.Executable(); err == nil {
		out = append(out, exe, exe+".old")
	}
	return out
}

// limitWriter fails once more than max bytes have been written.
type limitWriter struct {
	w       io.Writer
	max     int64
	written int64
}

func (l *limitWriter) Write(b []byte) (int, error) {
	if l.written+int64(len(b)) > l.max {
		return 0, fmt.Errorf("%w: file exceeds maxWriteBytes (%d)", errPolicy, l.max)
	}
	n, err := l.w.Write(b)
	l.written += int64(n)
	return n, err
}
