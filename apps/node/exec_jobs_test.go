package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

func execDetach(t *testing.T, cmd string, timeoutMs int) commandResult {
	t.Helper()
	return dispatch(context.Background(), nil, "exec", map[string]any{
		"cmd": cmd, "timeoutMs": float64(timeoutMs), "detachOnTimeout": true,
	})
}

func pollJob(t *testing.T, id string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		res := dispatch(context.Background(), nil, "exec_job", map[string]any{"jobId": id})
		if !res.OK {
			t.Fatalf("exec_job: %s", res.Message)
		}
		data := res.Data
		if data["running"] == false {
			return data
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("job never finished")
	return nil
}

func TestExecDetachesAtBudgetAndCommandFinishes(t *testing.T) {
	res := execDetach(t, "echo early; sleep 2; echo late; exit 7", 1000)
	data := res.Data
	if data["detached"] != true {
		t.Fatalf("not detached: %+v", res)
	}
	if !strings.Contains(data["stdout"].(string), "early") {
		t.Errorf("output so far missing: %q", data["stdout"])
	}
	final := pollJob(t, data["jobId"].(string))
	if final["exitCode"] != 7 {
		t.Errorf("exitCode = %v, want 7: the command must run to its end", final["exitCode"])
	}
	if !strings.Contains(final["stdout"].(string), "late") {
		t.Errorf("output after detaching lost: %q", final["stdout"])
	}
}

func TestExecDetachFastCommandStaysAttached(t *testing.T) {
	res := execDetach(t, "echo hi", 5000)
	data := res.Data
	if data["detached"] != nil || data["exitCode"] != 0 || !res.OK {
		t.Fatalf("fast command should answer normally: %+v", res)
	}
}

func TestExecJobKill(t *testing.T) {
	res := execDetach(t, "sleep 30", 1000)
	id := res.Data["jobId"].(string)
	started := time.Now()
	killed := dispatch(context.Background(), nil, "exec_job", map[string]any{"jobId": id, "action": "kill"})
	if !killed.OK || killed.Data["running"] != false {
		t.Fatalf("kill: %+v", killed)
	}
	if time.Since(started) > 10*time.Second {
		t.Error("kill waited for the command instead of stopping it")
	}
}

func TestExecWithoutDetachStillKillsAtBudget(t *testing.T) {
	res := dispatch(context.Background(), nil, "exec", map[string]any{"cmd": "sleep 30", "timeoutMs": float64(1000)})
	if res.OK || res.Message != "Command timed out." {
		t.Fatalf("default must stay kill-on-timeout: %+v", res)
	}
}

func TestExecJobTableFullKillsAtBudget(t *testing.T) {
	var fill []*execJob
	now := time.Now()
	for i := 0; i < maxRunningExecJobs; i++ {
		id, _ := newExecJobID()
		j := &execJob{id: id, done: make(chan struct{}), cancel: func() {}}
		if !execJobs.add(j, now) {
			t.Fatal("table filled too soon")
		}
		fill = append(fill, j)
	}
	defer func() {
		for _, j := range fill {
			close(j.done)
			execJobs.mu.Lock()
			delete(execJobs.jobs, j.id)
			execJobs.mu.Unlock()
		}
	}()
	res := execDetach(t, "sleep 30", 1000)
	data := res.Data
	if data["detached"] != nil || res.OK || res.Message != "Command timed out." {
		t.Fatalf("full table must fall back to kill: %+v", res)
	}
}

func TestExecJobRefusedWhenExecDisabled(t *testing.T) {
	p := Policy{DisableExec: true}
	if err := p.check("exec_job", map[string]any{"jobId": "x"}, nil); err == nil {
		t.Error("exec_job must follow DisableExec")
	}
	for _, c := range p.capabilities() {
		if c == "exec_job" {
			t.Error("exec_job advertised with exec disabled")
		}
	}
}

func TestExecJobUnknownAndExpired(t *testing.T) {
	if res := dispatch(context.Background(), nil, "exec_job", map[string]any{"jobId": "job_nope"}); res.OK {
		t.Error("unknown job must fail")
	}
	old := &execJob{id: "job_old", done: make(chan struct{}), finished: time.Now().Add(-2 * finishedExecJobTTL)}
	close(old.done)
	execJobs.mu.Lock()
	execJobs.jobs[old.id] = old
	execJobs.mu.Unlock()
	newer := &execJob{id: "job_new", done: make(chan struct{}), cancel: func() {}}
	close(newer.done)
	newer.finished = time.Now()
	execJobs.add(newer, time.Now())
	if execJobs.get("job_old") != nil {
		t.Error("expired job not pruned")
	}
	execJobs.mu.Lock()
	delete(execJobs.jobs, "job_new")
	execJobs.mu.Unlock()
}

func TestKillAllDoesNotHangOnAJobThatNeverFinishes(t *testing.T) {
	saved := killAllWait
	killAllWait = 200 * time.Millisecond
	defer func() { killAllWait = saved }()
	stuck := &execJob{id: "job_stuck", done: make(chan struct{}), cancel: func() {}}
	execJobs.mu.Lock()
	execJobs.jobs[stuck.id] = stuck
	execJobs.mu.Unlock()
	defer func() {
		execJobs.mu.Lock()
		delete(execJobs.jobs, stuck.id)
		execJobs.mu.Unlock()
	}()

	returned := make(chan struct{})
	go func() {
		execJobs.killAll()
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("killAll waited on a job that never reports done")
	}
}

func TestExecJobReportsALifetimeKill(t *testing.T) {
	j := &execJob{
		id:       "job_lifetime",
		started:  time.Now().Add(-time.Hour),
		stdout:   &cappedOutput{},
		stderr:   &cappedOutput{},
		done:     make(chan struct{}),
		cancel:   func() {},
		exitCode: -1,
		timedOut: true,
		finished: time.Now(),
	}
	close(j.done)
	execJobs.mu.Lock()
	execJobs.jobs[j.id] = j
	execJobs.mu.Unlock()
	defer func() {
		execJobs.mu.Lock()
		delete(execJobs.jobs, j.id)
		execJobs.mu.Unlock()
	}()

	res := dispatch(context.Background(), nil, "exec_job", map[string]any{"jobId": j.id})
	if !res.OK || res.Data["timedOut"] != true {
		t.Fatalf("a job killed at its lifetime must say so: %+v", res)
	}
	if !strings.HasSuffix(res.Data["stderr"].(string), "[killed: timeout]") {
		t.Errorf("stderr = %q, want the timeout note", res.Data["stderr"])
	}
}
