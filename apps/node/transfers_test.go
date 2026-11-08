package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDownloadFileRefusesADigestMismatch(t *testing.T) {
	srv, _ := fixtureFileBridge(t, "tampered bytes")
	n := testNode(t, srv.URL, "test-token", filepath.Join(t.TempDir(), "config.json"))
	dest := filepath.Join(t.TempDir(), "out.bin")

	result := cmdDownloadFile(context.Background(), n, map[string]any{
		"token":  "tok",
		"path":   dest,
		"sha256": sha256Hex([]byte("the real bytes")),
	})
	if result.OK || !strings.Contains(result.Message, "integrity check failed") {
		t.Fatalf("mismatch accepted: %+v", result)
	}
	for _, p := range []string{dest, dest + ".part"} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("%s left behind after a digest mismatch (err %v)", p, err)
		}
	}
}

func TestDownloadFileAcceptsAMatchingOrUppercaseDigest(t *testing.T) {
	body := "payload"
	srv, _ := fixtureFileBridge(t, body)
	n := testNode(t, srv.URL, "test-token", filepath.Join(t.TempDir(), "config.json"))
	dest := filepath.Join(t.TempDir(), "out.bin")

	result := cmdDownloadFile(context.Background(), n, map[string]any{
		"token":  "tok",
		"path":   dest,
		"sha256": strings.ToUpper(sha256Hex([]byte(body))),
	})
	if !result.OK {
		t.Fatalf("download failed: %s", result.Message)
	}
	if got, _ := os.ReadFile(dest); string(got) != body {
		t.Fatalf("dest = %q", got)
	}
	if result.Data["sha256"] != sha256Hex([]byte(body)) {
		t.Fatalf("reported sha256 = %v", result.Data["sha256"])
	}
}

func TestDownloadFileWithoutADigestStillWorks(t *testing.T) {
	// An older daemon sends no sha256: nothing to check, same as before.
	srv, _ := fixtureFileBridge(t, "payload")
	n := testNode(t, srv.URL, "test-token", filepath.Join(t.TempDir(), "config.json"))
	dest := filepath.Join(t.TempDir(), "out.bin")
	result := cmdDownloadFile(context.Background(), n, map[string]any{"token": "tok", "path": dest})
	if !result.OK {
		t.Fatalf("download failed: %s", result.Message)
	}
	if result.Data["sha256"] != sha256Hex([]byte("payload")) {
		t.Fatalf("reported sha256 = %v", result.Data["sha256"])
	}
}

func TestUploadFileReportsTheDigestOfWhatItSent(t *testing.T) {
	srv, uploaded := fixtureFileBridge(t, "")
	n := testNode(t, srv.URL, "test-token", filepath.Join(t.TempDir(), "config.json"))
	src := filepath.Join(t.TempDir(), "src.bin")
	body := strings.Repeat("0123456789", 50_000)
	if err := os.WriteFile(src, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	result := cmdUploadFile(context.Background(), n, map[string]any{"token": "tok", "path": src})
	if !result.OK {
		t.Fatalf("upload failed: %s", result.Message)
	}
	if string(*uploaded) != body {
		t.Fatalf("bridge received %d bytes, want %d", len(*uploaded), len(body))
	}
	if result.Data["sha256"] != sha256Hex([]byte(body)) {
		t.Fatalf("reported sha256 = %v", result.Data["sha256"])
	}
}

func TestCheckDigest(t *testing.T) {
	sum := sha256Hex([]byte("x"))
	for _, want := range []string{"", sum, strings.ToUpper(sum), " " + sum + " "} {
		if err := checkDigest(want, sum); err != nil {
			t.Errorf("checkDigest(%q) = %v", want, err)
		}
	}
	if checkDigest(sha256Hex([]byte("y")), sum) == nil {
		t.Error("a different digest passed")
	}
}
