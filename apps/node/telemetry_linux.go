//go:build linux

package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// platformTelemetry reads the classic /proc probes — no subprocesses, no
// cgo, works on any Linux including minimal images like DietPi.
func platformTelemetry() map[string]string {
	out := map[string]string{}
	if raw, err := os.ReadFile("/proc/uptime"); err == nil {
		if fields := strings.Fields(string(raw)); len(fields) > 0 {
			if secs, err := strconv.ParseFloat(fields[0], 64); err == nil {
				out["uptime"] = (time.Duration(secs) * time.Second).
					Round(time.Second).String()
			}
		}
	}
	if raw, err := os.ReadFile("/proc/loadavg"); err == nil {
		if fields := strings.Fields(string(raw)); len(fields) >= 3 {
			out["load"] = strings.Join(fields[:3], " ")
		}
	}
	if raw, err := os.ReadFile("/proc/meminfo"); err == nil {
		mem := map[string]uint64{}
		for _, line := range strings.Split(string(raw), "\n") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				if kb, err := strconv.ParseUint(fields[1], 10, 64); err == nil {
					mem[strings.TrimSuffix(fields[0], ":")] = kb * 1024
				}
			}
		}
		if total, ok := mem["MemTotal"]; ok {
			if avail, ok := mem["MemAvailable"]; ok {
				out["memory"] = fmt.Sprintf(
					"%s free of %s", formatBytes(avail), formatBytes(total),
				)
			}
		}
	}
	for k, v := range pendingUpdateTelemetry(rebootRequiredFile, rebootPkgsFile, updatesNoticeFile) {
		out[k] = v
	}
	if raw, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			if name, ok := strings.CutPrefix(line, "PRETTY_NAME="); ok {
				out["distro"] = strings.Trim(name, `"`)
				break
			}
		}
	}
	var fs syscall.Statfs_t
	if err := syscall.Statfs("/", &fs); err == nil {
		out["disk"] = fmt.Sprintf(
			"%s free of %s on /",
			formatBytes(fs.Bavail*uint64(fs.Bsize)),
			formatBytes(fs.Blocks*uint64(fs.Bsize)),
		)
	}
	return out
}
