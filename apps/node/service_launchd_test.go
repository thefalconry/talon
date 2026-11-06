package main

import (
	"encoding/xml"
	"strings"
	"testing"
)

func plistStrings(t *testing.T, doc string) []string {
	t.Helper()
	dec := xml.NewDecoder(strings.NewReader(doc))
	var out []string
	inString := false
	for {
		tok, err := dec.Token()
		if err != nil {
			if err.Error() == "EOF" {
				return out
			}
			t.Fatalf("plist is not well formed: %v\n%s", err, doc)
		}
		switch v := tok.(type) {
		case xml.StartElement:
			inString = v.Name.Local == "string"
		case xml.EndElement:
			inString = false
		case xml.CharData:
			if inString {
				out = append(out, string(v))
			}
		}
	}
}

func TestLaunchdDaemonRunsAsTheAccountWithItsHome(t *testing.T) {
	doc := renderLaunchdPlist(launchdJob{
		Label: "com.talon.node", Exe: "/Users/a/bin/talon-node",
		Config: "/Users/a/.talon-node/config.json", UserName: "a", Home: "/Users/a",
	})
	if !strings.Contains(doc, "<key>UserName</key><string>a</string>") {
		t.Fatalf("daemon without UserName would run as root:\n%s", doc)
	}
	if !strings.Contains(doc, "<key>HOME</key><string>/Users/a</string>") {
		t.Fatalf("daemon without HOME:\n%s", doc)
	}
}

func TestLaunchdAgentHasNoAccountKeys(t *testing.T) {
	doc := renderLaunchdPlist(launchdJob{Label: "l", Exe: "/e", Config: "/c"})
	if strings.Contains(doc, "UserName") || strings.Contains(doc, "HOME") {
		t.Fatalf("agent must inherit its account:\n%s", doc)
	}
}

func TestLaunchdPlistEscapesPaths(t *testing.T) {
	exe := "/Users/a & b/<bin>/talon-node"
	doc := renderLaunchdPlist(launchdJob{Label: "l", Exe: exe, Config: "/c"})
	found := false
	for _, s := range plistStrings(t, doc) {
		found = found || s == exe
	}
	if !found {
		t.Fatalf("path did not round-trip:\n%s", doc)
	}
}

func TestBootAccountNeverRoot(t *testing.T) {
	cases := []struct {
		name, user, uid string
		ok              bool
	}{
		{"sudo from a user", "dylan", "501", true},
		{"root shell", "", "", false},
		{"sudo from root", "root", "0", false},
		{"uid 0 under another name", "toor", "0", false},
		{"bad uid", "dylan", "x", false},
	}
	for _, c := range cases {
		user, uid, err := bootAccount(c.user, c.uid)
		if (err == nil) != c.ok {
			t.Errorf("%s: err = %v", c.name, err)
		}
		if c.ok && (user != "dylan" || uid != 501) {
			t.Errorf("%s: got %s/%d", c.name, user, uid)
		}
	}
}
