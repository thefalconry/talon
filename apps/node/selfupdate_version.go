package main

import (
	"bytes"
	"fmt"
	"strconv"
	"strings"
)

// update_node reads the version of a pushed binary from its bytes, without
// executing it (it may even be a build for another OS/arch). Two traces of
// the version survive `-s -w -trimpath`:
//
//   - the embedded version.txt line "<version> # x-release-please-version",
//     whose version runs straight on from the previous string's bytes (e.g.
//     "…illegally5.20.0 # x-release…"), so its start has to be inferred;
//   - the ldflags stamp "<version>+<sha>" (main.ldflagsVersion), which the
//     linker lays out as its own NUL-padded string.
//
// The version.txt line gives the candidates, and a stamp for one of them
// settles both which is right and the exact build. This is a best-effort
// safety net against accidental rollbacks, not a trust boundary: whoever can
// send update_node can also pass allow_downgrade.

// releaseMarker is assembled at runtime so this binary's own read-only data
// never holds the full marker as a second, version-less occurrence.
var releaseMarker = []byte(strings.Join([]string{" # x-release", "please-version"}, "-"))

// semver is a parsed MAJOR.MINOR.PATCH[-pre][+build] version.
type semver struct {
	major, minor, patch int
	pre                 []string
	build               string
}

// parseSemver parses a semantic version, tolerating a leading "v". Returns
// false for anything else (e.g. "dev").
func parseSemver(s string) (semver, bool) {
	var v semver
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	if core, build, ok := strings.Cut(s, "+"); ok {
		s, v.build = core, build
	}
	if core, pre, ok := strings.Cut(s, "-"); ok {
		if pre == "" {
			return semver{}, false
		}
		s, v.pre = core, strings.Split(pre, ".")
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return semver{}, false
	}
	nums := make([]int, 3)
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || p == "" {
			return semver{}, false
		}
		nums[i] = n
	}
	v.major, v.minor, v.patch = nums[0], nums[1], nums[2]
	return v, true
}

// compareSemver orders by semver precedence: numerically by core, then a
// pre-release sorts below its release. Build metadata never decides it.
func compareSemver(a, b semver) int {
	for _, d := range []int{a.major - b.major, a.minor - b.minor, a.patch - b.patch} {
		if d != 0 {
			return sign(d)
		}
	}
	switch {
	case len(a.pre) == 0 && len(b.pre) == 0:
		return 0
	case len(a.pre) == 0:
		return 1
	case len(b.pre) == 0:
		return -1
	}
	for i := 0; i < len(a.pre) && i < len(b.pre); i++ {
		if c := comparePreIdent(a.pre[i], b.pre[i]); c != 0 {
			return c
		}
	}
	return sign(len(a.pre) - len(b.pre))
}

// comparePreIdent compares one pre-release identifier: numeric ones
// numerically and below alphanumeric ones, the rest lexically.
func comparePreIdent(a, b string) int {
	an, aErr := strconv.Atoi(a)
	bn, bErr := strconv.Atoi(b)
	switch {
	case aErr == nil && bErr == nil:
		return sign(an - bn)
	case aErr == nil:
		return -1
	case bErr == nil:
		return 1
	}
	return strings.Compare(a, b)
}

func sign(n int) int {
	switch {
	case n < 0:
		return -1
	case n > 0:
		return 1
	}
	return 0
}

// embeddedVersion finds the version a talon-node binary reports: its ldflags
// stamp when the version.txt line confirms it, else the version.txt version,
// else a lone stamp. Returns "" when the bytes carry no recognisable version
// (a foreign or very old binary).
func embeddedVersion(bin []byte) string {
	candidates := versionsAtEnd(markerRun(bin))
	for _, base := range candidates {
		if stamp := stampFor(bin, base); stamp != "" {
			return stamp
		}
	}
	if len(candidates) > 0 {
		return candidates[0]
	}
	return ""
}

// stampFor finds the NUL-delimited ldflags stamp "<base>+<build>", or "".
func stampFor(bin []byte, base string) string {
	needle := append([]byte{0}, base+"+"...)
	i := bytes.Index(bin, needle)
	if i < 0 {
		return ""
	}
	rest := bin[i+1:]
	end := bytes.IndexByte(rest, 0)
	if end < 0 || end > 128 {
		return ""
	}
	stamp := string(rest[:end])
	if _, ok := parseSemver(stamp); !ok {
		return ""
	}
	return stamp
}

// markerRun returns the version-shaped bytes that run up to the version.txt
// marker, e.g. "illegally5.20.0", or "" when no marker is preceded by one.
func markerRun(bin []byte) string {
	for off := 0; ; {
		i := bytes.Index(bin[off:], releaseMarker)
		if i < 0 {
			return ""
		}
		end := off + i
		start := end
		for start > 0 && isVersionByte(bin[start-1]) {
			start--
		}
		if run := string(bin[start:end]); len(versionsAtEnd(run)) > 0 {
			return run
		}
		off = end + len(releaseMarker)
	}
}

// versionsAtEnd lists the suffixes of a marker run that parse as a version,
// longest first: "abc15.19.1" → ["15.19.1", "5.19.1"]. Only a stamp can say
// which is right; without one the longest wins.
func versionsAtEnd(run string) []string {
	var out []string
	for i := 0; i < len(run); i++ {
		if !isDigit(run[i]) {
			continue
		}
		if _, ok := parseSemver(run[i:]); ok {
			out = append(out, run[i:])
		}
	}
	return out
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func isVersionByte(c byte) bool {
	return isDigit(c) || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' ||
		c == '.' || c == '-' || c == '+'
}

// checkUpdateVersion refuses a pushed binary that is older than the running
// one, or the very same build, unless allowDowngrade is set. A binary whose
// version can't be read (or a running "dev" build) is let through: there is
// nothing to compare, and the digest has already been verified.
//
// Same release, different build (a dev checkout rebuilt at a new commit,
// stamped "<version>+<sha>") is an update, not a reinstall: it is refused
// only when the pushed bytes carry the running build's exact version stamp.
func checkUpdateVersion(running string, bin []byte, allowDowngrade bool) (string, error) {
	pushed := embeddedVersion(bin)
	if allowDowngrade || pushed == "" {
		return pushed, nil
	}
	cur, curOK := parseSemver(running)
	next, _ := parseSemver(pushed)
	if !curOK {
		return pushed, nil
	}
	switch c := compareSemver(next, cur); {
	case c > 0:
		return pushed, nil
	case c < 0:
		return pushed, fmt.Errorf(
			"refusing to downgrade from %s to %s — pass allow_downgrade: true to roll back deliberately",
			running, pushed,
		)
	}
	if cur.build != "" && !bytes.Contains(bin, []byte(running)) {
		return pushed, nil
	}
	return pushed, fmt.Errorf(
		"%s is already running (the pushed binary is the same build) — pass allow_downgrade: true to reinstall it",
		running,
	)
}
