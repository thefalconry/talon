//go:build darwin

package main

import (
	"fmt"
	"syscall"
	"time"
)

// platformTelemetry uses sysctl and statfs from the stdlib: no cgo, no
// subprocesses. Each probe is omitted if it fails, as on Linux.
func platformTelemetry() map[string]string {
	out := map[string]string{}
	if raw, err := syscall.Sysctl("kern.boottime"); err == nil {
		if boot, ok := parseBootTime(raw); ok {
			out["uptime"] = time.Since(boot).Round(time.Second).String()
		}
	}
	if raw, err := syscall.Sysctl("vm.loadavg"); err == nil {
		if load, ok := parseLoadAvg(raw); ok {
			out["load"] = load
		}
	}
	if total, ok := sysctlUint("hw.memsize"); ok {
		if free, ok := darwinFreeMemory(); ok {
			out["memory"] = fmt.Sprintf(
				"%s free of %s", formatBytes(free), formatBytes(total),
			)
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

// darwinFreeMemory counts free, purgeable and speculative pages. It leaves
// out inactive file cache, so it reads lower than Linux's MemAvailable.
func darwinFreeMemory() (uint64, bool) {
	pageSize, ok := sysctlUint("hw.pagesize")
	if !ok {
		return 0, false
	}
	var pages uint64
	for _, name := range []string{
		"vm.page_free_count",
		"vm.page_purgeable_count",
		"vm.page_speculative_count",
	} {
		n, ok := sysctlUint(name)
		if !ok {
			return 0, false
		}
		pages += n
	}
	return pages * pageSize, true
}

// sysctlUint reads an integer sysctl of either width. syscall.SysctlUint32
// refuses anything but four bytes, and these names vary by kernel.
func sysctlUint(name string) (uint64, bool) {
	raw, err := syscall.Sysctl(name)
	if err != nil {
		return 0, false
	}
	return parseUint64(raw)
}
