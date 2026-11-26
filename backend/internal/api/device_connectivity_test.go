package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"

	"itms/backend/internal/integrations/saltstack"
)

func TestDeviceConnectivityScopedSingleQuery(t *testing.T) {
	for _, role := range []string{"super_admin", "admin", "it_team", "auditor", "employee"} {
		t.Run(role, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			c, recorder := newTestContext(http.MethodGet, "/api/devices/device-1/connectivity", newTestClaims(role, "user-1", "entity-1"))
			c.Params = gin.Params{{Key: "id", Value: "device-1"}}
			scope := "TRUE"
			if role == "employee" {
				scope = "a.assigned_to = $2::uuid"
			} else if !isAdminRole(role) {
				scope = `(a.entity_id = $1::uuid OR EXISTS (
					SELECT 1 FROM user_entity_access uea
					WHERE uea.user_id = $2::uuid AND uea.entity_id = a.entity_id
				))`
			}
			query := `SELECT COALESCE(a.salt_minion_id, ''), a.last_heartbeat_at FROM assets a
				WHERE $1::text IS NOT NULL AND $2::text IS NOT NULL
				AND a.id = $3::uuid AND a.is_compute = TRUE AND ` + scope
			mock.ExpectQuery(regexp.QuoteMeta(query)).WithArgs("entity-1", "user-1", "device-1").
				WillReturnRows(sqlmock.NewRows([]string{"salt_minion_id", "last_heartbeat_at"}).AddRow("managed", nil))
			server.getDeviceConnectivity(c)
			assertRouteResult(t, mock, recorder, http.StatusOK, "scoped connectivity")
			if recorder.Header().Get("Cache-Control") != "no-store" || !strings.Contains(recorder.Body.String(), `"connected":null`) || !strings.Contains(recorder.Body.String(), `"connectivitySource":"salt_unconfigured"`) {
				t.Fatalf("unexpected response: %s %v", recorder.Body, recorder.Header())
			}
		})
	}
}

func TestDeviceConnectivityOutOfScopeDoesNotPing(t *testing.T) {
	for _, role := range []string{"admin", "employee", "it_team", "auditor"} {
		t.Run(role, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			var calls atomic.Int32
			salt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = w.Write([]byte(`{"return":[{}]}`))
			}))
			defer salt.Close()
			server.salt = saltstack.NewClient(salt.URL, "test-token", "", "", "", "glob")
			c, recorder := newTestContext(http.MethodGet, "/", newTestClaims(role, "u", "e"))
			c.Params = gin.Params{{Key: "id", Value: "hidden"}}
			mock.ExpectQuery(`SELECT COALESCE\(a.salt_minion_id`).WithArgs("e", "u", "hidden").WillReturnError(sql.ErrNoRows)
			server.getDeviceConnectivity(c)
			assertRouteResult(t, mock, recorder, http.StatusNotFound, "hidden device")
			if calls.Load() != 0 || recorder.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("hidden device triggered a probe or cacheable response")
			}
		})
	}
}

func TestDeviceConnectivityStates(t *testing.T) {
	for _, tc := range []struct {
		name, target, body, source string
		status                     int
		connected                  *bool
		attempted                  bool
	}{
		{"online", "managed", `{"return":[{"managed":true}]}`, "salt_ping", 200, connectivityBool(true), true},
		{"offline", "managed", `{"return":[{"managed":false}]}`, "salt_ping", 200, connectivityBool(false), true},
		{"omitted", "managed", `{"return":[{}]}`, "salt_ping", 200, connectivityBool(false), true},
		{"failure", "managed", `failure`, "salt_unavailable", 503, nil, true},
		{"malformed", "managed", `{"return":[{"managed":"true"}]}`, "salt_unavailable", 200, nil, true},
		{"unmanaged", " ", ``, "unmanaged", 200, nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			var calls atomic.Int32
			salt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var payload struct {
					Targets []string `json:"tgt"`
					Type    string   `json:"expr_form"`
				}
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || !reflect.DeepEqual(payload.Targets, []string{"managed"}) || payload.Type != "list" {
					t.Errorf("unexpected probe %+v: %v", payload, err)
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer salt.Close()
			server.salt = saltstack.NewClient(salt.URL, "test-token", "", "", "", "glob")
			c, recorder := newTestContext(http.MethodGet, "/", newTestClaims("super_admin", "u", "e"))
			c.Params = gin.Params{{Key: "id", Value: "device"}}
			mock.ExpectQuery(`SELECT COALESCE\(a.salt_minion_id`).WithArgs("e", "u", "device").
				WillReturnRows(sqlmock.NewRows([]string{"salt_minion_id", "last_heartbeat_at"}).AddRow(tc.target, time.Now()))
			server.getDeviceConnectivity(c)
			assertRouteResult(t, mock, recorder, 200, tc.name)
			var result deviceConnectivity
			if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.ConnectivitySource != "agent_heartbeat" || result.Connected == nil || !*result.Connected || result.LastHeartbeatAt == nil || result.Salt == nil {
				t.Fatalf("heartbeat must be independent of Salt: %+v", result)
			}
			result = *result.Salt
			if result.ConnectivitySource != tc.source || !reflect.DeepEqual(result.Connected, tc.connected) || (result.ConnectivityCheckedAt != nil) != tc.attempted || (calls.Load() == 1) != tc.attempted {
				t.Fatalf("unexpected state: %+v, calls=%d", result, calls.Load())
			}
			if result.ConnectivityCheckedAt != nil {
				if _, err := time.Parse(time.RFC3339Nano, *result.ConnectivityCheckedAt); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func connectivityBool(value bool) *bool { return &value }

func TestDeviceConnectivityHeartbeatDoesNotProbeSalt(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	var calls atomic.Int32
	salt := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		writer.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer salt.Close()
	server.salt = saltstack.NewClient(salt.URL, "test-token", "", "", "", "glob")
	context, recorder := newTestContext(http.MethodGet, "/api/devices/device/connectivity?presence=heartbeat", newTestClaims("employee", "user", "entity"))
	context.Params = gin.Params{{Key: "id", Value: "device"}}
	mock.ExpectQuery(`SELECT COALESCE\(a.salt_minion_id`).WithArgs("entity", "user", "device").
		WillReturnRows(sqlmock.NewRows([]string{"salt_minion_id", "last_heartbeat_at"}).AddRow("managed", time.Now()))
	server.getDeviceConnectivity(context)
	assertRouteResult(t, mock, recorder, http.StatusOK, "heartbeat-only connectivity")
	var result deviceConnectivity
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 0 || result.Salt != nil || result.Connected == nil || !*result.Connected || result.ConnectivitySource != "agent_heartbeat" || result.ConnectivityCheckedAt == nil || recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("heartbeat response must not depend on Salt: %+v, calls=%d", result, calls.Load())
	}
}

func TestHeartbeatConnectivityFreshness(t *testing.T) {
	now := time.Date(2026, 9, 29, 9, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name    string
		age     time.Duration
		missing bool
		want    *bool
	}{
		{"never reported", 0, true, nil},
		{"fresh", 30 * time.Second, false, connectivityBool(true)},
		{"boundary", 90 * time.Second, false, connectivityBool(true)},
		{"stale", 90*time.Second + time.Nanosecond, false, connectivityBool(false)},
		{"future", -time.Second, false, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			lastContact := now.Add(-test.age)
			var heartbeat *time.Time
			if !test.missing {
				heartbeat = &lastContact
			}
			result := heartbeatConnectivity(heartbeat, now)
			if !reflect.DeepEqual(result.Connected, test.want) || result.ConnectivitySource != "agent_heartbeat" || result.ConnectivityCheckedAt == nil {
				t.Fatalf("unexpected heartbeat status: %+v", result)
			}
		})
	}
}

func TestHeartbeatRecordsServerContactOnly(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	server.config.InventoryIngestToken = "synthetic-ingest"
	c, recorder := newTestContext(http.MethodPut, "/api/assets/heartbeat", nil)
	c.Request = httptest.NewRequest(http.MethodPut, "/api/assets/heartbeat", strings.NewReader(`{"asset_tag":"DEVICE-1"}`))
	c.Request.Header.Set("X-Inventory-Token", "synthetic-ingest")
	receivedAt := time.Date(2026, 9, 29, 9, 0, 0, 0, time.UTC)
	mock.ExpectQuery(regexp.QuoteMeta(`UPDATE assets SET last_heartbeat_at = NOW()
		WHERE asset_tag = $1 AND is_compute = TRUE RETURNING id::text, last_heartbeat_at`)).
		WithArgs("DEVICE-1").WillReturnRows(sqlmock.NewRows([]string{"id", "last_heartbeat_at"}).AddRow("device-1", receivedAt))
	server.heartbeat(c)
	assertRouteResult(t, mock, recorder, http.StatusOK, "heartbeat")
	if !strings.Contains(recorder.Body.String(), `"timestamp":"2026-09-29T09:00:00Z"`) {
		t.Fatalf("missing server receipt: %s", recorder.Body)
	}
}

func TestHeartbeatRejectsInvalidRequests(t *testing.T) {
	for _, test := range []struct {
		name, token, body string
		status            int
	}{
		{"missing token", "", `{"asset_tag":"DEVICE-1"}`, 401},
		{"invalid token", "wrong", `{"asset_tag":"DEVICE-1"}`, 401},
		{"missing identity", "synthetic-ingest", `{}`, 400},
		{"malformed", "synthetic-ingest", `{`, 400},
		{"oversized", "synthetic-ingest", `{"asset_tag":"` + strings.Repeat("a", 5000) + `"}`, 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			server.config.InventoryIngestToken = "synthetic-ingest"
			c, recorder := newTestContext(http.MethodPut, "/", nil)
			c.Request = httptest.NewRequest(http.MethodPut, "/api/assets/heartbeat", strings.NewReader(test.body))
			c.Request.Header.Set("Authorization", "Bearer "+test.token)
			server.heartbeat(c)
			assertRouteResult(t, mock, recorder, test.status, test.name)
		})
	}
}

func TestDeviceConnectivityDBRequestDeadline(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	c, recorder := newTestContext(http.MethodGet, "/", newTestClaims("super_admin", "u", "e"))
	c.Params = gin.Params{{Key: "id", Value: "device"}}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Millisecond)
	defer cancel()
	c.Request = c.Request.WithContext(ctx)
	mock.ExpectQuery(`SELECT COALESCE\(a.salt_minion_id`).WillDelayFor(time.Second).
		WillReturnRows(sqlmock.NewRows([]string{"salt_minion_id", "last_heartbeat_at"}).AddRow("managed", nil))
	start := time.Now()
	server.getDeviceConnectivity(c)
	assertRouteResult(t, mock, recorder, 500, "database timeout")
	if time.Since(start) > 500*time.Millisecond {
		t.Fatal("query did not honor the request deadline")
	}
}

func TestDeviceConnectivityRouteRegistered(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "super_admin", "u", "e", http.MethodGet, "/api/devices/device/connectivity", "")
	defer cleanup()
	mock.ExpectQuery(`SELECT COALESCE\(a.salt_minion_id`).WithArgs("e", "u", "device").
		WillReturnRows(sqlmock.NewRows([]string{"salt_minion_id", "last_heartbeat_at"}).AddRow("", nil))
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, 200, "connectivity route")
}

func TestDeviceConnectivityRejectsUnknownRole(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	c, recorder := newTestContext(http.MethodGet, "/", newTestClaims("manager", "u", "e"))
	server.getDeviceConnectivity(c)
	assertRouteResult(t, mock, recorder, 403, "unauthorized role")
}
