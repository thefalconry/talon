//go:build linux

package main

import "testing"

func TestHardenProcessClearsDumpable(t *testing.T) {
	hardenProcess()
	v, err := processDumpable()
	if err != nil {
		t.Fatalf("PR_GET_DUMPABLE: %v", err)
	}
	if v != 0 {
		t.Fatalf("process still dumpable (%d)", v)
	}
}
