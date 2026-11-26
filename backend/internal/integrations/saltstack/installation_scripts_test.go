package saltstack

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestApplyInstallationScript(t *testing.T) {
	for _, test := range []struct{ name, language, result, status, code string }{
		{"shell success", "sh", `{"retcode":0,"stdout":"private"}`, "succeeded", "script_exited_zero"},
		{"shell failure", "sh", `{"retcode":1}`, "failed", "script_exited_nonzero"},
		{"missing exit", "sh", `{}`, "unknown", "unrecognized_response"},
		{"null exit", "sh", `{"retcode":null}`, "unknown", "unrecognized_response"},
		{"salt success", "sls", `{"state":{"result":true}}`, "succeeded", "state_completed"},
		{"salt failure", "sls", `{"state":{"result":false}}`, "failed", "state_failed"},
		{"salt unknown", "sls", `{"state":{"result":null}}`, "unknown", "unrecognized_response"},
		{"empty salt", "sls", `{}`, "unknown", "unrecognized_response"},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			provider := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				calls++
				var payload map[string]any
				if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
					t.Error(err)
				}
				if request.URL.Path != "/run" || payload["tgt_type"] != "list" || payload["expr_form"] != "list" {
					t.Errorf("unsafe dispatch: %v", payload)
				}
				targets, _ := payload["tgt"].([]any)
				if len(targets) != 1 || targets[0] != "host-1" {
					t.Errorf("targets: %v", targets)
				}
				function := "state.template_str"
				if test.language == "sh" {
					function = "cmd.run_all"
				}
				if payload["fun"] != function {
					t.Errorf("function: %v", payload["fun"])
				}
				fmt.Fprintf(writer, `{"return":[{"host-1":%s}]}`, test.result)
			}))
			defer provider.Close()
			client := NewClient(provider.URL, "test-token", "", "", "", "glob")
			status, code := client.ApplyInstallationScript(context.Background(), "host-1", test.language, "echo test")
			if status != test.status || code != test.code || calls != 1 {
				t.Fatalf("%s %s calls=%d", status, code, calls)
			}
		})
	}
}

func TestInstallationScriptRejectsAmbiguousProviderResponses(t *testing.T) {
	for _, response := range []string{`{"return":[{"other":{"retcode":0}}]}`, `{"return":[{"host-1":{"retcode":0},"other":{"retcode":0}}]}`, `{"return":[{"host-1":{"retcode":1,"retcode":0}}]}`, `{"return":[{"host-1":{"retcode":0}}]} {}`, `{"jid":"queued"}`} {
		calls := 0
		provider := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) { calls++; fmt.Fprint(writer, response) }))
		client := NewClient(provider.URL, "test-token", "", "", "", "glob")
		status, _ := client.ApplyInstallationScript(context.Background(), "host-1", "sh", "echo test")
		provider.Close()
		if status != "unknown" || calls != 1 {
			t.Fatalf("response %s yielded %s after %d calls", response, status, calls)
		}
	}
}
