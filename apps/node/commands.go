package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// commandResult mirrors the wire shape of POST /devices/command-result.
type commandResult struct {
	CommandID string
	OK        bool
	Message   string
	Data      map[string]any
}

func fail(format string, args ...any) commandResult {
	return commandResult{OK: false, Message: fmt.Sprintf(format, args...)}
}

func okData(data map[string]any) commandResult {
	return commandResult{OK: true, Data: data}
}

func okMessage(format string, args ...any) commandResult {
	return commandResult{OK: true, Message: fmt.Sprintf(format, args...)}
}

// Chunked read_file/write_file payload ceiling — matches the companion app
// so daemon-side chunking assumptions hold for both device kinds.
const maxChunkBytes = 256 * 1024

// dispatch executes one mesh command and always produces an answer; an
// unknown name gets a clean "unsupported" so the daemon's pending call
// resolves instead of timing out. Panics are converted to failures for the
// same reason — one bad command must not kill the node or strand a caller.
func dispatch(ctx context.Context, n *Node, name string, params map[string]any) (result commandResult) {
	defer func() {
		if r := recover(); r != nil {
			result = fail("Command failed on device: %v", r)
		}
	}()
	if n != nil && n.cfg != nil {
		if err := n.cfg.Policy.check(name, params, n.protectedPaths()); err != nil {
			return fail("%v", err)
		}
	}
	switch name {
	case "ring":
		return cmdRing(params)
	case "status":
		return cmdStatus(n)
	case "exec":
		return cmdExec(ctx, params)
	case "read_file":
		return cmdReadFile(params)
	case "write_file":
		return cmdWriteFile(params)
	case "list_dir":
		return cmdListDir(params)
	case "stat":
		return cmdStat(params)
	case "delete":
		return cmdDelete(params)
	case "mkdir":
		return cmdMkdir(params)
	case "move":
		return cmdMove(params)
	case "upload_file":
		return cmdUploadFile(ctx, n, params)
	case "download_file":
		return cmdDownloadFile(ctx, n, params)
	case "update_node":
		return cmdUpdateNode(n, params)
	default:
		return fail("talon-node does not support %q.", name)
	}
}

// ── ring + status ────────────────────────────────────────────────────────────

// cmdRing is the headless take on find-my-phone: a terminal bell plus a loud
// log line. Mostly useful as a connectivity smoke test.
func cmdRing(params map[string]any) commandResult {
	note, _ := params["message"].(string)
	fmt.Print("\a")
	if note != "" {
		fmt.Printf("🔔 RING: %s\n", note)
	} else {
		fmt.Println("🔔 RING")
	}
	return okMessage("Headless node rang (terminal bell + log entry).")
}

// cmdStatus reports host telemetry as a flat string map, the shape the
// daemon's status summary renders as key/value lines (like the app's).
func cmdStatus(n *Node) commandResult {
	data := map[string]any{
		"name":       n.cfg.Name,
		"platform":   meshPlatform(),
		"appVersion": version,
		"kind":       "headless node (talon-node)",
	}
	if host, err := os.Hostname(); err == nil {
		data["hostname"] = host
	}
	if wd, err := os.Getwd(); err == nil {
		data["workingDir"] = wd
	}
	for k, v := range hostTelemetry() {
		data[k] = v
	}
	return okData(data)
}

// ── exec ─────────────────────────────────────────────────────────────────────

// Output caps match the companion app. The rolling tail is load-bearing:
// the daemon's teleport wrapper emits its cwd marker as the LAST bytes of
// stdout, so the tail must always survive truncation.
const (
	execOutputHeadBytes = 192 * 1024
	execOutputTailBytes = 64 * 1024
)

// cappedOutput keeps the head plus a rolling tail of a stream and counts
// what it elides, so a chatty command can't balloon memory or the mesh
// result payload while the stream keeps draining.
//
// Guarded by a mutex because the two ends genuinely run concurrently: the
// copy goroutine in runShell may still be writing a backgrounded child's
// output when the drain grace lapses and cmdExec reads the result.
type cappedOutput struct {
	mu      sync.Mutex
	head    strings.Builder
	tail    []byte
	dropped int
}

func (c *cappedOutput) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := len(p)
	if room := execOutputHeadBytes - c.head.Len(); room > 0 {
		take := min(room, len(p))
		c.head.Write(p[:take])
		p = p[take:]
	}
	if len(p) > 0 {
		c.tail = append(c.tail, p...)
		if over := len(c.tail) - execOutputTailBytes; over > 0 {
			c.dropped += over
			c.tail = append(c.tail[:0:0], c.tail[over:]...)
		}
	}
	return n, nil
}

func (c *cappedOutput) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.tail) == 0 {
		return c.head.String()
	}
	note := ""
	if c.dropped > 0 {
		note = fmt.Sprintf("\n…[%d chars truncated]…\n", c.dropped)
	}
	return c.head.String() + note + string(c.tail)
}

// cmdExec runs one shell command with a working directory and a timeout,
// answering stdout/stderr/exitCode exactly like the companion's exec — the
// substrate the daemon's device_exec and teleported bash tools build on.
func cmdExec(ctx context.Context, params map[string]any) commandResult {
	cmdline, _ := params["cmd"].(string)
	if strings.TrimSpace(cmdline) == "" {
		return fail("No command given.")
	}
	cwd, _ := params["cwd"].(string)
	timeoutMs := intParam(params, "timeoutMs", 60_000)
	if timeoutMs < 1000 {
		timeoutMs = 1000
	}
	if timeoutMs > 300_000 {
		timeoutMs = 300_000
	}
	budget := time.Duration(timeoutMs) * time.Millisecond

	var stdout, stderr cappedOutput
	exitCode, timedOut, err := runShell(ctx, cmdline, cwd, budget, &stdout, &stderr)
	if err != nil {
		return fail("Failed to run command: %v", err)
	}
	errText := stderr.String()
	if timedOut {
		if errText != "" {
			errText += "\n"
		}
		errText += "[killed: timeout]"
	}
	result := commandResult{
		OK: !timedOut && exitCode == 0,
		Data: map[string]any{
			"stdout":   stdout.String(),
			"stderr":   errText,
			"exitCode": exitCode,
		},
	}
	if timedOut {
		result.Message = "Command timed out."
	}
	return result
}

// ── filesystem ───────────────────────────────────────────────────────────────

func cmdReadFile(params map[string]any) commandResult {
	path, _ := params["path"].(string)
	if path == "" {
		return fail("No path.")
	}
	offset := int64(intParam(params, "offset", 0))
	length := intParam(params, "len", maxChunkBytes)
	if length < 0 {
		length = 0
	}
	if length > maxChunkBytes {
		length = maxChunkBytes
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fail("No such file: %s", path)
		}
		return fail("read_file failed: %v", err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return fail("read_file failed: %v", err)
	}
	buf := make([]byte, length)
	read, err := f.ReadAt(buf, offset)
	if err != nil && err != io.EOF {
		return fail("read_file failed: %v", err)
	}
	return okData(map[string]any{
		"base64": base64.StdEncoding.EncodeToString(buf[:read]),
		"size":   info.Size(),
		"eof":    offset+int64(read) >= info.Size(),
	})
}

func cmdWriteFile(params map[string]any) commandResult {
	path, _ := params["path"].(string)
	if path == "" {
		return fail("No path.")
	}
	b64, _ := params["base64"].(string)
	bytesOut, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return fail("write_file failed: invalid base64: %v", err)
	}
	offset := int64(intParam(params, "offset", 0))
	truncate := params["truncate"] == true
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fail("write_file failed: %v", err)
	}
	flags := os.O_WRONLY | os.O_CREATE
	if truncate {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(path, flags, 0o644)
	if err != nil {
		return fail("write_file failed: %v", err)
	}
	defer f.Close()
	if !truncate {
		// The transfer protocol is truncate-first + sequential offsets; a
		// chunk whose offset doesn't match the current size is out of order
		// (or a duplicate retry) and appending it would corrupt the file.
		info, err := f.Stat()
		if err != nil {
			return fail("write_file failed: %v", err)
		}
		if offset != info.Size() {
			return fail(
				"write_file chunk offset %d does not match current size %d for %s (out-of-order or duplicate chunk).",
				offset, info.Size(), path,
			)
		}
	}
	if truncate {
		offset = 0
	}
	if _, err := f.WriteAt(bytesOut, offset); err != nil {
		return fail("write_file failed: %v", err)
	}
	return okData(map[string]any{"bytesWritten": len(bytesOut)})
}

func cmdListDir(params map[string]any) commandResult {
	path, _ := params["path"].(string)
	if path == "" {
		return fail("No path.")
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fail("No such directory: %s", path)
		}
		return fail("list_dir failed: %v", err)
	}
	out := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		entry := map[string]any{
			"name": e.Name(),
			"type": "file",
		}
		if e.IsDir() {
			entry["type"] = "dir"
		}
		if info, err := e.Info(); err == nil {
			entry["size"] = info.Size()
			entry["mtime"] = info.ModTime().UnixMilli()
		}
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i]["name"].(string) < out[j]["name"].(string)
	})
	return okData(map[string]any{"entries": out})
}

func cmdStat(params map[string]any) commandResult {
	path, _ := params["path"].(string)
	if path == "" {
		return fail("No path.")
	}
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fail("No such path: %s", path)
		}
		return fail("stat failed: %v", err)
	}
	kind := "file"
	switch {
	case info.IsDir():
		kind = "directory"
	case info.Mode()&os.ModeSymlink != 0:
		kind = "link"
	}
	return okData(map[string]any{
		"type":  kind,
		"size":  info.Size(),
		"mtime": info.ModTime().UnixMilli(),
		"mode":  info.Mode().Perm().String()[1:], // "rwxr-xr-x"
	})
}

func cmdDelete(params map[string]any) commandResult {
	path, _ := params["path"].(string)
	if path == "" {
		return fail("No path.")
	}
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fail("No such path: %s", path)
		}
		return fail("delete failed: %v", err)
	}
	if info.IsDir() {
		err = os.RemoveAll(path)
	} else {
		err = os.Remove(path)
	}
	if err != nil {
		return fail("delete failed: %v", err)
	}
	return okMessage("Deleted %s", path)
}

func cmdMkdir(params map[string]any) commandResult {
	path, _ := params["path"].(string)
	if path == "" {
		return fail("No path.")
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		return fail("mkdir failed: %v", err)
	}
	return okMessage("Created %s", path)
}

func cmdMove(params map[string]any) commandResult {
	from, _ := params["from"].(string)
	to, _ := params["to"].(string)
	if from == "" || to == "" {
		return fail("from/to required.")
	}
	if err := os.Rename(from, to); err == nil {
		return okMessage("Moved %s → %s", from, to)
	}
	// Rename fails across filesystems — fall back to copy+delete for files.
	src, err := os.Open(from)
	if err != nil {
		return fail("move failed: %v", err)
	}
	defer src.Close()
	dst, err := os.Create(to)
	if err != nil {
		return fail("move failed: %v", err)
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		return fail("move failed: %v", err)
	}
	if err := dst.Close(); err != nil {
		return fail("move failed: %v", err)
	}
	src.Close()
	if err := os.Remove(from); err != nil {
		return fail("move failed: %v", err)
	}
	return okMessage("Moved %s → %s (copied)", from, to)
}

// ── streamed transfers ───────────────────────────────────────────────────────

// cmdUploadFile is the device half of device_pull_file: stream the file's
// bytes to the daemon as ONE raw HTTP POST authorized by a one-time token.
// No base64, no per-chunk round trips — TCP throughput.
func cmdUploadFile(ctx context.Context, n *Node, params map[string]any) commandResult {
	token, _ := params["token"].(string)
	path, _ := params["path"].(string)
	if token == "" || path == "" {
		return fail("upload_file needs token and path.")
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fail("No such file: %s", path)
		}
		return fail("upload_file failed: %v", err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return fail("upload_file failed: %v", err)
	}
	// Hashed as it streams (no second read), so the daemon can check what
	// arrived against what was sent.
	hasher := sha256.New()
	sent, err := n.uploadStream(ctx, token, io.TeeReader(f, hasher), info.Size())
	if err != nil {
		return fail("upload_file failed: %v", err)
	}
	return okData(map[string]any{
		"bytes":  sent,
		"sha256": hex.EncodeToString(hasher.Sum(nil)),
	})
}

// cmdDownloadFile is the device half of device_push_file: stream the
// daemon's bytes to disk from ONE raw HTTP GET. Writes to a .part sibling
// and renames, so a dropped connection can't leave a half-written file.
// The bytes are hashed as they are written; when the daemon sent the
// payload's `sha256` (older daemons don't), a mismatch deletes the .part
// file instead of renaming it into place.
func cmdDownloadFile(ctx context.Context, n *Node, params map[string]any) commandResult {
	token, _ := params["token"].(string)
	path, _ := params["path"].(string)
	wantSha, _ := params["sha256"].(string)
	if token == "" || path == "" {
		return fail("download_file needs token and path.")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fail("download_file failed: %v", err)
	}
	part := path + ".part"
	dst, err := os.Create(part)
	if err != nil {
		return fail("download_file failed: %v", err)
	}
	var out io.Writer = dst
	if n.cfg != nil {
		out = &limitWriter{w: dst, max: n.cfg.Policy.maxWriteBytes()}
	}
	hasher := sha256.New()
	written, err := n.downloadStream(ctx, token, io.MultiWriter(out, hasher))
	if closeErr := dst.Close(); err == nil {
		err = closeErr
	}
	got := hex.EncodeToString(hasher.Sum(nil))
	if err == nil {
		err = checkDigest(wantSha, got)
	}
	if err != nil {
		os.Remove(part)
		return fail("download_file failed: %v", err)
	}
	if err := os.Rename(part, path); err != nil {
		os.Remove(part)
		return fail("download_file failed: %v", err)
	}
	return okData(map[string]any{"bytesWritten": written, "sha256": got})
}

// checkDigest compares a pushed payload's hex SHA-256 with the expected one;
// an empty expectation (a daemon that predates transfer digests) passes.
func checkDigest(want, got string) error {
	want = strings.TrimSpace(want)
	if want == "" || strings.EqualFold(want, got) {
		return nil
	}
	return fmt.Errorf(
		"integrity check failed (expected sha256 %s, got %s) — the download was discarded",
		want, got,
	)
}

// ── helpers ──────────────────────────────────────────────────────────────────

func intParam(params map[string]any, key string, fallback int) int {
	switch v := params[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		var parsed int
		if _, err := fmt.Sscanf(v, "%d", &parsed); err == nil {
			return parsed
		}
	}
	return fallback
}
