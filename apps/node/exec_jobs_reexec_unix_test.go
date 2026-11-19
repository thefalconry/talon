//go:build !windows

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// execve drops the job table, so a job still running at that point has nothing
// left to report on it, kill it, or enforce its 24h limit. This runs a real
// execve in a child test process and checks the command did not outlive it.
func TestReexecLeavesNoDetachedJobBehind(t *testing.T) {
	const env = "TALON_TEST_REEXEC_PIDFILE"
	if pidFile := os.Getenv(env); pidFile != "" {
		if _, err := os.Stat(pidFile); err == nil {
			return // second life, after the execve
		}
		res := execDetachable(context.Background(),
			"echo $$ > '"+pidFile+"'; exec sleep 60", "", 300*time.Millisecond)
		if res.Data["detached"] != true {
			t.Fatalf("not detached: %+v", res)
		}
		reexecInto(nil)
		t.Fatal("execve did not happen")
	}

	pidFile := filepath.Join(t.TempDir(), "pid")
	cmd := exec.Command(os.Args[0], "-test.run=^TestReexecLeavesNoDetachedJobBehind$")
	cmd.Env = append(os.Environ(), env+"="+pidFile)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("child: %v\n%s", err, out)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("job never started: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	if syscall.Kill(pid, 0) == nil {
		syscall.Kill(-pid, syscall.SIGKILL) //nolint:errcheck
		t.Fatalf("job %d is still running after the node re-executed", pid)
	}
}
