package main

import (
	"encoding/binary"
	"strings"
	"testing"
)

func TestParseBootTime(t *testing.T) {
	buf := make([]byte, 16)
	binary.LittleEndian.PutUint64(buf, 1_790_000_000)
	binary.LittleEndian.PutUint32(buf[8:], 123)
	got, ok := parseBootTime(string(buf))
	if !ok || got.Unix() != 1_790_000_000 {
		t.Fatalf("got %v %v", got, ok)
	}
	if _, ok := parseBootTime("abc"); ok {
		t.Fatal("short value accepted")
	}
	if _, ok := parseBootTime(string(make([]byte, 16))); ok {
		t.Fatal("zero boot time accepted")
	}
}

func TestParseLoadAvg(t *testing.T) {
	buf := make([]byte, 24)
	binary.LittleEndian.PutUint32(buf[0:], 2048)
	binary.LittleEndian.PutUint32(buf[4:], 1024)
	binary.LittleEndian.PutUint32(buf[8:], 512)
	binary.LittleEndian.PutUint64(buf[16:], 2048)
	got, ok := parseLoadAvg(string(buf))
	if !ok || got != "1.00 0.50 0.25" {
		t.Fatalf("got %q %v", got, ok)
	}
	// Sysctl strips one trailing NUL; the value must survive that.
	got, ok = parseLoadAvg(strings.TrimSuffix(string(buf), "\x00"))
	if !ok || got != "1.00 0.50 0.25" {
		t.Fatalf("stripped: got %q %v", got, ok)
	}
	if _, ok := parseLoadAvg(string(make([]byte, 24))); ok {
		t.Fatal("zero scale accepted")
	}
}

func TestParseUint64(t *testing.T) {
	buf := make([]byte, 8)
	binary.LittleEndian.PutUint64(buf, 16<<30) // low bytes zero, top bytes zero
	got, ok := parseUint64(strings.TrimSuffix(string(buf), "\x00"))
	if !ok || got != 16<<30 {
		t.Fatalf("got %d %v", got, ok)
	}
	// A four-byte counter, also with its trailing NUL stripped.
	if got, ok := parseUint64("\x10\x27\x00"); !ok || got != 10000 {
		t.Fatalf("four-byte: got %d %v", got, ok)
	}
	if _, ok := parseUint64(""); ok {
		t.Fatal("empty accepted")
	}
	if _, ok := parseUint64("123456789"); ok {
		t.Fatal("oversize accepted")
	}
}

func TestFormatMemory(t *testing.T) {
	got, ok := formatMemory(2<<30, 8<<30)
	if !ok || got != "2.0 GB free of 8.0 GB" {
		t.Fatalf("got %q %v", got, ok)
	}
	if _, ok := formatMemory(0, 0); ok {
		t.Fatal("zero total accepted")
	}
	if _, ok := formatMemory(9<<30, 8<<30); ok {
		t.Fatal("free above total accepted")
	}
}

func TestFormatDisk(t *testing.T) {
	got, ok := formatDisk(1<<30, 4<<30, "C:")
	if !ok || got != "1.0 GB free of 4.0 GB on C:" {
		t.Fatalf("got %q %v", got, ok)
	}
	if _, ok := formatDisk(0, 0, "C:"); ok {
		t.Fatal("zero total accepted")
	}
	if _, ok := formatDisk(5<<30, 4<<30, "C:"); ok {
		t.Fatal("free above total accepted")
	}
}
