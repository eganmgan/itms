package saltstack

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"
	"time"
)

func TestConnectedTargetsExactBatch(t *testing.T) {
	for _, token := range []string{"", "test-token"} {
		t.Run(token, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				want := []string{"online", "offline", "omitted", "literal*", "comma,id"}
				if token == "" {
					if err := r.ParseForm(); err != nil {
						t.Error(err)
					}
					if !reflect.DeepEqual(r.Form["tgt"], want) || r.Form.Get("expr_form") != "list" || r.Form.Get("tgt_type") != "list" || r.Form.Get("fun") != "test.ping" || r.Form.Get("timeout") != "1" || r.Form.Get("gather_job_timeout") != "1" || r.Form.Get("client") != "local" {
						t.Errorf("unexpected exact-list request: %v", r.Form)
					}
				} else {
					var payload struct {
						Targets       []string `json:"tgt"`
						Type          string   `json:"expr_form"`
						Fun           string   `json:"fun"`
						Timeout       int      `json:"timeout"`
						TargetType    string   `json:"tgt_type"`
						GatherTimeout int      `json:"gather_job_timeout"`
					}
					if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
						t.Error(err)
					}
					if !reflect.DeepEqual(payload.Targets, want) || payload.Type != "list" || payload.TargetType != "list" || payload.Fun != "test.ping" || payload.Timeout != 1 || payload.GatherTimeout != 1 {
						t.Errorf("unexpected JSON request: %+v", payload)
					}
				}
				_, _ = w.Write([]byte(`{"return":[{"online":true,"offline":false,"other-entity":true}]}`))
			}))
			defer server.Close()
			client := NewClient(server.URL, token, "test-user", "test-password", "pam", "glob")
			got, err := client.ConnectedTargets(context.Background(), []string{" online ", "offline", "omitted", "online", "", "literal*", "comma,id"})
			want := map[string]bool{"online": true, "offline": false, "omitted": false, "literal*": false, "comma,id": false}
			if err != nil || !reflect.DeepEqual(got, want) || requests.Load() != 1 {
				t.Fatalf("got %v, %v, requests=%d", got, err, requests.Load())
			}
		})
	}
}

func TestConnectedTargetsResponseValidation(t *testing.T) {
	for _, tc := range []struct {
		body string
		fail bool
	}{
		{`{"return":[{}]}`, false}, {`{"return":[]}`, false},
		{`{"return":[{"target":false}]}`, false},
		{`{}`, true}, {`{"return":null}`, true}, {`{"return":[null]}`, true},
		{`{"return":[{"target":null}]}`, true}, {`{"return":[{"target":"true"}]}`, true},
		{`{"return":[{"target":1}]}`, true}, {`{"return":[{"target":{"error":"failed"}}]}`, true},
		{`{"return":["authentication failed"]}`, true}, {`not-json`, true},
	} {
		t.Run(tc.body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			client := NewClient(server.URL, "test-token", "", "", "", "glob")
			got, err := client.ConnectedTargets(context.Background(), []string{"target"})
			if (err != nil) != tc.fail || (!tc.fail && got["target"]) {
				t.Fatalf("got %v, %v", got, err)
			}
		})
	}
}

type connectivityTransport func(*http.Request) (*http.Response, error)

func (f connectivityTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestConnectedTargetsDeadline(t *testing.T) {
	for _, parentBound := range []time.Duration{0, 20 * time.Millisecond} {
		t.Run(parentBound.String(), func(t *testing.T) {
			t.Parallel()
			client := NewClient("http://salt.invalid", "test-token", "", "", "", "glob")
			client.httpClient.Transport = connectivityTransport(func(r *http.Request) (*http.Response, error) {
				deadline, ok := r.Context().Deadline()
				if !ok || time.Until(deadline) > 5*time.Second {
					t.Error("missing five-second HTTP request bound")
					return nil, errors.New("missing deadline")
				}
				<-r.Context().Done()
				return nil, r.Context().Err()
			})
			ctx := context.Background()
			if parentBound > 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, parentBound)
				defer cancel()
			}
			start := time.Now()
			_, err := client.ConnectedTargets(ctx, []string{"target"})
			if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 6*time.Second {
				t.Fatalf("deadline not respected: %v after %v", err, time.Since(start))
			}
		})
	}
}

func TestConnectedTargetsEmptyAndUnconfigured(t *testing.T) {
	var client *Client
	if got, err := client.ConnectedTargets(context.Background(), []string{"", " "}); err != nil || len(got) != 0 {
		t.Fatalf("empty target set: %v, %v", got, err)
	}
	if _, err := client.ConnectedTargets(context.Background(), []string{"managed"}); err == nil {
		t.Fatal("unconfigured integration must not report offline")
	}
}
