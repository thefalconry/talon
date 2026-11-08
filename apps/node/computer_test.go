package main

import (
	"context"
	"errors"
	"fmt"
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

// fakeJPEG sizes an "encoding" like JPEG does: proportional to pixel count,
// and smaller at lower quality.
func fakeJPEG(bytesPerPixelAt100 float64, calls *[]string) imageEncoder {
	return func(w, h, quality int) ([]byte, error) {
		*calls = append(*calls, fmt.Sprintf("%dx%d@%d", w, h, quality))
		n := int(float64(w*h) * bytesPerPixelAt100 * float64(quality) / 100)
		return make([]byte, n), nil
	}
}

func TestFitImageKeepsTheSpaceWhenItFits(t *testing.T) {
	var calls []string
	got, err := fitImage(1280, 720, 70, 300*1024, fakeJPEG(0.2, &calls))
	if err != nil {
		t.Fatal(err)
	}
	if got.width != 1280 || got.height != 720 || got.scale != 1 || got.quality != 70 {
		t.Fatalf("got %dx%d scale %v quality %d", got.width, got.height, got.scale, got.quality)
	}
	if len(calls) != 1 {
		t.Fatalf("encoded %d times for an image that fit at once: %v", len(calls), calls)
	}
}

func TestFitImageLowersQualityBeforeShrinking(t *testing.T) {
	var calls []string
	// 1280x720 at q70 is ~380 KB, at q50 ~270 KB: quality alone fits it.
	got, err := fitImage(1280, 720, 70, 300*1024, fakeJPEG(0.6, &calls))
	if err != nil {
		t.Fatal(err)
	}
	if got.width != 1280 || got.scale != 1 || got.quality != 50 {
		t.Fatalf("got %dx%d quality %d (calls %v)", got.width, got.height, got.quality, calls)
	}
}

func TestFitImageShrinksABusyScreenUntilItFits(t *testing.T) {
	var calls []string
	const limit = 256 * 1024
	got, err := fitImage(1280, 831, 70, limit, fakeJPEG(3, &calls))
	if err != nil {
		t.Fatalf("%v (calls %v)", err, calls)
	}
	if len(got.data) > limit {
		t.Fatalf("returned %d bytes over a %d cap", len(got.data), limit)
	}
	if got.width >= 1280 || got.scale <= 1 {
		t.Fatalf("expected a shrunk image, got %dx%d scale %v", got.width, got.height, got.scale)
	}
	// The aspect ratio survives, so scale maps both axes back to the space.
	if diff := float64(got.width)*got.scale - 1280; diff > 2 || diff < -2 {
		t.Fatalf("width %d x scale %v is not the 1280 space", got.width, got.scale)
	}
	if diff := float64(got.height)*got.scale - 831; diff > 3 || diff < -3 {
		t.Fatalf("height %d x scale %v is not the 831 space", got.height, got.scale)
	}
	if len(calls) > 8 {
		t.Fatalf("took %d encodes: %v", len(calls), calls)
	}
}

func TestFitImageSaysWhenNothingFits(t *testing.T) {
	var calls []string
	_, err := fitImage(1280, 720, 70, 1024, fakeJPEG(5, &calls))
	if err == nil || !strings.Contains(err.Error(), "does not fit") {
		t.Fatalf("expected a clear refusal, got %v (calls %v)", err, calls)
	}
	last := calls[len(calls)-1]
	if !strings.HasSuffix(last, fmt.Sprintf("@%d", fitLastQuality)) || !strings.HasPrefix(last, "320x") {
		t.Fatalf("gave up before the smallest size and lowest quality: %v", calls)
	}
}

func TestFitImagePassesEncoderErrorsThrough(t *testing.T) {
	_, err := fitImage(100, 100, 70, 1024, func(int, int, int) ([]byte, error) {
		return nil, errors.New("sips exploded")
	})
	if err == nil || !strings.Contains(err.Error(), "sips exploded") {
		t.Fatalf("got %v", err)
	}
}

func TestComputerForwardsTheNewParams(t *testing.T) {
	for _, key := range []string{"scope", "verify", "settleMs", "maxBytes"} {
		if !slices.Contains(computerParams, key) {
			t.Errorf("computer does not forward %q to the driver", key)
		}
	}
}
