//go:build darwin

package main

import "testing"

// Reads the real kernel values, so it only means something on a Mac.
func TestPlatformTelemetryDarwinReportsAllProbes(t *testing.T) {
	got := platformTelemetry()
	for _, key := range []string{"uptime", "load", "memory", "disk"} {
		if got[key] == "" {
			t.Errorf("%s missing: %v", key, got)
		}
	}
	t.Logf("%v", got)
}
