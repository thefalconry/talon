//go:build windows

package main

import (
	"strings"
	"testing"
	"unsafe"
)

// The struct size is what win32 checks dwLength against; a wrong layout
// makes GlobalMemoryStatusEx fail and the field silently disappear.
func TestMemoryStatusExSize(t *testing.T) {
	if got := unsafe.Sizeof(memoryStatusEx{}); got != 64 {
		t.Fatalf("size %d, want 64", got)
	}
}

func TestPlatformTelemetryLive(t *testing.T) {
	got := platformTelemetry()
	for _, key := range []string{"uptime", "memory", "disk"} {
		if got[key] == "" {
			t.Errorf("%s missing: %v", key, got)
		}
	}
	if !strings.Contains(got["disk"], " on ") {
		t.Errorf("disk: %q", got["disk"])
	}
	if _, present := got["load"]; present {
		t.Errorf("unexpected load: %q", got["load"])
	}
}
