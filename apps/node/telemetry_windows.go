//go:build windows

package main

import (
	"os"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32                 = syscall.NewLazyDLL("kernel32.dll")
	procGetTickCount64       = kernel32.NewProc("GetTickCount64")
	procGlobalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
	procGetDiskFreeSpaceExW  = kernel32.NewProc("GetDiskFreeSpaceExW")
)

// memoryStatusEx mirrors the win32 MEMORYSTATUSEX struct.
type memoryStatusEx struct {
	length               uint32
	memoryLoad           uint32
	totalPhys            uint64
	availPhys            uint64
	totalPageFile        uint64
	availPageFile        uint64
	totalVirtual         uint64
	availVirtual         uint64
	availExtendedVirtual uint64
}

// platformTelemetry uses kernel32 directly: no cgo, no subprocesses. Each
// probe is omitted if it fails. Windows has no load average, so there is no
// load field.
func platformTelemetry() map[string]string {
	out := map[string]string{}
	if err := procGetTickCount64.Find(); err == nil {
		ms, _, _ := procGetTickCount64.Call()
		out["uptime"] = (time.Duration(ms) * time.Millisecond).
			Round(time.Second).String()
	}
	status := memoryStatusEx{}
	status.length = uint32(unsafe.Sizeof(status))
	if ok, _, _ := procGlobalMemoryStatusEx.Call(
		uintptr(unsafe.Pointer(&status)),
	); ok != 0 {
		if memory, valid := formatMemory(status.availPhys, status.totalPhys); valid {
			out["memory"] = memory
		}
	}
	drive := os.Getenv("SystemDrive")
	if drive == "" {
		drive = "C:"
	}
	if free, total, ok := windowsDiskSpace(drive + `\`); ok {
		if disk, valid := formatDisk(free, total, drive); valid {
			out["disk"] = disk
		}
	}
	return out
}

// windowsDiskSpace reports the bytes available to this user and the volume
// size for a root path.
func windowsDiskSpace(root string) (free, total uint64, ok bool) {
	path, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return 0, 0, false
	}
	r, _, _ := procGetDiskFreeSpaceExW.Call(
		uintptr(unsafe.Pointer(path)),
		uintptr(unsafe.Pointer(&free)),
		uintptr(unsafe.Pointer(&total)),
		0,
	)
	return free, total, r != 0
}
