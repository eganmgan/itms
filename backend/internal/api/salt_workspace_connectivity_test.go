package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"itms/backend/internal/integrations/saltstack"
)

func TestSaltWorkspaceConnectivityBatchedAfterRowsClose(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	var requests atomic.Int32
	salt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Errorf("DB rows still open during Salt wait: %v", err)
		}
		var payload struct {
			Targets []string `json:"tgt"`
			Type    string   `json:"expr_form"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || !reflect.DeepEqual(payload.Targets, []string{"alpha", "beta"}) || payload.Type != "list" {
			t.Errorf("unexpected batch: %+v %v", payload, err)
		}
		_, _ = w.Write([]byte(`{"return":[{"alpha":true,"beta":false}]}`))
	}))
	defer salt.Close()
	server.salt = saltstack.NewClient(salt.URL, "test-token", "", "", "", "glob")
	c, _ := newTestContext(http.MethodGet, "/", newTestClaims("it_team", "u", "e"))
	rows := sqlmock.NewRows([]string{"id", "tag", "hostname", "name", "category", "os", "last_seen", "status", "cost", "salt", "owner", "dept", "location", "alerts", "updates"})
	for _, target := range []string{"alpha", "beta", "alpha", ""} {
		rows.AddRow("id", "tag", "never-ping-hostname", "name", "laptop", "Linux", "2026-09-19T00:00:00Z", "active", "0", target, "owner", "dept", "branch", 0, 0)
	}
	mock.ExpectQuery(`(?s)SELECT a\.id,.*WHERE a\.is_compute = TRUE AND \(a\.entity_id = \$1::uuid OR EXISTS \(SELECT 1 FROM user_entity_access uea WHERE uea\.user_id = \$2::uuid AND uea\.entity_id = a\.entity_id\)\)`).
		WithArgs("e", "u").WillReturnRows(rows).RowsWillBeClosed()
	items, summary, err := server.loadSaltWorkspaceAssets(c)
	if err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 1 || summary["connectedTargets"] != 2 || summary["linkedTargets"] != 3 {
		t.Fatalf("unexpected batching/summary: %d %v", requests.Load(), summary)
	}
	for index, want := range []*bool{connectivityBool(true), connectivityBool(false), connectivityBool(true), nil} {
		if !reflect.DeepEqual(items[index]["connected"], want) {
			t.Fatalf("unexpected connectivity: %v", items[index])
		}
	}
	if items[3]["connectivitySource"] != "unmanaged" || items[3]["cost"] != "0" {
		t.Fatalf("unmanaged/cost mapping: %v", items[3])
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestSaltWorkspaceConnectivityQueryDeadline(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	c, _ := newTestContext(http.MethodGet, "/", newTestClaims("it_team", "u", "e"))
	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Millisecond)
	defer cancel()
	c.Request = c.Request.WithContext(ctx)
	mock.ExpectQuery(`SELECT a\.id,`).WithArgs("e", "u").WillDelayFor(time.Second).
		WillReturnRows(sqlmock.NewRows([]string{"id"}))
	start := time.Now()
	if _, _, err := server.loadSaltWorkspaceAssets(c); err == nil {
		t.Fatal("expected canceled query")
	}
	if time.Since(start) > 500*time.Millisecond {
		t.Fatal("workspace query ignored request deadline")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
