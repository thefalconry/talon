package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// The daemon's restart notice: a `bye` frame on the event stream just
// before it ends, saying a successor is coming and when to be back.

func TestDecodeRestartNotice(t *testing.T) {
	var fx eventsFixture
	loadFixture(t, "events_v1.json", &fx)
	notices := 0
	for _, event := range fx.Events {
		raw, err := json.Marshal(event)
		if err != nil {
			t.Fatal(err)
		}
		after, ok := decodeRestartNotice("data: " + string(raw))
		if event["kind"] == "bye" && event["reason"] == "restart" {
			notices++
			if !ok || after != 5*time.Second {
				t.Fatalf("canonical restart notice decoded as (%s, %v): %s", after, ok, raw)
			}
		} else if ok {
			t.Fatalf("%q is not a restart notice", event["kind"])
		}
	}
	if notices == 0 {
		t.Fatal("events fixture has no restart notice")
	}

	for line, want := range map[string]time.Duration{
		`data: {"kind":"bye","reason":"restart"}`:                            0,
		`data: {"kind": "bye", "reason": "restart", "reconnectAfterMs": -5}`: 0,
		`data: {"kind":"bye","reason":"restart","reconnectAfterMs":250}`:     250 * time.Millisecond,
		`data: {"kind":"bye","reason":"restart","reconnectAfterMs":9e12}`:    maxRestartDelay,
	} {
		if after, ok := decodeRestartNotice(line); !ok || after != want {
			t.Errorf("%s: got (%s, %v), want (%s, true)", line, after, ok, want)
		}
	}
	for _, line := range []string{
		`data: {"kind":"bye","reason":"shutdown"}`,
		`data: {"kind":"error","message":"bye"}`,
		`data: {"kind":"bye"`,
		`: bye`,
		"",
	} {
		if _, ok := decodeRestartNotice(line); ok {
			t.Errorf("%q must not read as a restart notice", line)
		}
	}
}

func TestByeFrameResetsBackoff(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	notice := &bridgeRestarting{after: 5 * time.Second}

	// A node that has been failing for a while sits at the 30 s cap.
	wait, backoff, fastUntil := nextReconnect(maxReconnectBackoff, time.Time{}, time.Hour, notice, now)
	if wait != 5*time.Second || backoff != minReconnectBackoff {
		t.Fatalf("restart notice: wait %s backoff %s, want 5s and the minimum", wait, backoff)
	}
	// While the successor is still booting, connects fail at once; each
	// retry comes a second later instead of doubling.
	for i, at := range []time.Duration{6, 7, 9, 20, 100} {
		wait, backoff, fastUntil = nextReconnect(backoff, fastUntil, 0, errors.New("connection refused"), now.Add(at*time.Second))
		if wait != restartRetryInterval {
			t.Fatalf("retry %d inside the window waited %s", i, wait)
		}
	}
	// Past the window the usual backoff resumes, from the bottom.
	late := now.Add(5*time.Second + restartRetryWindow + time.Second)
	wait, backoff, fastUntil = nextReconnect(backoff, fastUntil, 0, errors.New("refused"), late)
	if wait != minReconnectBackoff || !fastUntil.IsZero() {
		t.Fatalf("after the window: wait %s fastUntil %v", wait, fastUntil)
	}
	wait, _, _ = nextReconnect(backoff, fastUntil, 0, errors.New("refused"), late)
	if wait != 2*minReconnectBackoff {
		t.Fatalf("backoff did not resume doubling: %s", wait)
	}

	// A stream that came back and stayed up closes the window.
	_, backoff, fastUntil = nextReconnect(maxReconnectBackoff, time.Time{}, 0, notice, now)
	_, _, fastUntil = nextReconnect(backoff, fastUntil, stableStreamAfter, errStreamIdle, now.Add(30*time.Second))
	if !fastUntil.IsZero() {
		t.Fatal("a stable stream must end the fast-retry window")
	}

	// Without a notice nothing changes: the plain backoff.
	wait, backoff, _ = nextReconnect(8*time.Second, time.Time{}, time.Second, errStreamIdle, now)
	if wait != 8*time.Second || backoff != 16*time.Second {
		t.Fatalf("no notice: wait %s next %s", wait, backoff)
	}
}

func TestConsumeEventsReportsTheRestartNotice(t *testing.T) {
	var shutdown atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/events" {
			_, _ = io.WriteString(w, `{"ok":true}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if shutdown.Load() {
			_, _ = io.WriteString(w, `data: {"kind":"bye","reason":"shutdown"}`+"\n\n")
			return
		}
		_, _ = io.WriteString(w, "retry: 3000\n\n")
		_, _ = io.WriteString(w, `data: {"kind":"hello","status":{},"chats":[]}`+"\n\n")
		_, _ = io.WriteString(w, `data: {"kind":"bye","reason":"restart","reconnectAfterMs":1500}`+"\n\n")
		// …and the daemon ends the stream.
	}))
	t.Cleanup(srv.Close)
	n := streamTestNode(t, srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := n.consumeEvents(ctx)
	var restarting *bridgeRestarting
	if !errors.As(err, &restarting) || restarting.after != 1500*time.Millisecond {
		t.Fatalf("err = %v, want a restart notice asking for 1.5s", err)
	}

	// A plain shutdown bye is just a closed stream.
	shutdown.Store(true)
	if _, err := n.consumeEvents(ctx); errors.As(err, &restarting) || err == nil {
		t.Fatalf("shutdown bye: err = %v, want a plain stream-closed error", err)
	}
}
