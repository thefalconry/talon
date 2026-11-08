package main

// On-device command audit (#1057 §5).
//
// Every mesh command this node runs leaves one JSON line in audit.jsonl next
// to config.json: when, which command, what it touched, how it ended, how
// long it took and which credential the node was using. The host owner reads
// it with `talon-node audit` (or the tail in `talon-node status`) without
// having to trust the daemon's own account of what it asked for.
//
// The log records what was touched, never content: a path, or for exec the
// SHA-256 of the command line, and never file bytes. It is a bounded ring
// (compacted to the newest auditKeep entries once it reaches twice that),
// written 0600, and lives in the config directory the mesh's filesystem
// commands already refuse to write. Writing it is strictly best effort: it
// happens after the result has been posted, and a failure is logged, never
// surfaced to the command.

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	auditFileName = "audit.jsonl"
	// auditKeep entries survive a compaction; the file never holds more
	// than twice this many.
	auditKeep = 500
	// auditStatusTail is how many entries `talon-node status` shows.
	auditStatusTail = 10
	// Caps on free-text fields, so one odd command can't bloat the ring.
	auditMaxTarget = 512
	auditMaxError  = 200
)

// auditEntry is one line of audit.jsonl.
type auditEntry struct {
	Time       string `json:"time"`
	CommandID  string `json:"commandId"`
	Name       string `json:"name"`
	Target     string `json:"target,omitempty"`
	OK         bool   `json:"ok"`
	Error      string `json:"error,omitempty"`
	DurationMs int64  `json:"durationMs"`
	Credential string `json:"credential"`
}

// auditLog appends entries to one ring file. Safe for concurrent use by the
// command workers.
type auditLog struct {
	path string
	keep int

	mu sync.Mutex
	// lines counts entries in the file; -1 until first counted.
	lines int
}

func newAuditLog(path string) *auditLog {
	return &auditLog{path: path, keep: auditKeep, lines: -1}
}

// auditPath is where the audit ring for a config file lives.
func auditPath(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), auditFileName)
}

// record appends one entry, logging (never returning or panicking on) any
// failure: the audit must not be able to break command handling.
func (a *auditLog) record(e auditEntry) {
	if a == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			log.Printf("audit: record panicked: %v", r)
		}
	}()
	if err := a.append(e); err != nil {
		log.Printf("audit: could not record %s (%s): %v", e.Name, e.CommandID, err)
	}
}

func (a *auditLog) append(e auditEntry) error {
	line, err := json.Marshal(e)
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.lines < 0 {
		a.lines = countLines(a.path)
	}
	if err := os.MkdirAll(filepath.Dir(a.path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(a.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	// OpenFile's mode only applies on creation; narrow a pre-existing file.
	_ = f.Chmod(0o600)
	_, err = f.Write(append(line, '\n'))
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	a.lines++
	if a.lines >= 2*a.keep {
		return a.compactLocked()
	}
	return nil
}

// compactLocked rewrites the file with only the newest a.keep lines, via a
// 0600 temp file and a rename so a crash never truncates the log.
func (a *auditLog) compactLocked() error {
	raw, err := os.ReadFile(a.path)
	if err != nil {
		return err
	}
	lines := splitLines(raw)
	if len(lines) > a.keep {
		lines = lines[len(lines)-a.keep:]
	}
	tmp := a.path + ".tmp"
	var buf bytes.Buffer
	for _, l := range lines {
		buf.Write(l)
		buf.WriteByte('\n')
	}
	if err := os.WriteFile(tmp, buf.Bytes(), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, a.path); err != nil {
		os.Remove(tmp)
		return err
	}
	a.lines = len(lines)
	return nil
}

// readAudit returns up to the last n entries of the audit file at path,
// oldest first (n <= 0 means all). Malformed lines are skipped. A missing
// file is an empty log, not an error.
func readAudit(path string, n int) ([]auditEntry, error) {
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []auditEntry
	for _, l := range splitLines(raw) {
		var e auditEntry
		if json.Unmarshal(l, &e) == nil && e.Name != "" {
			out = append(out, e)
		}
	}
	if n > 0 && len(out) > n {
		out = out[len(out)-n:]
	}
	return out, nil
}

func splitLines(raw []byte) [][]byte {
	var out [][]byte
	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 0, 4096), 1<<20)
	for sc.Scan() {
		if l := bytes.TrimSpace(sc.Bytes()); len(l) > 0 {
			out = append(out, append([]byte(nil), l...))
		}
	}
	return out
}

func countLines(path string) int {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	return len(splitLines(raw))
}

// newAuditEntry builds the record for one finished command.
func newAuditEntry(
	id, name string,
	params map[string]any,
	result commandResult,
	elapsed time.Duration,
	token string,
) auditEntry {
	e := auditEntry{
		Time:       time.Now().UTC().Format(time.RFC3339Nano),
		CommandID:  id,
		Name:       name,
		Target:     clip(auditTarget(name, params), auditMaxTarget),
		OK:         result.OK,
		DurationMs: elapsed.Milliseconds(),
		Credential: auditCredential(token),
	}
	if !result.OK {
		e.Error = clip(result.Message, auditMaxError)
		if e.Error == "" {
			e.Error = "failed"
		}
	}
	return e
}

// auditTarget names what a command touched without recording content: the
// path(s) for filesystem commands, and only a hash of an exec command line
// (which can carry secrets) so the host owner can still match it against
// the daemon's own log.
func auditTarget(name string, params map[string]any) string {
	str := func(key string) string {
		v, _ := params[key].(string)
		return v
	}
	switch name {
	case "exec":
		cmd := str("cmd")
		if cmd == "" {
			return ""
		}
		sum := sha256.Sum256([]byte(cmd))
		return "sha256:" + hex.EncodeToString(sum[:])
	case "computer":
		// The action only: typed text and key presses can be secrets, and
		// coordinates mean nothing without the screen they were aimed at.
		return str("action")
	case "move":
		if str("from") == "" && str("to") == "" {
			return ""
		}
		return str("from") + " -> " + str("to")
	default:
		return str("path")
	}
}

// auditCredential names the bearer the node was using, never the secret:
// "device:<credential id>", "shared", or "none".
func auditCredential(token string) string {
	switch {
	case token == "":
		return "none"
	case isDeviceCredential(token):
		return "device:" + strings.SplitN(token, ".", 3)[1]
	default:
		return "shared"
	}
}

// clip flattens s to one line and cuts it to at most limit bytes on a rune
// boundary.
func clip(s string, limit int) string {
	s = strings.ReplaceAll(strings.TrimSpace(s), "\n", " ")
	if len(s) <= limit {
		return s
	}
	for limit > 0 && !utf8.RuneStart(s[limit]) {
		limit--
	}
	return s[:limit] + "…"
}

// formatAuditEntry is one human-readable line for `status` / `audit`.
func formatAuditEntry(e auditEntry) string {
	outcome := "ok"
	if !e.OK {
		outcome = "error: " + e.Error
	}
	target := ""
	if e.Target != "" {
		target = " " + e.Target
	}
	return fmt.Sprintf(
		"%s  %s%s  %dms  %s  [%s] %s",
		e.Time, e.Name, target, e.DurationMs, e.Credential, e.CommandID, outcome,
	)
}

// printAuditTail is the audit section of `talon-node status`.
func printAuditTail(configPath string) {
	path := auditPath(configPath)
	entries, err := readAudit(path, auditStatusTail)
	switch {
	case err != nil:
		fmt.Printf("audit:       unreadable: %v\n", err)
	case len(entries) == 0:
		fmt.Printf("audit:       %s (no commands yet)\n", path)
	default:
		fmt.Printf("audit:       %s (last %d; `talon-node audit` for more)\n", path, len(entries))
		for _, e := range entries {
			fmt.Printf("  %s\n", formatAuditEntry(e))
		}
	}
}

// auditCmd is `talon-node audit`. It only reads: the config is located, not
// loaded, so nothing is minted or rewritten.
func auditCmd(args []string) {
	fs := flag.NewFlagSet("talon-node audit", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath(), "config file path")
	count := fs.Int("n", 50, "entries to show, newest last (0 = all)")
	asJSON := fs.Bool("json", false, "print raw JSON lines")
	_ = fs.Parse(args)

	path := auditPath(*configPath)
	entries, err := readAudit(path, *count)
	if err != nil {
		fmt.Fprintf(os.Stderr, "audit: %v\n", err)
		os.Exit(1)
	}
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		for _, e := range entries {
			_ = enc.Encode(e)
		}
		return
	}
	if len(entries) == 0 {
		fmt.Printf("no commands recorded yet (%s)\n", path)
		return
	}
	for _, e := range entries {
		fmt.Println(formatAuditEntry(e))
	}
}
