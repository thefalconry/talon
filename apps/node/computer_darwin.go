//go:build darwin

package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// computerDriver is the JXA script that does everything except the capture
// itself. It is passed to osascript inline, so nothing is written to disk.
//
//go:embed computer_darwin.js
var computerDriver string

// platformCapabilities: a Mac node can be driven like a desktop.
var platformCapabilities = []string{"computer"}

const (
	computerDriverTimeout = 30 * time.Second
	// A screenshot rides the command result as base64. Past this size it is
	// re-encoded harder so the result stays well inside the bridge's body
	// limit and the model's image budget.
	computerMaxImageBytes = 300 * 1024
)

// driverReply is what computer_darwin.js prints.
type driverReply struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Trusted bool   `json:"trusted"`
	Space   []int  `json:"space"`
}

func runComputer(ctx context.Context, action string, request map[string]any) commandResult {
	if action == "screenshot" {
		return computerScreenshot(ctx, request)
	}
	data, reply, err := runComputerDriver(ctx, request)
	if err != nil {
		return fail("computer %s: %v", action, err)
	}
	if !reply.OK {
		return fail("computer %s: %s", action, computerPermissionHint(reply.Error, reply.Trusted))
	}
	delete(data, "ok")
	return okData(data)
}

// runComputerDriver runs one request through the JXA driver and returns its
// reply both decoded (for the fields Go needs) and raw (to pass on).
func runComputerDriver(ctx context.Context, request map[string]any) (map[string]any, driverReply, error) {
	var reply driverReply
	payload, err := json.Marshal(request)
	if err != nil {
		return nil, reply, err
	}
	runCtx, cancel := context.WithTimeout(ctx, computerDriverTimeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, "/usr/bin/osascript", "-l", "JavaScript", "-e", computerDriver, string(payload))
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if runCtx.Err() == context.DeadlineExceeded {
			return nil, reply, fmt.Errorf("timed out after %s", computerDriverTimeout)
		}
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return nil, reply, fmt.Errorf("%s", computerPermissionHint(detail, true))
	}
	raw := bytes.TrimSpace(stdout.Bytes())
	data := map[string]any{}
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, reply, fmt.Errorf("driver answered something that is not JSON: %.200s", raw)
	}
	if err := json.Unmarshal(raw, &reply); err != nil {
		return nil, reply, fmt.Errorf("driver reply has the wrong shape: %v", err)
	}
	return data, reply, nil
}

// computerScreenshot captures the primary display and renders it at exactly
// the coordinate space's size, so image pixels are click coordinates.
func computerScreenshot(ctx context.Context, request map[string]any) commandResult {
	info := map[string]any{"action": "info"}
	if v, ok := request["maxEdge"]; ok {
		info["maxEdge"] = v
	}
	data, reply, err := runComputerDriver(ctx, info)
	if err != nil {
		return fail("computer screenshot: %v", err)
	}
	if !reply.OK {
		return fail("computer screenshot: %s", reply.Error)
	}
	if len(reply.Space) != 2 || reply.Space[0] <= 0 || reply.Space[1] <= 0 {
		return fail("computer screenshot: driver reported no display geometry.")
	}
	width, height := reply.Space[0], reply.Space[1]

	dir, err := os.MkdirTemp("", "talon-computer-")
	if err != nil {
		return fail("computer screenshot: %v", err)
	}
	defer os.RemoveAll(dir)
	shot := filepath.Join(dir, "shot.png")
	// -x no sound, -m primary display only, -C include the pointer.
	if out, err := runTool(ctx, "/usr/sbin/screencapture", "-x", "-m", "-C", "-t", "png", shot); err != nil {
		detail := strings.TrimSpace(out)
		if detail == "" {
			detail = err.Error()
		}
		return fail("computer screenshot: %s", computerScreenCaptureHint(detail))
	}

	quality := intParam(request, "quality", 70)
	if quality < 20 {
		quality = 20
	}
	if quality > 90 {
		quality = 90
	}
	scaled := filepath.Join(dir, "shot.jpg")
	var image []byte
	for {
		if out, err := runTool(ctx, "/usr/bin/sips",
			"-z", fmt.Sprint(height), fmt.Sprint(width),
			"-s", "format", "jpeg", "-s", "formatOptions", fmt.Sprint(quality),
			shot, "--out", scaled); err != nil {
			return fail("computer screenshot: sips failed: %v %s", err, out)
		}
		image, err = os.ReadFile(scaled)
		if err != nil {
			return fail("computer screenshot: %v", err)
		}
		if len(image) <= computerMaxImageBytes || quality <= 20 {
			break
		}
		quality -= 20
		if quality < 20 {
			quality = 20
		}
	}

	delete(data, "ok")
	data["base64"] = base64.StdEncoding.EncodeToString(image)
	data["mimeType"] = "image/jpeg"
	data["width"] = width
	data["height"] = height
	data["bytes"] = len(image)
	return okData(data)
}

func runTool(ctx context.Context, name string, args ...string) (string, error) {
	runCtx, cancel := context.WithTimeout(ctx, computerDriverTimeout)
	defer cancel()
	out, err := exec.CommandContext(runCtx, name, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}
