package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"itms/backend/internal/integrations/saltstack"
)

func expectDirectoryConnectivityQueries(mock sqlmock.Sqlmock, role string, timeoutAt int) {
	assetScope := "TRUE"
	userScope := "TRUE"
	groupScope := "TRUE"
	if role == "employee" {
		assetScope = "a.assigned_to = $2::uuid"
		userScope = "u.id = $2::uuid"
		groupScope = userScope
	} else if !isAdminRole(role) {
		assetScope = `(a.entity_id = $1::uuid OR EXISTS (
			SELECT 1 FROM user_entity_access uea
			WHERE uea.user_id = $2::uuid AND uea.entity_id = a.entity_id
		))`
		userScope = `(u.entity_id = $1::uuid OR EXISTS (
			SELECT 1 FROM user_entity_access uea
			WHERE uea.user_id = $2::uuid AND uea.entity_id = u.entity_id
		))`
		groupScope = `(g.entity_id = $1::uuid OR EXISTS (
			SELECT 1 FROM user_entity_access uea
			WHERE uea.user_id = $2::uuid AND uea.entity_id = g.entity_id
		))`
	}
	join := regexp.QuoteMeta("LEFT JOIN assets a ON a.assigned_to = u.id AND a.is_compute = TRUE AND " + assetScope)
	queries := []struct {
		pattern string
		rows    *sqlmock.Rows
	}{
		{`(?s)SELECT u\.id::text, u\.full_name.*` + join + `.*` + regexp.QuoteMeta("u.is_active = TRUE AND "+userScope),
			sqlmock.NewRows([]string{"id", "full_name", "email", "emp_id", "dept_id", "department", "location_id", "location", "asset_count", "new_count", "ungrouped_count", "flagged_count", "status", "primary_asset_id", "assets"}).
				AddRow("u", "User", "user@example.test", "EMP", "d", "Department", "l", "Branch", 4, 0, 0, 0, "online", "a", []byte(fmt.Sprintf(`[{"id":"a","saltMinionId":"alpha","lastHeartbeatAt":%q},{"id":"b","saltMinionId":"beta","lastHeartbeatAt":%q},{"id":"c","saltMinionId":"alpha","lastHeartbeatAt":%q},{"id":"d","hostname":"not-a-managed-id","status":"online"}]`, time.Now().UTC().Format(time.RFC3339Nano), time.Now().Add(-5*time.Minute).UTC().Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano))))},
		{`(?s)SELECT g\.id::text, g\.name, COUNT\(a\.id\)::int.*` + join + `.*` + regexp.QuoteMeta("AND "+groupScope), sqlmock.NewRows([]string{"id", "name", "device_count"})},
		{`(?s)SELECT g\.id::text, g\.full_name, COUNT\(a\.id\)::int.*` + join + `.*` + regexp.QuoteMeta("AND "+groupScope), sqlmock.NewRows([]string{"id", "name", "device_count"})},
		{`(?s)SELECT COUNT\(\*\)::int,.*` + regexp.QuoteMeta("a.is_compute = TRUE AND "+assetScope), sqlmock.NewRows([]string{"all", "new", "ungrouped", "flagged"}).AddRow(4, 0, 0, 0)},
	}
	for i, query := range queries {
		expect := mock.ExpectQuery(query.pattern).WithArgs("e", "u")
		if timeoutAt == i+1 {
			expect.WillDelayFor(time.Second).WillReturnRows(query.rows)
			return
		}
		expect.WillReturnRows(query.rows).RowsWillBeClosed()
	}
}

func TestDeviceDirectoryConnectivityBatchScopeAndCapabilities(t *testing.T) {
	for _, role := range []string{"super_admin", "admin", "it_team", "employee", "auditor"} {
		t.Run(role, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			var requests atomic.Int32
			salt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if err := mock.ExpectationsWereMet(); err != nil {
					t.Errorf("database rows must be read and closed before Salt: %v", err)
				}
				var payload struct {
					Targets []string `json:"tgt"`
					Type    string   `json:"expr_form"`
				}
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || !reflect.DeepEqual(payload.Targets, []string{"alpha", "beta"}) || payload.Type != "list" {
					t.Errorf("unexpected batch: %+v, %v", payload, err)
				}
				_, _ = w.Write([]byte(`{"return":[{"alpha":true}]}`))
			}))
			defer salt.Close()
			server.salt = saltstack.NewClient(salt.URL, "test-token", "", "", "", "glob")
			c, recorder := newTestContext(http.MethodGet, "/api/devices/directory", newTestClaims(role, "u", "e"))
			expectDirectoryConnectivityQueries(mock, role, 0)
			server.listDeviceDirectory(c)
			assertRouteResult(t, mock, recorder, 200, "directory batch")
			var body struct {
				Users        []deviceDirectoryUser `json:"users"`
				Capabilities map[string]bool       `json:"capabilities"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if requests.Load() != 0 || recorder.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("heartbeat status must be uncached and independent of Salt")
			}
			if body.Capabilities["addDevice"] != (role == "admin" || isAdminRole(role)) || body.Capabilities["installAgent"] != (role == "it_team" || isAdminRole(role)) {
				t.Fatalf("unexpected capabilities: %v", body.Capabilities)
			}
			if allowed, present := body.Capabilities["manageStock"]; !present || allowed != (role == "it_team" || isAdminRole(role)) {
				t.Fatalf("stock capability must match inventory write routes: %v", body.Capabilities)
			}
			user := body.Users[0]
			if user.Status != "online" || user.ConnectivitySource != "agent_heartbeat" || user.ConnectivityCheckedAt == nil {
				t.Fatalf("unexpected user connectivity: %+v", user)
			}
			for index, status := range []string{"online", "offline", "online", "unknown"} {
				asset := user.Assets[index]
				if asset.Status != status || asset.SaltMinionID != "" {
					t.Fatalf("unexpected asset state: %+v", asset)
				}
			}
		})
	}
}

func TestDeviceDirectoryAllQueriesHonorRequestDeadline(t *testing.T) {
	for timeoutAt := 1; timeoutAt <= 4; timeoutAt++ {
		server, mock, cleanup := newTestServer(t)
		c, recorder := newTestContext(http.MethodGet, "/", newTestClaims("admin", "u", "e"))
		// Allow the preceding scoped scans/regex matching to finish under -race;
		// the selected query still delays for a full second and must be cancelled.
		ctx, cancel := context.WithTimeout(c.Request.Context(), 200*time.Millisecond)
		c.Request = c.Request.WithContext(ctx)
		expectDirectoryConnectivityQueries(mock, "admin", timeoutAt)
		start := time.Now()
		server.listDeviceDirectory(c)
		cancel()
		assertRouteResult(t, mock, recorder, 500, "bounded directory query")
		cleanup()
		if time.Since(start) > 750*time.Millisecond {
			t.Fatalf("query %d ignored request deadline", timeoutAt)
		}
	}
}

func TestDeviceDirectoryUnknownAggregation(t *testing.T) {
	now := time.Now()
	stale := now.Add(-5 * time.Minute)
	for _, lastContact := range []*time.Time{nil, &stale} {
		users := []deviceDirectoryUser{
			{Assets: []deviceDirectoryAsset{{LastHeartbeatAt: lastContact, Status: "online"}}},
			{Assets: []deviceDirectoryAsset{{LastHeartbeatAt: lastContact}, {Status: "online"}}},
			{Assets: []deviceDirectoryAsset{{}, {LastHeartbeatAt: lastContact}}},
			{},
		}
		applyDeviceDirectoryConnectivity(users, now)
		want := "unknown"
		if lastContact != nil {
			want = "offline"
		}
		if users[0].Status != want || users[0].ConnectivitySource != "agent_heartbeat" || users[1].Status != "unknown" || users[2].Status != "unknown" || users[3].Status != "unassigned" {
			t.Fatalf("unexpected heartbeat aggregation: %+v", users)
		}
	}
}
