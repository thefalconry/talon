package main

import (
	"context"
	"sort"
	"strings"
	"sync"
)

// computer is desktop control for a node with a screen: look (screenshot,
// accessibility snapshot) and act (pointer, keyboard). It is one command
// with an `action` param rather than eight commands because the actions
// share a coordinate space and a policy switch, and because the registry
// caps a device at 16 advertised capabilities.
//
// Only macOS implements it today (computer_darwin.go); other platforms
// answer a clean "unsupported" and do not advertise the capability.
var computerActions = map[string]bool{
	"screenshot": true,
	"snapshot":   true,
	"click":      true,
	"move":       true,
	"drag":       true,
	"scroll":     true,
	"type":       true,
	"key":        true,
}

// computerParams are the only params forwarded to the platform driver, so a
// stray key from the wire can never reach it.
var computerParams = []string{
	"action", "x", "y", "toX", "toY", "dx", "dy", "button", "count",
	"modifiers", "text", "keys", "limit", "budgetMs", "maxEdge", "quality",
}

// computerMu serializes desktop actions: there is one pointer and one
// keyboard focus, and two interleaved clicks would both land wrong.
var computerMu sync.Mutex

func computerActionNames() string {
	names := make([]string, 0, len(computerActions))
	for name := range computerActions {
		names = append(names, name)
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

func cmdComputer(ctx context.Context, params map[string]any) commandResult {
	action, _ := params["action"].(string)
	if !computerActions[action] {
		return fail("computer: unknown action %q (one of: %s).", action, computerActionNames())
	}
	request := make(map[string]any, len(computerParams))
	for _, key := range computerParams {
		if v, ok := params[key]; ok {
			request[key] = v
		}
	}
	computerMu.Lock()
	defer computerMu.Unlock()
	return runComputer(ctx, action, request)
}

// computerPermissionHint turns the two macOS privacy refusals into the
// setting the host owner has to change; anything else passes through.
func computerPermissionHint(message string, trusted bool) string {
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(message, "-1743") || strings.Contains(lower, "not authorized to send apple events"):
		return message + " — allow talon-node to control System Events in System Settings › Privacy & Security › Automation."
	case strings.Contains(message, "-1719") || strings.Contains(message, "-25211") ||
		strings.Contains(lower, "assistive access"):
		return message + " — grant talon-node Accessibility in System Settings › Privacy & Security › Accessibility."
	case !trusted:
		return message + " (talon-node is not trusted for Accessibility on this Mac, which pointer and keyboard actions need: System Settings › Privacy & Security › Accessibility.)"
	}
	return message
}
