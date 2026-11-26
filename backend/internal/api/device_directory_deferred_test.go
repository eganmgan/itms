package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"itms/backend/internal/integrations/saltstack"
)

func TestDeviceDirectoryDeferredNeverProbes(t *testing.T) {
	for _, role := range []string{"super_admin", "admin", "it_team", "employee", "auditor"} {
		t.Run(role, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			var calls atomic.Int32
			salt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				http.Error(w, "must never probe", 503)
			}))
			defer salt.Close()
			server.salt = saltstack.NewClient(salt.URL, "test-token", "", "", "", "glob")
			expectDirectoryConnectivityQueries(mock, role, 0)
			c, recorder := newTestContext(http.MethodGet, "/api/devices/directory?connectivity=deferred", newTestClaims(role, "u", "e"))
			server.listDeviceDirectory(c)
			assertRouteResult(t, mock, recorder, 200, "deferred directory")
			var body struct {
				Users []deviceDirectoryUser `json:"users"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if calls.Load() != 0 || recorder.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("deferred inventory probed Salt or was cacheable")
			}
			for _, user := range body.Users {
				if user.Status != "online" || user.ConnectivityCheckedAt == nil {
					t.Fatalf("inventory retained live state: %+v", user)
				}
				for _, asset := range user.Assets {
					if asset.ConnectivityCheckedAt == nil || asset.SaltMinionID != "" {
						t.Fatalf("inventory retained live state or exposed target: %+v", asset)
					}
					if asset.ConnectivitySource != "agent_heartbeat" {
						t.Fatalf("unexpected source: %+v", asset)
					}
				}
			}
		})
	}
}

// Independent expected SQL keeps both the owner and asset authorization
// predicates under test; no additional per-owner/device lookup is permitted.
func directoryBatchQuery(role string) string {
	userScope, assetScope := "TRUE", "TRUE"
	if role == "employee" {
		userScope, assetScope = "u.id = $2::uuid", "a.assigned_to = $2::uuid"
	} else if !isAdminRole(role) {
		userScope = `(u.entity_id = $1::uuid OR EXISTS (
			SELECT 1 FROM user_entity_access uea
			WHERE uea.user_id = $2::uuid AND uea.entity_id = u.entity_id
		))`
		assetScope = `(a.entity_id = $1::uuid OR EXISTS (
			SELECT 1 FROM user_entity_access uea
			WHERE uea.user_id = $2::uuid AND uea.entity_id = a.entity_id
		))`
	}
	return regexp.QuoteMeta(`SELECT u.id::text, COALESCE(a.id::text, ''), a.last_heartbeat_at
		FROM users u
		LEFT JOIN assets a ON a.assigned_to = u.id AND a.is_compute = TRUE AND ` + assetScope + `
		WHERE $1::text IS NOT NULL AND $2::text IS NOT NULL AND u.is_active = TRUE AND ` + userScope + `
		ORDER BY u.id, a.id`)
}

func TestDeviceDirectorySeparateConnectivityScopeAndExactBatch(t *testing.T) {
	for _, role := range []string{"super_admin", "admin", "it_team", "employee", "auditor"} {
		t.Run(role, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			var calls atomic.Int32
			salt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if err := mock.ExpectationsWereMet(); err != nil {
					t.Errorf("scan must finish and close before probe: %v", err)
				}
				var payload struct {
					Targets []string `json:"tgt"`
					Type    string   `json:"expr_form"`
				}
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.Type != "list" || !reflect.DeepEqual(payload.Targets, []string{"alpha", "literal*", "beta"}) {
					t.Errorf("not an exact deduplicated authorized batch: %+v, %v", payload, err)
				}
				_, _ = w.Write([]byte(`{"return":[{"alpha":true,"literal*":false,"outside-scope":true}]}`))
			}))
			defer salt.Close()
			server.salt = saltstack.NewClient(salt.URL, "test-token", "", "", "", "glob")
			mock.ExpectQuery(directoryBatchQuery(role)).WithArgs("e", "u").WillReturnRows(sqlmock.NewRows([]string{"user", "asset", "last_heartbeat_at"}).
				AddRow("u", "a", time.Now()).AddRow("u", "b", time.Now().Add(-5*time.Minute)).AddRow("u", "c", time.Now()).
				AddRow("u", "d", nil).AddRow("offline", "e", time.Now().Add(-5*time.Minute)).AddRow("unknown", "f", nil).AddRow("empty", "", nil)).RowsWillBeClosed()
			c, recorder := newTestContext(http.MethodGet, "/api/devices/directory/connectivity?targets=outside-scope", newTestClaims(role, "u", "e"))
			server.listDeviceDirectoryConnectivity(c)
			assertRouteResult(t, mock, recorder, 200, "separate scoped batch")
			var body struct {
				Users []deviceDirectoryUser `json:"users"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if calls.Load() != 0 || recorder.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("heartbeat directory must not probe Salt or cache responses")
			}
			for i, status := range []string{"online", "offline", "unknown", "unassigned"} {
				if body.Users[i].Status != status {
					t.Fatalf("unexpected aggregation: %+v", body.Users)
				}
			}
			for i, status := range []string{"online", "offline", "online", "unknown"} {
				if body.Users[0].Assets[i].Status != status {
					t.Fatalf("unexpected asset states: %+v", body.Users[0])
				}
			}
			for _, forbidden := range []string{"outside-scope", "saltMinionId", "fullName", "summary", "capabilities"} {
				if strings.Contains(recorder.Body.String(), forbidden) {
					t.Fatalf("status-only response exposed %s", forbidden)
				}
			}
		})
	}
}

func TestDeviceDirectorySeparateConnectivityFailures(t *testing.T) {
	for _, scenario := range []string{"empty-scope", "unconfigured", "unavailable", "malformed", "query", "scan", "rows", "deadline"} {
		t.Run(scenario, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			var calls atomic.Int32
			salt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if scenario == "malformed" {
					_, _ = w.Write([]byte(`{"return":[{"managed":"true"}]}`))
				} else {
					http.Error(w, "unavailable", 503)
				}
			}))
			defer salt.Close()
			if scenario != "unconfigured" {
				server.salt = saltstack.NewClient(salt.URL, "test-token", "", "", "", "glob")
			}
			c, recorder := newTestContext(http.MethodGet, "/?targets=hidden", newTestClaims("admin", "u", "e"))
			rows := sqlmock.NewRows([]string{"user", "asset", "target"})
			if scenario != "empty-scope" {
				rows.AddRow("u", "a", nil)
			}
			expect := mock.ExpectQuery(directoryBatchQuery("admin")).WithArgs("e", "u")
			status := 200
			switch scenario {
			case "query":
				expect.WillReturnError(errors.New("database unavailable"))
				status = 500
			case "scan":
				expect.WillReturnRows(sqlmock.NewRows([]string{"user", "asset", "target"}).AddRow(nil, "a", "managed")).RowsWillBeClosed()
				status = 500
			case "rows":
				expect.WillReturnRows(rows.RowError(0, errors.New("interrupted"))).RowsWillBeClosed()
				status = 500
			case "deadline":
				ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Millisecond)
				defer cancel()
				c.Request = c.Request.WithContext(ctx)
				expect.WillDelayFor(time.Second).WillReturnRows(rows)
				status = 500
			default:
				expect.WillReturnRows(rows).RowsWillBeClosed()
			}
			server.listDeviceDirectoryConnectivity(c)
			assertRouteResult(t, mock, recorder, status, scenario)
			wantCalls := int32(0)
			if calls.Load() != wantCalls || recorder.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("unexpected probes/cache: %d, %v", calls.Load(), recorder.Header())
			}
			if status == 200 && scenario != "empty-scope" && !strings.Contains(recorder.Body.String(), `"status":"unknown"`) {
				t.Fatalf("failed/unconfigured probe must be unknown: %s", recorder.Body)
			}
			if scenario == "empty-scope" && recorder.Body.String() != `{"users":[]}` {
				t.Fatalf("out-of-scope targets leaked: %s", recorder.Body)
			}
		})
	}
}

func TestDeviceDirectorySeparateConnectivityQueryCancellation(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	c, recorder := newTestContext(http.MethodGet, "/", newTestClaims("admin", "u", "e"))
	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Millisecond)
	defer cancel()
	c.Request = c.Request.WithContext(ctx)
	mock.ExpectQuery(directoryBatchQuery("admin")).WithArgs("e", "u").WillDelayFor(time.Second).
		WillReturnRows(sqlmock.NewRows([]string{"user", "asset", "last_heartbeat_at"}))
	start := time.Now()
	server.listDeviceDirectoryConnectivity(c)
	assertRouteResult(t, mock, recorder, 500, "cancelled heartbeat query")
	if time.Since(start) > 500*time.Millisecond {
		t.Fatal("heartbeat query ignored cancellation")
	}
}

func TestDeviceDirectorySeparateConnectivityRouteAuth(t *testing.T) {
	for i, role := range []string{"super_admin", "admin", "it_team", "employee", "auditor", "manager", "anonymous"} {
		t.Run(role, func(t *testing.T) {
			mock, recorder, router, request, cleanup := newRoleRouteRequest(t, role, "u", "e", http.MethodGet, "/api/devices/directory/connectivity", "")
			defer cleanup()
			request.RemoteAddr = fmt.Sprintf("198.51.100.%d:4321", 100+i)
			status := 200
			if role == "anonymous" {
				request.Header.Del("Authorization")
				status = 401
			} else if role == "manager" {
				status = 403
			} else {
				mock.ExpectQuery(directoryBatchQuery(role)).WithArgs("e", "u").WillReturnRows(sqlmock.NewRows([]string{"user", "asset", "target"}))
			}
			router.ServeHTTP(recorder, request)
			assertRouteResult(t, mock, recorder, status, "directory connectivity route")
		})
	}
}
