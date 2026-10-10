//go:build !darwin

package main

import "context"

// platformCapabilities lists commands only some platforms implement; none
// here, so this node does not advertise `computer`.
var platformCapabilities []string

func runComputer(_ context.Context, _ string, _ map[string]any) commandResult {
	return fail("computer is only available on macOS nodes.")
}
