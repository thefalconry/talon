package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// fakeNodeBinary builds bytes shaped like a talon-node build: some code,
// the embedded version.txt line, and (when stamp is set) the ldflags version.
func fakeNodeBinary(talonVersion, stamp string) []byte {
	b := "\x7fELF...code..." + talonVersion + " # x-release-please-version\n...rodata..."
	if stamp != "" {
		b += "\x00" + stamp + "\x00"
	}
	return []byte(b)
}

// stageUpdate writes an "old" running binary and a pushed replacement into a
// temp dir, returning (exe, src).
func stageUpdate(t *testing.T, pushed []byte) (string, string) {
	t.Helper()
	dir := t.TempDir()
	exe := filepath.Join(dir, "talon-node")
	if err := os.WriteFile(exe, []byte("OLD-BINARY"), 0o755); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "pushed.bin")
	if err := os.WriteFile(src, pushed, 0o644); err != nil {
		t.Fatal(err)
	}
	return exe, src
}

// assertUntouched fails unless the running binary is still the old one and
// no staging file lingers.
func assertUntouched(t *testing.T, exe string) {
	t.Helper()
	got, _ := os.ReadFile(exe)
	if string(got) != "OLD-BINARY" {
		t.Fatalf("binary changed on refused update: %q", got)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(exe), ".talon-node-update")); !os.IsNotExist(err) {
		t.Fatal("staging file left behind after refusal")
	}
}

func skipSwapOnWindows(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("swap-in-place semantics differ on windows")
	}
}

func TestInstallUpdateSwapsBinary(t *testing.T) {
	skipSwapOnWindows(t)
	newBytes := []byte("NEW-BINARY-CONTENT")
	exe, src := stageUpdate(t, newBytes)

	if _, err := installUpdate(exe, updateRequest{src: src, sha256: sha256Hex(newBytes), running: "5.19.1"}); err != nil {
		t.Fatalf("installUpdate: %v", err)
	}
	got, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(newBytes) {
		t.Fatalf("binary not swapped: %q", got)
	}
	// The staging file must not linger.
	if _, err := os.Stat(filepath.Join(filepath.Dir(exe), ".talon-node-update")); !os.IsNotExist(err) {
		t.Fatal("staging file left behind")
	}
}

func TestInstallUpdateRejectsBadHash(t *testing.T) {
	exe, src := stageUpdate(t, []byte("NEW"))
	_, err := installUpdate(exe, updateRequest{src: src, sha256: sha256Hex([]byte("DIFFERENT")), running: "5.19.1"})
	if err == nil {
		t.Fatal("expected integrity failure")
	}
	assertUntouched(t, exe)
}

func TestInstallUpdateRequiresHash(t *testing.T) {
	exe, src := stageUpdate(t, []byte("NEWER"))
	for _, sha := range []string{"", "abc", strings.Repeat("z", 64)} {
		_, err := installUpdate(exe, updateRequest{src: src, sha256: sha, running: "5.19.1"})
		if err == nil || !strings.Contains(err.Error(), "sha256") {
			t.Fatalf("sha256 %q: want a missing-digest refusal, got %v", sha, err)
		}
		assertUntouched(t, exe)
	}
}

func TestCmdUpdateNodeRequiresHash(t *testing.T) {
	// Refused before the node (nil here) or the filesystem is touched.
	r := cmdUpdateNode(nil, map[string]any{"path": "/tmp/talon-node.update"})
	if r.OK || !strings.Contains(r.Message, "sha256") {
		t.Fatalf("want sha256 refusal, got %+v", r)
	}
}

func TestInstallUpdateRefusesDowngrade(t *testing.T) {
	old := fakeNodeBinary("5.18.0", "5.18.0+aaaaaaa")
	exe, src := stageUpdate(t, old)
	_, err := installUpdate(exe, updateRequest{src: src, sha256: sha256Hex(old), running: "5.19.1+bbbbbbb"})
	if err == nil || !strings.Contains(err.Error(), "allow_downgrade") {
		t.Fatalf("want a downgrade refusal naming allow_downgrade, got %v", err)
	}
	assertUntouched(t, exe)
}

func TestInstallUpdateAllowDowngradeOverrides(t *testing.T) {
	skipSwapOnWindows(t)
	old := fakeNodeBinary("5.18.0", "5.18.0+aaaaaaa")
	exe, src := stageUpdate(t, old)
	pushed, err := installUpdate(exe, updateRequest{
		src: src, sha256: sha256Hex(old), running: "5.19.1+bbbbbbb", allowDowngrade: true,
	})
	if err != nil {
		t.Fatalf("allow_downgrade should permit the rollback: %v", err)
	}
	if pushed != "5.18.0+aaaaaaa" {
		t.Fatalf("pushed version = %q, want 5.18.0+aaaaaaa", pushed)
	}
	if got, _ := os.ReadFile(exe); string(got) != string(old) {
		t.Fatal("binary not swapped")
	}
}

func TestInstallUpdateAcceptsNewer(t *testing.T) {
	skipSwapOnWindows(t)
	next := fakeNodeBinary("5.20.0", "5.20.0+ccccccc")
	exe, src := stageUpdate(t, next)
	pushed, err := installUpdate(exe, updateRequest{src: src, sha256: sha256Hex(next), running: "5.19.1+bbbbbbb"})
	if err != nil {
		t.Fatalf("newer binary refused: %v", err)
	}
	if pushed != "5.20.0+ccccccc" {
		t.Fatalf("pushed version = %q, want 5.20.0+ccccccc", pushed)
	}
}

func TestCheckUpdateVersion(t *testing.T) {
	cases := []struct {
		name      string
		running   string
		bin       []byte
		allow     bool
		wantError string
	}{
		{"newer release", "5.19.1+aaa", fakeNodeBinary("5.20.0", "5.20.0+bbb"), false, ""},
		{"older release", "5.19.1+aaa", fakeNodeBinary("5.19.0", "5.19.0+bbb"), false, "downgrade"},
		{"older release, overridden", "5.19.1+aaa", fakeNodeBinary("5.19.0", ""), true, ""},
		{"same build", "5.19.1+aaa1111", fakeNodeBinary("5.19.1", "5.19.1+aaa1111"), false, "already running"},
		{"same build, overridden", "5.19.1+aaa1111", fakeNodeBinary("5.19.1", "5.19.1+aaa1111"), true, ""},
		{"same release, new commit", "5.19.1+aaa1111", fakeNodeBinary("5.19.1", "5.19.1+bbb2222"), false, ""},
		{"same release, bare running build", "5.19.1", fakeNodeBinary("5.19.1", ""), false, "already running"},
		{"release beats its rc", "5.20.0-rc.1", fakeNodeBinary("5.20.0", ""), false, ""},
		{"rc below running release", "5.20.0", fakeNodeBinary("5.20.0-rc.2", ""), false, "downgrade"},
		{"unversioned binary", "5.19.1", []byte("some other build"), false, ""},
		{"dev running build", "dev", fakeNodeBinary("5.0.0", ""), false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := checkUpdateVersion(tc.running, tc.bin, tc.allow)
			switch {
			case tc.wantError == "" && err != nil:
				t.Fatalf("unexpected refusal: %v", err)
			case tc.wantError != "" && (err == nil || !strings.Contains(err.Error(), tc.wantError)):
				t.Fatalf("want error containing %q, got %v", tc.wantError, err)
			}
		})
	}
}

func TestEmbeddedVersion(t *testing.T) {
	// A marker preceded by junk is skipped; the real version.txt line wins.
	bin := []byte("xx # x-release-please-version\x00" + string(fakeNodeBinary("5.20.1", "")))
	if got := embeddedVersion(bin); got != "5.20.1" {
		t.Fatalf("embeddedVersion = %q, want 5.20.1", got)
	}
	// The layout a real -s -w -trimpath build has: the version.txt line runs
	// straight on from the previous string, the ldflags stamp is NUL-padded.
	real := []byte("scalar has high bit set illegally5.19.1 # x-release-please-version\n" +
		"...go1.26.5\x00\x00\x00\x005.19.1+abc1234\x00\x00")
	if got := embeddedVersion(real); got != "5.19.1+abc1234" {
		t.Fatalf("embeddedVersion(real layout) = %q, want 5.19.1+abc1234", got)
	}
	// A stamp the version.txt line doesn't confirm is not trusted over it.
	odd := []byte("x5.19.1 # x-release-please-version\n\x009.9.9+zzz\x00")
	if got := embeddedVersion(odd); got != "5.19.1" {
		t.Fatalf("embeddedVersion(unconfirmed stamp) = %q, want 5.19.1", got)
	}
	// A pre-release version survives the run-on prefix.
	if got := embeddedVersion([]byte("abc5.20.0-rc.1 # x-release-please-version")); got != "5.20.0-rc.1" {
		t.Fatalf("embeddedVersion(rc) = %q, want 5.20.0-rc.1", got)
	}
	if got := embeddedVersion([]byte("no marker here")); got != "" {
		t.Fatalf("embeddedVersion without marker = %q, want empty", got)
	}
	// This binary's own marker is assembled at runtime, so the test binary
	// (which embeds version.txt) yields exactly the embedded version.
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	// (The test binary has no ldflags stamp, but this file's own literals can
	// look like one, so only the release part is asserted.)
	want := strings.Fields(talonVersion)[0]
	if got, _, _ := strings.Cut(embeddedVersion(raw), "+"); got != want {
		t.Fatalf("embeddedVersion(self) = %q, want %q", got, want)
	}
}

func TestCompareSemver(t *testing.T) {
	order := []string{"1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0", "2.0.0"}
	for i := 0; i+1 < len(order); i++ {
		a, okA := parseSemver(order[i])
		b, okB := parseSemver(order[i+1])
		if !okA || !okB {
			t.Fatalf("parse %q / %q failed", order[i], order[i+1])
		}
		if compareSemver(a, b) >= 0 || compareSemver(b, a) <= 0 {
			t.Fatalf("%s should sort below %s", order[i], order[i+1])
		}
	}
	for _, bad := range []string{"", "dev", "1.2", "1.2.x", "1.2.3-", "1..3"} {
		if _, ok := parseSemver(bad); ok {
			t.Fatalf("parseSemver(%q) should fail", bad)
		}
	}
}

func TestVersionResolution(t *testing.T) {
	// Embedded Talon version is the bare-build fallback identity.
	if resolveVersion() == "dev" {
		t.Fatal("version.txt should provide a non-dev fallback")
	}
}
