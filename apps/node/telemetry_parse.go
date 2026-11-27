package main

import (
	"encoding/binary"
	"fmt"
	"time"
)

// syscall.Sysctl returns a value as a string with one trailing NUL removed,
// so a little-endian binary value can come back a byte short. These parsers
// pad to the expected size. They live outside the darwin file so that the
// byte layouts are tested on every platform.
func sysctlPad(raw string, size int) []byte {
	buf := make([]byte, size)
	copy(buf, raw)
	return buf
}

// parseBootTime reads kern.boottime, a struct timeval: seconds in the first
// eight bytes on 64-bit Darwin.
func parseBootTime(raw string) (time.Time, bool) {
	if len(raw) < 8 {
		return time.Time{}, false
	}
	secs := int64(binary.LittleEndian.Uint64(sysctlPad(raw, 16)))
	if secs <= 0 {
		return time.Time{}, false
	}
	return time.Unix(secs, 0), true
}

// parseLoadAvg reads vm.loadavg, a struct loadavg: three uint32 fixed-point
// values, padding, then a 64-bit scale at offset 16.
func parseLoadAvg(raw string) (string, bool) {
	if len(raw) < 17 {
		return "", false
	}
	buf := sysctlPad(raw, 24)
	scale := binary.LittleEndian.Uint64(buf[16:24])
	if scale == 0 {
		return "", false
	}
	at := func(i int) float64 {
		return float64(binary.LittleEndian.Uint32(buf[i*4:])) / float64(scale)
	}
	return fmt.Sprintf("%.2f %.2f %.2f", at(0), at(1), at(2)), true
}

// parseUint64 reads a sysctl holding a little-endian integer of up to eight
// bytes, e.g. hw.memsize or a four-byte page count.
func parseUint64(raw string) (uint64, bool) {
	if len(raw) == 0 || len(raw) > 8 {
		return 0, false
	}
	return binary.LittleEndian.Uint64(sysctlPad(raw, 8)), true
}

// formatMemory and formatDisk build the Windows fields. They live here so
// that their checks run on every platform. A zero total, or more free than
// total, means the probe returned garbage, so the field is dropped.
func formatMemory(free, total uint64) (string, bool) {
	if total == 0 || free > total {
		return "", false
	}
	return fmt.Sprintf("%s free of %s", formatBytes(free), formatBytes(total)), true
}

func formatDisk(free, total uint64, mount string) (string, bool) {
	if total == 0 || free > total {
		return "", false
	}
	return fmt.Sprintf(
		"%s free of %s on %s", formatBytes(free), formatBytes(total), mount,
	), true
}
