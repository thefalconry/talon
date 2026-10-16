//go:build darwin

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"image/jpeg"
	"os"
	"testing"
)

// The live test drives the real desktop, so it only runs when asked:
//
//	TALON_COMPUTER_LIVE=1 go test -run TestComputerLive ./...
//
// It needs the same Screen Recording, Accessibility and Automation grants
// the node itself needs, and it moves the pointer (it does not click).
func TestComputerLive(t *testing.T) {
	if os.Getenv("TALON_COMPUTER_LIVE") == "" {
		t.Skip("set TALON_COMPUTER_LIVE=1 to drive the real desktop")
	}
	ctx := context.Background()

	shot := cmdComputer(ctx, map[string]any{"action": "screenshot"})
	if !shot.OK {
		t.Fatalf("screenshot: %s", shot.Message)
	}
	raw, err := base64.StdEncoding.DecodeString(shot.Data["base64"].(string))
	if err != nil {
		t.Fatalf("screenshot is not base64: %v", err)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("screenshot is not a JPEG: %v", err)
	}
	width, height := shot.Data["width"].(int), shot.Data["height"].(int)
	if cfg.Width != width || cfg.Height != height {
		t.Fatalf("image is %dx%d but the space is %dx%d — pixels would not be click coordinates",
			cfg.Width, cfg.Height, width, height)
	}
	if len(raw) > computerMaxImageBytes && shot.Data["bytes"].(int) != len(raw) {
		t.Fatalf("oversized screenshot: %d bytes", len(raw))
	}
	t.Logf("screenshot %dx%d, %d bytes", width, height, len(raw))

	x, y := float64(width/2), float64(height/2)
	moved := cmdComputer(ctx, map[string]any{"action": "move", "x": x, "y": y})
	if !moved.OK {
		t.Fatalf("move: %s", moved.Message)
	}
	cursor, _ := moved.Data["cursor"].([]any)
	if len(cursor) != 2 || cursor[0].(float64) != x || cursor[1].(float64) != y {
		t.Fatalf("pointer is at %v after moving to (%v,%v)", cursor, x, y)
	}

	// A tight cap forces the shrink path; the result must still fit and say
	// how image pixels map back to the space.
	small := cmdComputer(ctx, map[string]any{"action": "screenshot", "maxBytes": 40 * 1024})
	if !small.OK {
		t.Fatalf("small screenshot: %s", small.Message)
	}
	smallRaw, _ := base64.StdEncoding.DecodeString(small.Data["base64"].(string))
	if len(smallRaw) > 40*1024 {
		t.Fatalf("a 40 KB cap returned %d bytes", len(smallRaw))
	}
	smallScale := small.Data["scale"].(float64)
	if got := float64(small.Data["width"].(int)) * smallScale; got < float64(width)-2 || got > float64(width)+2 {
		t.Fatalf("image width %v x scale %v does not map back to the %d space", small.Data["width"], smallScale, width)
	}
	t.Logf("40 KB screenshot: %vx%v scale %v quality %v, %d bytes",
		small.Data["width"], small.Data["height"], smallScale, small.Data["quality"], len(smallRaw))

	all := cmdComputer(ctx, map[string]any{"action": "snapshot", "scope": "all", "limit": 60})
	if !all.OK {
		t.Fatalf("snapshot scope all: %s", all.Message)
	}
	system, _ := all.Data["system"].(map[string]any)
	extras, _ := system["extras"].([]any)
	if len(extras) == 0 {
		t.Fatalf("scope all found no menu bar extras: %v", system)
	}
	t.Logf("scope all: %d extras, %d windows, %d system elements",
		len(extras), len(system["windows"].([]any)), len(system["elements"].([]any)))

	snap := cmdComputer(ctx, map[string]any{"action": "snapshot", "limit": 40})
	if !snap.OK {
		t.Fatalf("snapshot: %s", snap.Message)
	}
	t.Logf("front app %v, window %q, %d elements",
		snap.Data["app"], snap.Data["window"], len(snap.Data["elements"].([]any)))

	outside := cmdComputer(ctx, map[string]any{"action": "click", "x": float64(width + 50), "y": 1.0})
	if outside.OK {
		t.Fatal("a click outside the space was accepted")
	}
}
