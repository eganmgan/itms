package saltstack

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRunStatePreservesRawFailureOutput(t *testing.T) {
	const body = `{"return":[{"host":{"pkg_|-update":{"result":false,"comment":"partial failure","changes":{"openssl":{"old":"1","new":"2"}},"stdout":"actual output\n","stderr":"actual error","retcode":7}}}]}`
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer peer.Close()
	client := NewClient(peer.URL, "", "test", "test", "file", "glob")
	result, err := client.RunState(context.Background(), "host", "patch.run")
	if err == nil {
		t.Fatal("expected Salt state failure")
	}
	payload, marshalErr := json.Marshal(result)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	for _, fragment := range []string{"actual output", "actual error", `"retcode":7`, `"old":"1"`, `"new":"2"`} {
		if !strings.Contains(string(payload), fragment) {
			t.Fatalf("lost failure data %q: %s", fragment, payload)
		}
	}
}
