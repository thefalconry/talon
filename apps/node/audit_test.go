package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestAuditRecordsAndReadsBackInOrder(t *testing.T) {
	path := filepath.Join(t.TempDir(), auditFileName)
	a := newAuditLog(path)
	for i := 0; i < 3; i++ {
		a.record(auditEntry{CommandID: fmt.Sprintf("c%d", i), Name: "stat", OK: true})
	}
	got, err := readAudit(path, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].CommandID != "c0" || got[2].CommandID != "c2" {
		t.Fatalf("entries = %+v", got)
	}
	if tail, _ := readAudit(path, 2); len(tail) != 2 || tail[0].CommandID != "c1" {
		t.Fatalf("tail = %+v", tail)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if mode := info.Mode().Perm(); mode != 0o600 {
			t.Fatalf("audit file mode %o, want 600", mode)
		}
	}
}

func TestAuditNarrowsAPreExistingFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permissions")
	}
	path := filepath.Join(t.TempDir(), auditFileName)
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	newAuditLog(path).record(auditEntry{CommandID: "c", Name: "ring", OK: true})
	info, _ := os.Stat(path)
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("audit file mode %o, want 600", mode)
	}
}

func TestAuditRingStaysBounded(t *testing.T) {
	path := filepath.Join(t.TempDir(), auditFileName)
	a := newAuditLog(path)
	a.keep = 5
	for i := 0; i < 23; i++ {
		a.record(auditEntry{CommandID: fmt.Sprintf("c%d", i), Name: "exec", OK: true})
	}
	if n := countLines(path); n >= 2*a.keep {
		t.Fatalf("file holds %d lines, bound is < %d", n, 2*a.keep)
	}
	got, _ := readAudit(path, 0)
	if last := got[len(got)-1].CommandID; last != "c22" {
		t.Fatalf("newest entry lost: last = %s", last)
	}
	if len(got) < a.keep {
		t.Fatalf("compaction kept %d entries, want at least %d", len(got), a.keep)
	}
}

func TestAuditRingCountsAnExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), auditFileName)
	first := newAuditLog(path)
	first.keep = 4
	for i := 0; i < 6; i++ {
		first.record(auditEntry{CommandID: fmt.Sprintf("a%d", i), Name: "stat", OK: true})
	}
	// A restarted node picks up the line count instead of growing unbounded.
	second := newAuditLog(path)
	second.keep = 4
	for i := 0; i < 6; i++ {
		second.record(auditEntry{CommandID: fmt.Sprintf("b%d", i), Name: "stat", OK: true})
	}
	if n := countLines(path); n >= 2*second.keep {
		t.Fatalf("file holds %d lines after restart, bound is < %d", n, 2*second.keep)
	}
}

func TestAuditIsSafeForConcurrentWorkers(t *testing.T) {
	path := filepath.Join(t.TempDir(), auditFileName)
	a := newAuditLog(path)
	a.keep = 20
	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 25; i++ {
				a.record(auditEntry{CommandID: fmt.Sprintf("w%d-%d", w, i), Name: "exec", OK: true})
			}
		}(w)
	}
	wg.Wait()
	got, err := readAudit(path, 0)
	if err != nil || len(got) == 0 || len(got) >= 2*a.keep {
		t.Fatalf("entries %d, err %v", len(got), err)
	}
}

func TestAuditFailureIsSwallowed(t *testing.T) {
	// The parent "directory" is a file, so every write fails.
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	newAuditLog(filepath.Join(blocker, auditFileName)).record(auditEntry{Name: "exec"})
	var nilLog *auditLog
	nilLog.record(auditEntry{Name: "exec"})
}

func TestReadAuditMissingFileIsEmpty(t *testing.T) {
	got, err := readAudit(filepath.Join(t.TempDir(), "nope.jsonl"), 10)
	if err != nil || len(got) != 0 {
		t.Fatalf("got %v, %v", got, err)
	}
}

func TestAuditTargetNeverRecordsContent(t *testing.T) {
	secret := "curl -H 'Authorization: Bearer hunter2' https://example"
	target := auditTarget("exec", map[string]any{"cmd": secret})
	if !strings.HasPrefix(target, "sha256:") || len(target) != len("sha256:")+64 {
		t.Fatalf("exec target = %q", target)
	}
	if strings.Contains(target, "hunter2") {
		t.Fatal("exec command line leaked into the audit")
	}
	if again := auditTarget("exec", map[string]any{"cmd": secret}); again != target {
		t.Fatal("exec hash is not stable")
	}

	write := auditTarget("write_file", map[string]any{"path": "/srv/a", "base64": "c2VjcmV0"})
	if write != "/srv/a" {
		t.Fatalf("write_file target = %q", write)
	}
	if got := auditTarget("move", map[string]any{"from": "/a", "to": "/b"}); got != "/a -> /b" {
		t.Fatalf("move target = %q", got)
	}
	if got := auditTarget("status", map[string]any{}); got != "" {
		t.Fatalf("status target = %q", got)
	}
}

func TestAuditCredentialNeverRecordsTheSecret(t *testing.T) {
	cred := "tdc1.0123456789abcdef." + strings.Repeat("A", 43)
	if got := auditCredential(cred); got != "device:0123456789abcdef" {
		t.Fatalf("device credential = %q", got)
	}
	if got := auditCredential("shared-secret"); got != "shared" {
		t.Fatalf("shared token = %q", got)
	}
	if got := auditCredential(""); got != "none" {
		t.Fatalf("no token = %q", got)
	}
}

func TestNewAuditEntryClipsErrors(t *testing.T) {
	result := fail("%s", strings.Repeat("é", 400))
	e := newAuditEntry("c1", "stat", nil, result, 1500*time.Millisecond, "")
	if e.OK || e.DurationMs != 1500 || e.Credential != "none" {
		t.Fatalf("entry = %+v", e)
	}
	if len(e.Error) > auditMaxError+len("…") || !strings.HasSuffix(e.Error, "…") {
		t.Fatalf("error not clipped: %d bytes", len(e.Error))
	}
	if !json.Valid([]byte(`"` + e.Error + `"`)) {
		t.Fatal("clip split a rune")
	}
}

// resultSink is a bridge that only accepts command results.
func resultSink(t *testing.T) (*httptest.Server, <-chan map[string]any) {
	t.Helper()
	results := make(chan map[string]any, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		results <- body
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	t.Cleanup(srv.Close)
	return srv, results
}

func TestHandleCommandWritesTheAudit(t *testing.T) {
	srv, results := resultSink(t)
	n := streamTestNode(t, srv.URL)
	file := filepath.Join(t.TempDir(), "probe.txt")
	if err := os.WriteFile(file, []byte("content"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	n.handleCommand(ctx, map[string]any{"id": "c1", "name": "stat", "params": map[string]any{"path": file}})
	n.handleCommand(ctx, map[string]any{"id": "c2", "name": "teleport_me"})
	<-results
	<-results

	got, err := readAudit(auditPath(n.cfg.Path), 0)
	if err != nil || len(got) != 2 {
		t.Fatalf("audit = %+v, %v", got, err)
	}
	if got[0].CommandID != "c1" || !got[0].OK || got[0].Target != file || got[0].Credential != "shared" {
		t.Fatalf("first entry = %+v", got[0])
	}
	if got[1].OK || !strings.Contains(got[1].Error, "does not support") {
		t.Fatalf("second entry = %+v", got[1])
	}
}

func TestHandleCommandAnswersWhenTheAuditCannotBeWritten(t *testing.T) {
	srv, results := resultSink(t)
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	n := testNode(t, srv.URL, "test-token", filepath.Join(blocker, "config.json"))
	n.handleCommand(context.Background(), map[string]any{"id": "c1", "name": "status"})
	select {
	case body := <-results:
		if body["commandId"] != "c1" || body["ok"] != true {
			t.Fatalf("result = %v", body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("command was not answered")
	}
}
