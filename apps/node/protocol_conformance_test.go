// Node-side leg of the tri-implementation Bridge Protocol conformance suite
// (see protocol/README.md). The daemon asserts the same fixtures from
// TypeScript and the companion app from Dart; this leg proves talon-node's
// real code paths — capability advertisement, registration body, SSE frame
// filtering, and command dispatch — agree with the shared wire samples.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

type fixtureCommand struct {
	ID       string         `json:"id"`
	DeviceID string         `json:"deviceId"`
	Name     string         `json:"name"`
	Params   map[string]any `json:"params"`
}

type fixtureCommandEntry struct {
	Run             bool           `json:"run"`
	NodeUnsupported bool           `json:"nodeUnsupported"`
	Transfer        bool           `json:"transfer"`
	ExpectOk        bool           `json:"expectOk"`
	DataKeys        []string       `json:"dataKeys"`
	Command         fixtureCommand `json:"command"`
}

type meshFixture struct {
	Protocol         int                   `json:"protocol"`
	NodeCapabilities []string              `json:"nodeCapabilities"`
	NodeDesktop      []string              `json:"nodeDesktopCapabilities"`
	Registration     map[string]any        `json:"registration"`
	ResultOk         map[string]any        `json:"resultOk"`
	ResultError      map[string]any        `json:"resultError"`
	SandboxFiles     map[string]string     `json:"sandboxFiles"`
	TransferBody     string                `json:"transferBody"`
	Commands         []fixtureCommandEntry `json:"commands"`
}

type eventsFixture struct {
	Protocol      int              `json:"protocol"`
	Events        []map[string]any `json:"events"`
	ForwardCompat []map[string]any `json:"forwardCompat"`
}

func loadFixture(t *testing.T, name string, out any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol", "fixtures", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatalf("parse fixture %s: %v", name, err)
	}
}

func loadMeshFixture(t *testing.T) meshFixture {
	t.Helper()
	var fx meshFixture
	loadFixture(t, "mesh_v1.json", &fx)
	return fx
}

func TestNodeCapabilitiesMatchFixture(t *testing.T) {
	fx := loadMeshFixture(t)
	if !reflect.DeepEqual(fx.NodeCapabilities, nodeCapabilities) {
		t.Fatalf(
			"advertised capabilities drifted from protocol/fixtures/mesh_v1.json:\n fixture: %v\n    node: %v",
			fx.NodeCapabilities, nodeCapabilities,
		)
	}
}

// A platform may add commands on top of the common surface, but only ones
// the shared fixture names — otherwise the daemon would meet a capability
// no conformance sample describes.
func TestPlatformCapabilitiesAreInFixture(t *testing.T) {
	fx := loadMeshFixture(t)
	for _, name := range platformCapabilities {
		if !slices.Contains(fx.NodeDesktop, name) {
			t.Errorf("platform capability %q is not in the fixture's nodeDesktopCapabilities %v", name, fx.NodeDesktop)
		}
	}
	// Every build must at least recognise them, so a platform that does not
	// implement one answers "unavailable here" and never "unknown command".
	for _, name := range fx.NodeDesktop {
		result := dispatch(context.Background(), nil, name, map[string]any{})
		if strings.Contains(result.Message, "does not support") {
			t.Errorf("fixture desktop capability %q has no dispatch case: %s", name, result.Message)
		}
	}
}

func TestRegistrationBodyMatchesFixture(t *testing.T) {
	fx := loadMeshFixture(t)
	n := &Node{
		cfg:      &Config{Name: "rack-01"},
		DeviceID: "dev_node01",
	}
	body := n.registrationBody()

	// Same keys as the canonical registration — a renamed or dropped field
	// on either side is a silent registry miss, so key parity is the test.
	for key := range fx.Registration {
		if _, present := body[key]; !present {
			t.Errorf("registration body is missing fixture key %q", key)
		}
	}
	for key := range body {
		if _, present := fx.Registration[key]; !present {
			t.Errorf("registration body key %q is absent from the fixture", key)
		}
	}

	if body["capabilities"] == nil ||
		!reflect.DeepEqual(body["capabilities"], allCapabilities()) {
		t.Errorf("registration must advertise the full capability surface, got %v", body["capabilities"])
	}
	platform, _ := body["platform"].(string)
	switch platform {
	case "linux", "macos", "windows":
	default:
		t.Errorf("platform %q is not a mesh DevicePlatform a node can register", platform)
	}
}

func TestResultBodyMatchesFixture(t *testing.T) {
	fx := loadMeshFixture(t)
	body := resultBody("dev_node01", commandResult{
		CommandID: "cmd_01",
		OK:        true,
		Message:   "done",
		Data:      map[string]any{"hostname": "rack-01"},
	})
	// Every key the canonical results use must exist in what the node posts.
	for key := range fx.ResultOk {
		if _, present := body[key]; !present {
			t.Errorf("result body is missing fixture key %q", key)
		}
	}
	for key := range fx.ResultError {
		if _, present := body[key]; !present {
			t.Errorf("result body is missing fixture key %q", key)
		}
	}
}

func TestDecodeCommandFrame(t *testing.T) {
	var fx eventsFixture
	loadFixture(t, "events_v1.json", &fx)

	frames := 0
	for _, event := range fx.Events {
		raw, err := json.Marshal(event)
		if err != nil {
			t.Fatal(err)
		}
		line := "data: " + string(raw)
		decoded, ok := decodeCommandFrame(line, "dev_node01")
		if event["kind"] == "device_command" && event["deviceId"] == "dev_node01" {
			frames++
			if !ok {
				t.Fatalf("canonical device_command frame was not decoded: %s", line)
			}
			if decoded["id"] != event["id"] || decoded["name"] != event["name"] {
				t.Fatalf("decoded frame lost fields: %v", decoded)
			}
			// The same frame addressed to a different node must be ignored.
			if _, misdelivered := decodeCommandFrame(line, "dev_other"); misdelivered {
				t.Fatal("frame for dev_node01 was accepted by dev_other")
			}
		} else if ok {
			t.Fatalf("non-command event %q must be skipped, got %v", event["kind"], decoded)
		}
	}
	if frames == 0 {
		t.Fatal("events fixture has no device_command sample addressed to dev_node01")
	}

	// Unknown kinds and junk must be tolerated, never fatal.
	for _, event := range fx.ForwardCompat {
		raw, _ := json.Marshal(event)
		if _, ok := decodeCommandFrame("data: "+string(raw), "dev_node01"); ok {
			t.Fatalf("forward-compat frame %v must be skipped", event)
		}
	}
	for _, line := range []string{"", ": keepalive", "data: {not json", "event: message"} {
		if _, ok := decodeCommandFrame(line, "dev_node01"); ok {
			t.Fatalf("malformed line %q must be skipped", line)
		}
	}
}

// TestDispatchConformance executes every runnable canonical command through
// the real dispatch() in a sandbox seeded from the fixture, asserting the
// outcome and the result-data keys the daemon's tools read.
func TestDispatchConformance(t *testing.T) {
	fx := loadMeshFixture(t)
	n := &Node{cfg: &Config{Name: "rack-01"}, DeviceID: "dev_node01"}

	for _, entry := range fx.Commands {
		if !entry.Run {
			continue
		}
		entry := entry
		t.Run(entry.Command.Name, func(t *testing.T) {
			sandbox := t.TempDir()
			for name, content := range fx.SandboxFiles {
				if err := os.WriteFile(
					filepath.Join(sandbox, name), []byte(content), 0o644,
				); err != nil {
					t.Fatal(err)
				}
			}
			params := make(map[string]any, len(entry.Command.Params))
			for k, v := range entry.Command.Params {
				if s, isString := v.(string); isString {
					params[k] = strings.ReplaceAll(s, "{{TMP}}", sandbox)
				} else {
					params[k] = v
				}
			}
			result := dispatch(context.Background(), n, entry.Command.Name, params)
			if result.OK != entry.ExpectOk {
				t.Fatalf(
					"dispatch(%s) ok=%v want %v (message: %s)",
					entry.Command.Name, result.OK, entry.ExpectOk, result.Message,
				)
			}
			for _, key := range entry.DataKeys {
				if _, present := result.Data[key]; !present {
					t.Errorf(
						"dispatch(%s) result data is missing contract key %q (got %v)",
						entry.Command.Name, key, result.Data,
					)
				}
			}
		})
	}
}

// TestDispatchUnsupportedAnswersCleanly pins the promise that a command
// outside the node's surface still gets an answer (never a timeout).
func TestDispatchUnsupportedAnswersCleanly(t *testing.T) {
	fx := loadMeshFixture(t)
	n := &Node{cfg: &Config{Name: "rack-01"}, DeviceID: "dev_node01"}
	tested := 0
	for _, entry := range fx.Commands {
		if !entry.NodeUnsupported {
			continue
		}
		tested++
		result := dispatch(context.Background(), n, entry.Command.Name, entry.Command.Params)
		if result.OK {
			t.Errorf("dispatch(%s) must fail on a node", entry.Command.Name)
		}
		if !strings.Contains(result.Message, "does not support") {
			t.Errorf("dispatch(%s) message %q should say the command is unsupported",
				entry.Command.Name, result.Message)
		}
	}
	if tested == 0 {
		t.Fatal("fixture has no nodeUnsupported command samples")
	}
}

// fixtureFileBridge is a fake /devices/file: it serves body for GET (push)
// and records the POSTed body (pull), whatever the token.
func fixtureFileBridge(t *testing.T, body string) (*httptest.Server, *[]byte) {
	t.Helper()
	var uploaded []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/devices/file" {
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodPost {
			uploaded, _ = io.ReadAll(r.Body)
			_, _ = io.WriteString(w, `{"ok":true}`)
			return
		}
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv, &uploaded
}

// TestTransferConformance runs the streamed transfer samples (`transfer:
// true`) through the real dispatch against a fake /devices/file: the
// result keys, the push digest check, and the digest the node reports.
func TestTransferConformance(t *testing.T) {
	fx := loadMeshFixture(t)
	srv, uploaded := fixtureFileBridge(t, fx.TransferBody)
	n := testNode(t, srv.URL, "test-token", filepath.Join(t.TempDir(), "config.json"))
	bodySum := sha256.Sum256([]byte(fx.TransferBody))
	want := hex.EncodeToString(bodySum[:])

	tested := 0
	for _, entry := range fx.Commands {
		if !entry.Transfer {
			continue
		}
		tested++
		sandbox := t.TempDir()
		for name, content := range fx.SandboxFiles {
			if err := os.WriteFile(filepath.Join(sandbox, name), []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		params := make(map[string]any, len(entry.Command.Params))
		for k, v := range entry.Command.Params {
			if s, isString := v.(string); isString {
				v = strings.ReplaceAll(s, "{{TMP}}", sandbox)
			}
			params[k] = v
		}
		result := dispatch(context.Background(), n, entry.Command.Name, params)
		if result.OK != entry.ExpectOk {
			t.Fatalf("dispatch(%s) ok=%v (message: %s)", entry.Command.Name, result.OK, result.Message)
		}
		for _, key := range entry.DataKeys {
			if _, present := result.Data[key]; !present {
				t.Errorf("dispatch(%s) result data is missing contract key %q (got %v)",
					entry.Command.Name, key, result.Data)
			}
		}
		switch entry.Command.Name {
		case "download_file":
			if params["sha256"] != want || result.Data["sha256"] != want {
				t.Errorf("download_file digest: param %v, reported %v, body %s",
					params["sha256"], result.Data["sha256"], want)
			}
		case "upload_file":
			sum := sha256.Sum256(*uploaded)
			if got := hex.EncodeToString(sum[:]); result.Data["sha256"] != got {
				t.Errorf("upload_file reported %v for bytes hashing to %s", result.Data["sha256"], got)
			}
		}
	}
	if tested != 2 {
		t.Fatalf("fixture has %d transfer samples, want upload_file and download_file", tested)
	}
}
