package main

import (
	"slices"
	"testing"
)

func TestTaskCreateArgsRunsAsTheInstallingUser(t *testing.T) {
	args := taskCreateArgs(`HOST\ada`, `C:\Users\ada\AppData\Local\talon-node\talon-node.exe`, `C:\cfg.json`)
	i := slices.Index(args, "/RU")
	if i < 0 || i+1 >= len(args) || args[i+1] != `HOST\ada` {
		t.Fatalf("task must run as the installing user, got %q", args)
	}
	if slices.Contains(args, "SYSTEM") {
		t.Fatalf("task must never run as SYSTEM: %q", args)
	}
	if !slices.Contains(args, "/NP") {
		t.Fatalf("task must not store a password: %q", args)
	}
	tr := args[slices.Index(args, "/TR")+1]
	want := `"C:\Users\ada\AppData\Local\talon-node\talon-node.exe" run --config "C:\cfg.json"`
	if tr != want {
		t.Fatalf("/TR = %q, want %q", tr, want)
	}
}

func TestIsSystemAccount(t *testing.T) {
	cases := []struct {
		sid, name string
		want      bool
	}{
		{"S-1-5-18", "", true},
		{"", `NT AUTHORITY\SYSTEM`, true},
		{"", "SYSTEM", true},
		{"S-1-5-21-1-2-3-1001", `HOST\ada`, false},
		{"", `HOST\system-admin`, false},
	}
	for _, c := range cases {
		if got := isSystemAccount(c.sid, c.name); got != c.want {
			t.Errorf("isSystemAccount(%q, %q) = %v, want %v", c.sid, c.name, got, c.want)
		}
	}
}

func TestTaskRunsAsSystem(t *testing.T) {
	legacy := "TaskName:      \\TalonNode\r\nStatus:        Running\r\nRun As User:   SYSTEM\r\n"
	if !taskRunsAsSystem(legacy) {
		t.Fatal("a SYSTEM task was not recognised")
	}
	current := "TaskName:      \\TalonNode\r\nRun As User:   HOST\\ada\r\n"
	if taskRunsAsSystem(current) {
		t.Fatal("a user task was reported as SYSTEM")
	}
	if taskRunsAsSystem("") {
		t.Fatal("empty output reported as SYSTEM")
	}
}
