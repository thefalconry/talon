package main

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestComputerRejectsAnUnknownAction(t *testing.T) {
	for _, params := range []map[string]any{
		{},
		{"action": "reboot"},
		{"action": 7},
	} {
		result := cmdComputer(context.Background(), params)
		if result.OK {
			t.Fatalf("%v: expected a refusal", params)
		}
		if !strings.Contains(result.Message, "unknown action") ||
			!strings.Contains(result.Message, "screenshot") {
			t.Errorf("%v: refusal should name the valid actions, got %q", params, result.Message)
		}
	}
}

func TestComputerIsRoutedByDispatch(t *testing.T) {
	result := dispatch(context.Background(), nil, "computer", map[string]any{"action": "nope"})
	if strings.Contains(result.Message, "does not support") {
		t.Fatalf("dispatch has no case for computer: %s", result.Message)
	}
	if !strings.Contains(result.Message, "unknown action") {
		t.Fatalf("dispatch did not reach cmdComputer: %s", result.Message)
	}
}

func TestPolicyCanDisableComputer(t *testing.T) {
	p := Policy{DisableComputer: true}
	if err := p.check("computer", map[string]any{"action": "click"}, nil); !errors.Is(err, errPolicy) {
		t.Fatalf("expected a policy refusal, got %v", err)
	}
	if slices.Contains(p.capabilities(), "computer") {
		t.Fatalf("disabled computer still advertised: %v", p.capabilities())
	}
	if err := (Policy{}).check("computer", map[string]any{"action": "click"}, nil); err != nil {
		t.Fatalf("default policy refused computer: %v", err)
	}
	// Advertised exactly where the platform implements it.
	want := slices.Contains(platformCapabilities, "computer")
	if got := slices.Contains((Policy{}).capabilities(), "computer"); got != want {
		t.Fatalf("computer advertised = %v, platform implements = %v", got, want)
	}
}

func TestComputerAuditRecordsTheActionOnly(t *testing.T) {
	target := auditTarget("computer", map[string]any{
		"action": "type",
		"text":   "hunter2",
		"keys":   "cmd+v",
	})
	if target != "type" {
		t.Fatalf("computer target = %q", target)
	}
}

func TestComputerPermissionHint(t *testing.T) {
	cases := []struct {
		message string
		trusted bool
		want    string
	}{
		{"Error: Not authorized to send Apple events to System Events. (-1743)", true, "Automation"},
		{"System Events got an error: osascript is not allowed assistive access. (-1719)", true, "Accessibility"},
		{"click did nothing", false, "not trusted for Accessibility"},
	}
	for _, c := range cases {
		if got := computerPermissionHint(c.message, c.trusted); !strings.Contains(got, c.want) ||
			!strings.HasPrefix(got, c.message) {
			t.Errorf("hint(%q) = %q, want it to keep the message and mention %q", c.message, got, c.want)
		}
	}
	plain := `unknown key "hyper"`
	if got := computerPermissionHint(plain, true); got != plain {
		t.Errorf("an ordinary error was decorated: %q", got)
	}
}

func TestComputerHintsLinkTheExactPrivacyPane(t *testing.T) {
	shot := computerScreenCaptureHint("could not create image from display")
	for _, want := range []string{"could not create image from display", "Screen Recording", "?Privacy_ScreenCapture", "talon-node permissions"} {
		if !strings.Contains(shot, want) {
			t.Errorf("screen capture hint %q is missing %q", shot, want)
		}
	}
	for _, msg := range []string{"osascript is not allowed assistive access. (-1719)", "click did nothing"} {
		trusted := !strings.Contains(msg, "click")
		if got := computerPermissionHint(msg, trusted); !strings.Contains(got, "?Privacy_Accessibility") {
			t.Errorf("accessibility hint %q does not link the pane", got)
		}
	}
	if got := computerPermissionHint("Not authorized to send Apple events (-1743)", true); !strings.Contains(got, "?Privacy_Automation") {
		t.Errorf("automation hint %q does not link the pane", got)
	}
}
