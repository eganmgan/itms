package saltstack

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPackageIdentifiers(t *testing.T) {
	for _, name := range []string{"firefox", "7zip", "libstdc++6", "Microsoft.Edge", "python3-pip", "a_b"} {
		if !ValidPackageIdentifier(name) {
			t.Errorf("rejected %q", name)
		}
	}
	for _, name := range []string{"", "-y", "--help", " a", "a b", "a;b", "$(id)", "a|b", "a&b", "a\nb", "a=b", "a,b", "*.rpm", "/tmp/a", "https://host/a", "pkg:amd64", "é", strings.Repeat("a", 201)} {
		if ValidPackageIdentifier(name) {
			t.Errorf("accepted %q", name)
		}
	}
	for _, target := range []string{"*", "a,b", "G@os:Linux", "a?", "[ab]", "a b", "-a", "a\nb", "", strings.Repeat("a", 254)} {
		if ValidExactMinion(target) {
			t.Errorf("accepted target %q", target)
		}
	}
}

func TestPackageOutcomes(t *testing.T) {
	cases := []struct{ name, raw, status, code string }{
		{"changed", `{"firefox":{"old":"","new":"1"},"dependency":{"old":"1","new":"2"}}`, "succeeded", "package_changed"},
		{"no-op requires verification", `{}`, "unknown", "verification_required"},
		{"false", `false`, "failed", "provider_failed"},
		{"explicit error", `"ERROR: sensitive provider detail"`, "failed", "provider_failed"},
		{"null", `null`, "unknown", "unrecognized_response"},
		{"true", `true`, "unknown", "unrecognized_response"},
		{"timeout string", `"Minion did not return"`, "unknown", "unrecognized_response"},
		{"array", `[]`, "unknown", "unrecognized_response"},
		{"async acknowledgement", `{"jid":"123"}`, "unknown", "unrecognized_response"},
		{"missing requested package", `{"dependency":{"old":"","new":"1"}}`, "unknown", "unrecognized_response"},
		{"empty version", `{"firefox":{"old":"1","new":""}}`, "unknown", "unrecognized_response"},
		{"null version", `{"firefox":{"old":null,"new":"1"}}`, "unknown", "unrecognized_response"},
		{"missing old", `{"firefox":{"new":"1"}}`, "unknown", "unrecognized_response"},
		{"malformed", `{"firefox":`, "unknown", "unrecognized_response"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, code := packageOutcome(json.RawMessage(tc.raw), "firefox")
			if status != tc.status || code != tc.code {
				t.Fatalf("got %s/%s", status, code)
			}
		})
	}
}

func TestInstallPackageExactTargetAndNoRetry(t *testing.T) {
	for _, token := range []string{"", "test-token"} {
		for _, statusCode := range []int{200, 202, 401, 500} {
			t.Run(fmt.Sprintf("token=%t/http=%d", token != "", statusCode), func(t *testing.T) {
				calls := 0
				remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					if r.URL.Path != "/run" {
						t.Errorf("unexpected path %s", r.URL.Path)
					}
					if token == "" {
						if err := r.ParseForm(); err != nil {
							t.Error(err)
						}
						if r.Form.Get("fun") != "pkg.install" || r.Form.Get("expr_form") != "list" || r.Form.Get("tgt_type") != "list" || r.Form.Get("tgt") != "host-1" || r.Form.Get("timeout") != "20" {
							t.Error("unsafe lowstate")
						}
						if args := r.Form["arg"]; len(args) != 1 || args[0] != "firefox" {
							t.Errorf("args=%v", args)
						}
						if r.Form.Get("username") != "test-user" || r.Form.Get("password") != "test-password" {
							t.Error("missing inline auth")
						}
					} else {
						var payload map[string]any
						if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
							t.Error(err)
						}
						if payload["fun"] != "pkg.install" || payload["expr_form"] != "list" || payload["tgt_type"] != "list" {
							t.Error("unsafe targeting")
						}
						target, _ := payload["tgt"].([]any)
						args, _ := payload["arg"].([]any)
						if len(target) != 1 || target[0] != "host-1" || len(args) != 1 || args[0] != "firefox" {
							t.Error("unsafe arguments")
						}
					}
					w.WriteHeader(statusCode)
					_, _ = w.Write([]byte(`{"return":[{"host-1":{"firefox":{"old":"","new":"1"}}}]}`))
				}))
				defer remote.Close()
				client := NewClient(remote.URL, token, "test-user", "test-password", "pam", "compound")
				status, _ := client.InstallPackage(context.Background(), "host-1", "firefox")
				want := "unknown"
				if statusCode == 200 {
					want = "succeeded"
				}
				if calls != 1 || status != want {
					t.Fatalf("calls=%d status=%s", calls, status)
				}
			})
		}
	}
}

func TestInstallPackageRejectsAmbiguousEnvelope(t *testing.T) {
	for _, raw := range []string{
		`{}`, `{"return":[]}`, `{"return":[{}]}`, `{"return":[{"other":{}}]}`,
		`{"return":[{"host-1":{},"other":{}}]}`, `{"return":[{"host-1":{}},{"host-1":{}}]}`, `not-json`,
		`{"return":[{"host-1":{"firefox":{"old":"","new":"1"}}}],"error":"private"}`,
		`{"return":[{"host-1":false,"host-1":{"firefox":{"old":"","new":"1"}}}]}`,
		`{"return":[{"host-1":{"firefox":{"old":"","new":"","new":"1"}}}]}`,
		`{"return":[{"host-1":{"firefox":{"old":"","new":"1"}}}]} {}`,
		`{"return":[{"host-1":"` + strings.Repeat("x", 2*1024*1024) + `"}]}`,
	} {
		t.Run(raw, func(t *testing.T) {
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(raw)) }))
			defer remote.Close()
			client := NewClient(remote.URL, "test-token", "", "", "", "glob")
			status, _ := client.InstallPackage(context.Background(), "host-1", "firefox")
			if status != "unknown" {
				t.Fatalf("status=%s", status)
			}
		})
	}
}

func TestInstallPackageNoOpVerification(t *testing.T) {
	for _, inline := range []bool{false, true} {
		for _, tc := range []struct {
			version, status, code string
			httpStatus            int
		}{
			{`"1.2.3"`, "succeeded", "already_present", 200},
			{`""`, "unknown", "verification_mismatch", 200},
			{`"  "`, "unknown", "verification_mismatch", 200},
			{`null`, "unknown", "unrecognized_response", 200},
			{`false`, "unknown", "unrecognized_response", 200},
			{`{}`, "unknown", "unrecognized_response", 200},
			{`"ERROR: private"`, "unknown", "unrecognized_response", 200},
			{`"1"`, "unknown", "verification_unavailable", 500},
			{`"1"`, "unknown", "verification_unavailable", 401},
			{`"1"`, "unknown", "verification_unavailable", 202},
		} {
			t.Run(fmt.Sprintf("inline=%t/%s/%d", inline, tc.version, tc.httpStatus), func(t *testing.T) {
				client, calls := managementRemote(t, inline, []managementReply{
					{"pkg.install", `{}`, 200}, {"pkg.version", tc.version, tc.httpStatus},
				})
				status, code := client.InstallPackage(context.Background(), "host-1", "example")
				if status != tc.status || code != tc.code || *calls != 2 {
					t.Fatalf("%s/%s calls=%d", status, code, *calls)
				}
			})
		}
	}
}

func TestPackageCallFunctionAllowlist(t *testing.T) {
	client, calls := managementRemote(t, false, nil)
	for _, pair := range [][2]string{{"cmd.run", "id"}, {"pkg.remove", "example"}, {"pkg.install", "a,b"}, {"sys.list_functions", "cmd"}} {
		if _, err := client.packageCall(context.Background(), "host-1", pair[0], pair[1]); err == nil || *calls != 0 {
			t.Fatalf("unsafe package call accepted: %v", pair)
		}
	}
}

func TestPackagePreflightAndCancellation(t *testing.T) {
	calls := 0
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload["fun"] != "sys.list_functions" {
			t.Error("unexpected mutation")
		}
		_, _ = w.Write([]byte(`{"return":[{"mac-1":["pkg.install","pkg.version"]}]}`))
	}))
	defer remote.Close()
	client := NewClient(remote.URL, "test-token", "", "", "", "glob")
	ready, err := client.PackageProviderAvailable(context.Background(), "mac-1")
	if !ready || err != nil {
		t.Fatalf("ready=%t err=%v", ready, err)
	}
	for _, pair := range [][2]string{{"*", "firefox"}, {"mac-1", "--help"}} {
		status, _ := client.InstallPackage(context.Background(), pair[0], pair[1])
		if status != "failed" {
			t.Fatal(status)
		}
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	status, _ := client.InstallPackage(ctx, "mac-1", "firefox")
	if status != "unknown" || calls != 1 {
		t.Fatalf("status=%s calls=%d", status, calls)
	}
}
