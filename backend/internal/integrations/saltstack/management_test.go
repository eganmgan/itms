package saltstack

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type managementReply struct {
	function string
	value    string
	status   int
}

func managementRemote(t *testing.T, inline bool, replies []managementReply) (*Client, *int) {
	t.Helper()
	calls := 0
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		i := calls
		calls++
		if i >= len(replies) {
			t.Error("unexpected remote retry/call")
			w.WriteHeader(500)
			return
		}
		reply := replies[i]
		if r.URL.Path != "/run" || r.Method != "POST" {
			t.Error("not direct /run POST")
		}
		var function string
		var args []string
		if inline {
			_ = r.ParseForm()
			function, args = r.Form.Get("fun"), r.Form["arg"]
			if len(r.Form["tgt"]) != 1 || r.Form.Get("tgt") != "host-1" || r.Form.Get("expr_form") != "list" || r.Form.Get("tgt_type") != "list" || r.Form.Get("client") != "local" || r.Form.Get("timeout") != "20" || r.Form.Get("username") != "fixture-user" || r.Form.Get("password") != "fixture-password" {
				t.Error("unsafe inline targeting/auth")
			}
		} else {
			var payload struct {
				Function string   `json:"fun"`
				Target   []string `json:"tgt"`
				Args     []string `json:"arg"`
				Expr     string   `json:"expr_form"`
				Type     string   `json:"tgt_type"`
				Client   string   `json:"client"`
				Timeout  int      `json:"timeout"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Error(err)
			}
			function, args = payload.Function, payload.Args
			if len(payload.Target) != 1 || payload.Target[0] != "host-1" || payload.Expr != "list" || payload.Type != "list" || payload.Client != "local" || payload.Timeout != 20 {
				t.Error("unsafe exact targeting")
			}
		}
		if function != reply.function {
			t.Errorf("function=%s want=%s", function, reply.function)
		}
		if function == "service.get_all" {
			if len(args) != 0 {
				t.Error("get_all must have no arguments")
			}
		} else if len(args) != 1 || args[0] != "example" {
			t.Errorf("unsafe args: %v", args)
		}
		if reply.status != 0 {
			w.WriteHeader(reply.status)
		}
		_, _ = fmt.Fprintf(w, `{"return":[{"host-1":%s}]}`, reply.value)
	}))
	t.Cleanup(remote.Close)
	token, username, password := "fixture-token", "", ""
	if inline {
		token, username, password = "", "fixture-user", "fixture-password"
	}
	return NewClient(remote.URL, token, username, password, "pam", "compound"), &calls
}

func TestManagementNamesAndProtection(t *testing.T) {
	for _, name := range []string{"nginx", "Spooler", "MSSQLSERVER", "worker@tenant-1.service", "com.example:daemon", "a_b", "a+b", "target", "example.socket.service", strings.Repeat("a", 255)} {
		if !ValidServiceName(name) {
			t.Errorf("rejected %q", name)
		}
	}
	for _, name := range []string{"", "-x", "a*", "a?", "[ab]", "a,b", "a;b", "a\nb", "a\rb", "a\x00b", "a b", "a/b", "$(id)", "a=b", "é", `MSSQL$SQLEXPRESS`, `worker@tenant\x2d1.service`, strings.Repeat("a", 256)} {
		if ValidServiceName(name) {
			t.Errorf("accepted %q", name)
		}
	}
	for _, name := range []string{"Salt-Minion", "salt-master.service", "WazuhSvc", "wazuh-agent", "sshd@tenant.service", "ssh.socket", "openssh-server", "ITMS-agent", "glpi-agent", "inventory-collector.timer", "ossec-agent", "docker.service"} {
		if !ProtectedManagementName(name) {
			t.Errorf("unprotected %q", name)
		}
	}
}

func TestManagementServiceListing(t *testing.T) {
	for _, tc := range []struct {
		raw, status string
		count       int
	}{
		{`["worker@tenant.service","example","example"]`, "partial", 2},
		{`[]`, "success", 0}, {`null`, "unavailable", 0}, {`true`, "unavailable", 0},
		{`"ERROR: credential"`, "unavailable", 0}, {`["example","bad*service"]`, "partial", 1},
		{`["bad*service"]`, "success", 0},
		{`["poweroff.target","example.socket"]`, "success", 0},
		{`["example",null]`, "unavailable", 0},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			client, calls := managementRemote(t, true, []managementReply{{"service.get_all", tc.raw, 200}})
			items, status := client.ListManagedServices(context.Background(), "host-1")
			if status != tc.status || len(items) != tc.count || *calls != 1 || items == nil {
				t.Fatalf("items=%v status=%s calls=%d", items, status, *calls)
			}
			for _, item := range items {
				if item.Running != nil || item.Enabled != nil {
					t.Fatal("fabricated state")
				}
			}
		})
	}
}

func TestManagementNonServiceUnits(t *testing.T) {
	for _, inline := range []bool{false, true} {
		for _, suffix := range []string{"target", "mount", "automount", "device", "socket", "timer", "path", "swap", "slice", "scope"} {
			for _, name := range []string{"poweroff." + suffix, "worker@tenant." + strings.ToUpper(suffix)} {
				t.Run(fmt.Sprintf("inline=%t/%s", inline, name), func(t *testing.T) {
					if ValidServiceName(name) {
						t.Fatal("accepted non-service unit")
					}
					// A discovered unit must never appear in the service enumeration.
					raw, _ := json.Marshal([]string{name, "example"})
					client, calls := managementRemote(t, inline, []managementReply{{"service.get_all", string(raw), 200}})
					items, status := client.ListManagedServices(context.Background(), "host-1")
					if status != "partial" || len(items) != 1 || items[0].Name != "example" || *calls != 1 {
						t.Fatalf("items=%v status=%s calls=%d", items, status, *calls)
					}
					// Direct requests fail before even discovery, for every action.
					client, calls = managementRemote(t, inline, nil)
					for _, action := range []string{"start", "stop", "restart", "enable", "disable"} {
						status, code := client.ManageService(context.Background(), "host-1", name, action)
						if status != "failed" || code != "invalid_service_target" || *calls != 0 {
							t.Fatalf("%s: %s/%s calls=%d", action, status, code, *calls)
						}
					}
					// The final dispatch boundary independently enforces service scope.
					for _, function := range []string{"service.start", "service.stop", "service.restart", "service.enable", "service.disable", "service.status", "service.enabled"} {
						if _, err := client.managementCall(context.Background(), "host-1", function, name); err == nil || *calls != 0 {
							t.Fatalf("%s: err=%v calls=%d", function, err, *calls)
						}
					}
				})
			}
		}
	}
}

func TestManagementFilteredDiscovery(t *testing.T) {
	for _, inline := range []bool{false, true} {
		t.Run(fmt.Sprintf("inline=%t", inline), func(t *testing.T) {
			raw := `["MSSQL$SQLEXPRESS","worker@tenant\\x2d1.service","bad*","poweroff.target","example","Spooler","worker@tenant.service","example"]`
			client, calls := managementRemote(t, inline, []managementReply{{"service.get_all", raw, 200}})
			names, complete, err := client.managementServiceNames(context.Background(), "host-1")
			if err != nil || !complete || strings.Join(names, ",") != "Spooler,example,worker@tenant.service" || *calls != 1 {
				t.Fatalf("names=%v complete=%t err=%v calls=%d", names, complete, err, *calls)
			}
		})
	}
}

func TestManagementServiceOutcomes(t *testing.T) {
	for _, inline := range []bool{false, true} {
		for _, tc := range []struct{ action, mutation, read, status, code string }{
			{"start", `true`, `true`, "succeeded", "service_state_verified"},
			{"stop", `true`, `false`, "succeeded", "service_state_verified"},
			{"enable", `true`, `true`, "succeeded", "service_state_verified"},
			{"disable", `true`, `false`, "succeeded", "service_state_verified"},
			{"restart", `true`, "", "succeeded", "restart_acknowledged"},
			{"start", `false`, "", "failed", "provider_failed"},
			{"start", `"ERROR: secret"`, "", "failed", "provider_failed"},
			{"start", `{}`, "", "unknown", "unrecognized_response"},
			{"start", `null`, "", "unknown", "unrecognized_response"},
			{"start", `"true"`, "", "unknown", "unrecognized_response"},
			{"start", `true`, `false`, "unknown", "verification_mismatch"},
			{"stop", `true`, `true`, "unknown", "verification_mismatch"},
			{"enable", `true`, `null`, "unknown", "unrecognized_response"},
			{"disable", `true`, `{"example":false}`, "unknown", "unrecognized_response"},
		} {
			t.Run(fmt.Sprint(inline)+tc.action+tc.mutation+tc.read, func(t *testing.T) {
				// Unsupported names and non-service units must not block an exact
				// valid match or bypass mutation acknowledgement/state verification.
				replies := []managementReply{{"service.get_all", `["MSSQL$SQLEXPRESS","worker@tenant\\x2d1.service","bad*","poweroff.target","example"]`, 200}, {"service." + tc.action, tc.mutation, 200}}
				if tc.read != "" {
					function := "service.status"
					if tc.action == "enable" || tc.action == "disable" {
						function = "service.enabled"
					}
					replies = append(replies, managementReply{function, tc.read, 200})
				}
				client, calls := managementRemote(t, inline, replies)
				status, code := client.ManageService(context.Background(), "host-1", "example", tc.action)
				if status != tc.status || code != tc.code || *calls != len(replies) {
					t.Fatalf("%s/%s calls=%d", status, code, *calls)
				}
			})
		}
	}
}

func TestManagementRemovalOutcomes(t *testing.T) {
	for _, tc := range []struct{ raw, version, status, code string }{
		{`{"example":{"old":"1","new":""}}`, "", "succeeded", "package_removed"},
		{`{"example":{"old":"1","new":""},"dependency":{"old":"2","new":""}}`, "", "succeeded", "package_removed"},
		{`{}`, `""`, "succeeded", "package_absent"},
		{`{}`, `"1"`, "unknown", "verification_mismatch"},
		{`{}`, `null`, "unknown", "unrecognized_response"},
		{`{}`, `false`, "unknown", "unrecognized_response"},
		{`false`, "", "failed", "provider_failed"},
		{`"ERROR: private"`, "", "failed", "provider_failed"},
		{`true`, "", "unknown", "unrecognized_response"},
		{`null`, "", "unknown", "unrecognized_response"},
		{`{"jid":"123"}`, "", "unknown", "unrecognized_response"},
		{`{"other":{"old":"1","new":""}}`, "", "unknown", "unrecognized_response"},
		{`{"example":{"old":"1","new":"2"}}`, "", "unknown", "unrecognized_response"},
		{`{"example":{"old":null,"new":""}}`, "", "unknown", "unrecognized_response"},
		{`{"example":{"old":"","new":""}}`, "", "unknown", "unrecognized_response"},
		{`{"example":{"new":""}}`, "", "unknown", "unrecognized_response"},
	} {
		t.Run(tc.raw+tc.version, func(t *testing.T) {
			replies := []managementReply{{"pkg.remove", tc.raw, 200}}
			if tc.version != "" {
				replies = append(replies, managementReply{"pkg.version", tc.version, 200})
			}
			client, calls := managementRemote(t, false, replies)
			status, code := client.RemovePackage(context.Background(), "host-1", "example")
			if status != tc.status || code != tc.code || *calls != len(replies) {
				t.Fatalf("%s/%s calls=%d", status, code, *calls)
			}
		})
	}
}

func TestManagementNoRetryAndAmbiguousResponses(t *testing.T) {
	for _, inline := range []bool{false, true} {
		for _, httpStatus := range []int{202, 401, 500} {
			client, calls := managementRemote(t, inline, []managementReply{{"pkg.remove", `"secret"`, httpStatus}})
			status, _ := client.RemovePackage(context.Background(), "host-1", "example")
			if status != "unknown" || *calls != 1 {
				t.Fatal("removal retry or false success")
			}
			client, calls = managementRemote(t, inline, []managementReply{{"service.get_all", `["example"]`, 200}, {"service.restart", `true`, httpStatus}})
			status, _ = client.ManageService(context.Background(), "host-1", "example", "restart")
			if status != "unknown" || *calls != 2 {
				t.Fatal("service retry or false success")
			}
		}
	}
	for _, raw := range []string{
		`{}`, `{"return":[]}`, `{"return":[{}]}`, `{"return":[{"other":true}]}`,
		`{"return":[{"host-1":true,"other":true}]}`, `{"return":[{"host-1":true},{"host-1":true}]}`, `not-json`,
		`{"return":[{"host-1":{"example":{"old":"1","new":""}}}],"return":[{"host-1":true}]}`,
		`{"return":[{"host-1":false,"host-1":{"example":{"old":"1","new":""}}}]}`,
		`{"return":[{"host-1":{"example":{"old":"1","new":"2","new":""}}}]}`,
		`{"return":[{"host-1":{"example":{"old":"1","new":""}}}]} {}`,
		`{"return":[{"host-1":{"example":{"old":"1","new":""}}}],"error":"secret"}`,
	} {
		remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(raw)) }))
		client := NewClient(remote.URL, "fixture-token", "", "", "", "glob")
		status, _ := client.RemovePackage(context.Background(), "host-1", "example")
		remote.Close()
		if status != "unknown" {
			t.Errorf("accepted envelope %s", raw)
		}
	}
}

func TestManagementPreflightAndCancellation(t *testing.T) {
	client, calls := managementRemote(t, false, nil)
	for _, tc := range [][3]string{{"*", "example", "start"}, {"host-1", "a*", "stop"}, {"host-1", "example", "reload"}, {"host-1", "sshd", "stop"}, {"host-1", "salt-minion", "disable"}} {
		status, _ := client.ManageService(context.Background(), tc[0], tc[1], tc[2])
		if status != "failed" {
			t.Fatal("accepted unsafe service operation")
		}
	}
	for _, pair := range [][2]string{{"*", "example"}, {"host-1", "--help"}, {"host-1", "wazuh-agent"}} {
		status, _ := client.RemovePackage(context.Background(), pair[0], pair[1])
		if status != "failed" {
			t.Fatal("accepted unsafe package operation")
		}
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	status, _ := client.RemovePackage(ctx, "host-1", "example")
	if status != "unknown" || *calls != 0 {
		t.Fatal("cancelled request dispatched")
	}
	for _, tc := range []struct{ raw, status string }{{`["other"]`, "failed"}, {`null`, "unknown"}, {`["Example","example.service","bad*"]`, "failed"}, {`["example",null]`, "unknown"}, {`["example",42]`, "unknown"}, {`["example"`, "unknown"}} {
		client, calls = managementRemote(t, false, []managementReply{{"service.get_all", tc.raw, 200}})
		status, _ = client.ManageService(context.Background(), "host-1", "example", "start")
		if status != tc.status || *calls != 1 {
			t.Fatal("mutated unvalidated service")
		}
	}
}

func TestManagementDiscoveryLimitBeforeFiltering(t *testing.T) {
	for _, inline := range []bool{false, true} {
		for _, tc := range []struct {
			name, filler string
			count, match int
			complete     bool
		}{
			{"at limit", "other", managementServiceLimit, 0, true},
			{"at limit filtered", `MSSQL$SQLEXPRESS`, managementServiceLimit, managementServiceLimit - 1, true},
			{"match before truncation", "other", managementServiceLimit + 1, 0, false},
			{"match after truncation", "other", managementServiceLimit + 1, managementServiceLimit, false},
			{"filtered over limit", `MSSQL$SQLEXPRESS`, managementServiceLimit + 1, 0, false},
			{"non-service over limit", "poweroff.target", managementServiceLimit + 1, 0, false},
		} {
			t.Run(fmt.Sprintf("inline=%t/%s", inline, tc.name), func(t *testing.T) {
				names := make([]string, tc.count)
				for i := range names {
					names[i] = tc.filler
				}
				names[tc.match] = "example"
				raw, _ := json.Marshal(names)
				replies := []managementReply{{"service.get_all", string(raw), 200}}
				wantStatus, wantCode := "unknown", "service_validation_unavailable"
				if tc.complete {
					replies = append(replies, managementReply{"service.start", `true`, 200}, managementReply{"service.status", `true`, 200})
					wantStatus, wantCode = "succeeded", "service_state_verified"
				}
				client, calls := managementRemote(t, inline, replies)
				status, code := client.ManageService(context.Background(), "host-1", "example", "start")
				if status != wantStatus || code != wantCode || *calls != len(replies) {
					t.Fatalf("%s/%s calls=%d", status, code, *calls)
				}
			})
		}
	}
}

func TestManagementDiscoveryFailureNoDispatch(t *testing.T) {
	for _, tc := range []struct {
		name, raw string
		status    int
	}{
		{"unauthorized", `["example"]`, 401},
		{"provider unavailable", `["example"]`, 500},
		{"async acknowledgement", `["example"]`, 202},
		{"provider failure", `"ERROR: unavailable"`, 200},
		{"oversized discovery", `["example","` + strings.Repeat("x", 2*1024*1024) + `"]`, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, calls := managementRemote(t, false, []managementReply{{"service.get_all", tc.raw, tc.status}})
			status, code := client.ManageService(context.Background(), "host-1", "example", "start")
			if status != "unknown" || code != "service_validation_unavailable" || *calls != 1 {
				t.Fatalf("%s/%s calls=%d", status, code, *calls)
			}
		})
	}
}

func TestManagementBoundsAndVerificationFailures(t *testing.T) {
	names := make([]string, managementServiceLimit+1)
	for i := range names {
		names[i] = fmt.Sprintf("service-%d", i)
	}
	raw, _ := json.Marshal(names)
	client, calls := managementRemote(t, false, []managementReply{{"service.get_all", string(raw), 200}})
	items, status := client.ListManagedServices(context.Background(), "host-1")
	if len(items) != managementServiceLimit || status != "partial" || *calls != 1 {
		t.Fatal("unbounded listing")
	}
	client, calls = managementRemote(t, false, []managementReply{{"service.get_all", string(raw), 200}})
	status, code := client.ManageService(context.Background(), "host-1", "example", "stop")
	if status != "unknown" || code != "service_validation_unavailable" || *calls != 1 {
		t.Fatal("incomplete service discovery allowed mutation")
	}
	client, calls = managementRemote(t, false, []managementReply{{"service.get_all", `"` + strings.Repeat("x", 2*1024*1024) + `"`, 200}})
	_, status = client.ListManagedServices(context.Background(), "host-1")
	if status != "unavailable" || *calls != 1 {
		t.Fatal("oversized response accepted")
	}
	client, calls = managementRemote(t, false, []managementReply{{"pkg.remove", `{}`, 200}, {"pkg.version", `""`, 500}})
	status, code = client.RemovePackage(context.Background(), "host-1", "example")
	if status != "unknown" || code != "verification_unavailable" || *calls != 2 {
		t.Fatal("verification failure reported success")
	}
	client, calls = managementRemote(t, false, []managementReply{{"service.get_all", `["example"]`, 200}, {"service.start", `true`, 200}, {"service.status", `true`, 500}})
	status, code = client.ManageService(context.Background(), "host-1", "example", "start")
	if status != "unknown" || code != "verification_unavailable" || *calls != 3 {
		t.Fatal("service verification failure reported success")
	}
}

func TestManagementMutationsNeverFollowRedirects(t *testing.T) {
	for _, inline := range []bool{false, true} {
		for _, operation := range []string{"install", "remove", "restart"} {
			t.Run(fmt.Sprintf("inline=%t/%s", inline, operation), func(t *testing.T) {
				var forwarded, mutations atomic.Int32
				destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					forwarded.Add(1)
					w.WriteHeader(http.StatusOK)
				}))
				defer destination.Close()
				remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					var function string
					if inline {
						_ = r.ParseForm()
						function = r.Form.Get("fun")
					} else {
						var payload struct {
							Function string `json:"fun"`
						}
						_ = json.NewDecoder(r.Body).Decode(&payload)
						function = payload.Function
					}
					if function == "service.get_all" {
						_, _ = w.Write([]byte(`{"return":[{"host-1":["example"]}]}`))
						return
					}
					mutations.Add(1)
					http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
				}))
				defer remote.Close()
				token := "fixture-token"
				if inline {
					token = ""
				}
				client := NewClient(remote.URL, token, "fixture-user", "fixture-password", "pam", "glob")
				var status string
				switch operation {
				case "install":
					status, _ = client.InstallPackage(context.Background(), "host-1", "example")
				case "remove":
					status, _ = client.RemovePackage(context.Background(), "host-1", "example")
				case "restart":
					status, _ = client.ManageService(context.Background(), "host-1", "example", "restart")
				}
				if status != "unknown" || forwarded.Load() != 0 || mutations.Load() != 1 {
					t.Fatalf("status=%s forwarded=%d mutations=%d", status, forwarded.Load(), mutations.Load())
				}
			})
		}
	}
}
