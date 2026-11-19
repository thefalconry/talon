package main

import (
	"os"
	"path/filepath"
	"testing"
)

const esmNotice = `
Expanded Security Maintenance for Applications is not enabled.

0 updates can be applied immediately.

54 additional security updates can be applied with ESM Apps.
`

func TestParseUpdatesNotice(t *testing.T) {
	cases := []struct {
		name, in, want string
		ok             bool
	}{
		{"zero, ignoring ESM line", esmNotice, "0", true},
		{"plural", "12 updates can be applied immediately.\n", "12", true},
		{"singular", "1 update can be applied immediately.\n", "1", true},
		{"only ESM line", "54 additional security updates can be applied with ESM Apps.\n", "", false},
		{"empty", "", "", false},
	}
	for _, c := range cases {
		got, ok := parseUpdatesNotice(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("%s: got %q,%v want %q,%v", c.name, got, ok, c.want, c.ok)
		}
	}
}

func TestPendingUpdateTelemetry(t *testing.T) {
	dir := t.TempDir()
	reboot := filepath.Join(dir, "reboot-required")
	pkgs := filepath.Join(dir, "reboot-required.pkgs")
	notice := filepath.Join(dir, "updates-available")

	if got := pendingUpdateTelemetry(reboot, pkgs, notice); len(got) != 0 {
		t.Fatalf("no files must report nothing, got %v", got)
	}
	write := func(p, s string) {
		t.Helper()
		if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// A pkgs file alone, with no flag file, is not a pending reboot.
	write(pkgs, "linux-image-generic\nlibc6\n")
	if got := pendingUpdateTelemetry(reboot, pkgs, notice); len(got) != 0 {
		t.Fatalf("pkgs without flag must report nothing, got %v", got)
	}
	write(reboot, "*** System restart required ***\n")
	write(notice, "3 updates can be applied immediately.\n")
	got := pendingUpdateTelemetry(reboot, pkgs, notice)
	want := map[string]string{"rebootRequired": "true", "rebootRequiredBy": "2 packages", "updatesAvailable": "3"}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
}
