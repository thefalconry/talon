package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

// A foreground exec with detachOnTimeout set is not killed when its budget
// lapses: it keeps running here as a job the daemon can poll or kill through
// exec_job. Jobs live in memory, so a node restart forgets them.
const (
	// maxExecJobLifetime is the hard stop for a detached command.
	maxExecJobLifetime = 24 * time.Hour
	// maxRunningExecJobs bounds what the mesh can leave running. Past it a
	// timeout kills the command as it would without detachOnTimeout.
	maxRunningExecJobs = 16
	// finishedExecJobTTL is how long a finished job's result stays readable.
	finishedExecJobTTL = time.Hour
)

type execJob struct {
	id      string
	started time.Time
	stdout  *cappedOutput
	stderr  *cappedOutput
	cancel  context.CancelFunc
	done    chan struct{}

	// Written before done closes; read only after.
	exitCode int
	runErr   error
	timedOut bool
	finished time.Time
}

func (j *execJob) isDone() bool {
	select {
	case <-j.done:
		return true
	default:
		return false
	}
}

type execJobTable struct {
	mu   sync.Mutex
	jobs map[string]*execJob
}

var execJobs = &execJobTable{jobs: map[string]*execJob{}}

// add registers a job and reports false when too many are already running.
func (t *execJobTable) add(j *execJob, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	running := 0
	for id, other := range t.jobs {
		if !other.isDone() {
			running++
		} else if now.Sub(other.finished) > finishedExecJobTTL {
			delete(t.jobs, id)
		}
	}
	if running >= maxRunningExecJobs {
		return false
	}
	t.jobs[j.id] = j
	return true
}

func (t *execJobTable) get(id string) *execJob {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.jobs[id]
}

// killAllWait bounds how long killAll waits for the jobs it stopped. A job
// whose command left a process holding its output pipes (Windows kills only
// powershell.exe, not the tree) may not report done promptly, and node
// shutdown and self-update must not hang on it. A var so tests can shorten it.
var killAllWait = 5 * time.Second

// killAll stops every running job and waits for them, up to killAllWait in
// total, for node shutdown and self-update.
func (t *execJobTable) killAll() {
	t.mu.Lock()
	jobs := make([]*execJob, 0, len(t.jobs))
	for _, j := range t.jobs {
		jobs = append(jobs, j)
	}
	t.mu.Unlock()
	for _, j := range jobs {
		j.cancel()
	}
	deadline := time.NewTimer(killAllWait)
	defer deadline.Stop()
	for _, j := range jobs {
		select {
		case <-j.done:
		case <-deadline.C:
			return
		}
	}
}

func newExecJobID() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "job_" + hex.EncodeToString(b[:]), nil
}

// execDetachable runs cmdline attached for budget, then hands it to the job
// table instead of killing it. The command runs under its own context because
// the caller's ending must not end a job that has already detached.
func execDetachable(ctx context.Context, cmdline, cwd string, budget time.Duration) commandResult {
	id, err := newExecJobID()
	if err != nil {
		return fail("Failed to run command: %v", err)
	}
	jobCtx, cancel := context.WithCancel(context.Background())
	j := &execJob{
		id:      id,
		started: time.Now(),
		stdout:  &cappedOutput{},
		stderr:  &cappedOutput{},
		cancel:  cancel,
		done:    make(chan struct{}),
	}
	go func() {
		defer cancel()
		j.exitCode, j.timedOut, j.runErr = runShell(jobCtx, cmdline, cwd, maxExecJobLifetime, j.stdout, j.stderr)
		j.finished = time.Now()
		close(j.done)
	}()

	timer := time.NewTimer(budget)
	defer timer.Stop()
	select {
	case <-j.done:
		return attachedResult(j, false)
	case <-ctx.Done():
		cancel()
		<-j.done
		return attachedResult(j, false)
	case <-timer.C:
	}
	if !execJobs.add(j, time.Now()) {
		cancel()
		<-j.done
		// The job may have finished by itself in that instant; a command
		// that exited cleanly did not time out.
		return attachedResult(j, true)
	}
	return commandResult{
		OK:      true,
		Message: "Command still running; detached as a job.",
		Data: map[string]any{
			"stdout":   j.stdout.String(),
			"stderr":   j.stderr.String(),
			"detached": true,
			"jobId":    j.id,
		},
	}
}

// attachedResult shapes a command that ended before detaching. killedAtBudget
// is the job table being full: the budget lapsed and the command was killed.
func attachedResult(j *execJob, killedAtBudget bool) commandResult {
	if j.runErr != nil {
		return fail("Failed to run command: %v", j.runErr)
	}
	timedOut := j.timedOut || (killedAtBudget && j.exitCode != 0)
	errText := j.stderr.String()
	if timedOut {
		if errText != "" {
			errText += "\n"
		}
		errText += "[killed: timeout]"
	}
	result := commandResult{
		OK: !timedOut && j.exitCode == 0,
		Data: map[string]any{
			"stdout":   j.stdout.String(),
			"stderr":   errText,
			"exitCode": j.exitCode,
		},
	}
	if timedOut {
		result.Message = "Command timed out."
	}
	return result
}

// cmdExecJob reads (action "status", the default) or kills a detached job.
func cmdExecJob(params map[string]any) commandResult {
	id, _ := params["jobId"].(string)
	if id == "" {
		return fail("No jobId.")
	}
	j := execJobs.get(id)
	if j == nil {
		return fail("No such job: %s (it may have expired, or the node restarted).", id)
	}
	action, _ := params["action"].(string)
	switch action {
	case "", "status":
	case "kill":
		j.cancel()
		select {
		case <-j.done:
		case <-time.After(5 * time.Second):
			return fail("Job %s did not stop within 5s.", id)
		}
	default:
		return fail("Unknown action: %s", fmt.Sprint(action))
	}
	data := map[string]any{
		"jobId":   j.id,
		"running": !j.isDone(),
		"stdout":  j.stdout.String(),
		"stderr":  j.stderr.String(),
	}
	if j.isDone() {
		data["exitCode"] = j.exitCode
		data["runtimeMs"] = j.finished.Sub(j.started).Milliseconds()
		if j.runErr != nil {
			data["error"] = j.runErr.Error()
		}
		// Killed at maxExecJobLifetime: say so, as attachedResult does, so an
		// exit -1 is not read as the command's own crash.
		if j.timedOut {
			data["timedOut"] = true
			if stderr := j.stderr.String(); stderr != "" {
				data["stderr"] = stderr + "\n[killed: timeout]"
			} else {
				data["stderr"] = "[killed: timeout]"
			}
		}
	} else {
		data["runtimeMs"] = time.Since(j.started).Milliseconds()
	}
	return commandResult{OK: true, Data: data}
}
