package api

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"

	"itms/backend/internal/integrations/saltstack"
)

type detailQueryFixture struct {
	query   string
	columns []string
	values  []driver.Value
}

func deviceDetailFixtures(entity, owner, cost string, lastSeen any) []detailQueryFixture {
	return []detailQueryFixture{
		{`FROM assets WHERE id = \$1::uuid`, []string{
			"id", "asset_tag", "name", "hostname", "category", "is_compute", "serial_number", "manufacturer", "model", "entity_id",
			"assigned_to", "dept_id", "location_id", "purchase_date", "cost", "warranty_until", "maintenance_until", "status", "condition", "glpi_id", "salt_minion_id", "wazuh_agent_id", "notes",
		}, []driver.Value{"asset-1", "AST-001", "Laptop", "host-1", "laptop", true, "SN-1", "Maker", "Model", entity, owner, "dept-1", "branch-1", "2024-02-29", cost, "2026-01-01", "2027-02-28", "in_use", "good", 0, "minion-1", "agent-1", "Manual note"}},
		{`FROM asset_compute_details WHERE asset_id`, []string{
			"processor", "ram", "storage", "gpu", "display", "bios_version", "mac_address", "os_name", "os_version", "kernel", "architecture", "os_build", "last_boot", "last_seen", "pending_updates", "anydesk_id", "rustdesk_id", "disk_layout", "volumes_json", "logged_in_users_json", "pending_update_details_json",
		}, []driver.Value{"CPU", "0", "0", "GPU", "Display", "01.02", "MAC", "Ubuntu", "24.04.0", "6.8.0-001", "x86_64", "00042", nil, lastSeen, 0, "123", "456", "Layout", []byte(`[]`), []byte(`[]`), []byte(`[]`)}},
		{`FROM asset_network_snapshots WHERE asset_id`, []string{"wired_ip", "wireless_ip", "netbird_ip", "dns", "gateway", "interface_stats"}, []driver.Value{"", "", "", "", "", []byte(`{}`)}},
		{`FROM asset_software_inventory WHERE asset_id`, []string{"id", "name", "version", "install_date", "source"}, []driver.Value{"app-1", "salt-minion", "0", "2024-02-29", "inventory"}},
		{`(?s)SELECT COALESCE\(u.full_name.*COALESCE\(a.warranty_duration_months::text, ''\).*LEFT JOIN departments d ON d.id = a.dept_id.*LEFT JOIN departments charge_group ON charge_group.id = a.group_in_charge_id.*WHERE a.id = \$1::uuid`, []string{
			"full_name", "email", "emp_id", "department", "branch", "technician", "supplier", "warranty_start_date", "warranty_duration_months", "update_sources", "technician_id", "technician_email", "technician_emp_id", "group_id", "group_name", "supplier_id", "manually_managed",
		}, []driver.Value{"Ava Example", "ava@example.test", "EMP-1", "Finance", "HQ", "Tech Example", "Supplier", "2026-01-01", "0", "Manual entry", "tech-1", "tech@example.test", "TECH-1", "group-1", "IT Support", "supplier-1", true}},
		{`FROM asset_alerts`, []string{"id", "source", "severity", "title", "detail", "is_resolved", "resolved_at", "mttr_seconds", "created_at"}, nil},
		{`FROM asset_inventory_telemetry WHERE asset_id`, []string{"sections", "pending_updates", "pending_update_details", "reboot_required"}, nil},
	}
}

func (fixture detailQueryFixture) rows() *sqlmock.Rows {
	rows := sqlmock.NewRows(fixture.columns)
	if fixture.values != nil {
		rows.AddRow(fixture.values...)
	}
	return rows
}

func expectDeviceDetailQuery(mock sqlmock.Sqlmock, fixture detailQueryFixture) *sqlmock.ExpectedQuery {
	return mock.ExpectQuery(fixture.query).WithArgs("asset-1")
}

func TestDeviceCompatInventoryContractNeverCallsSalt(t *testing.T) {
	for i, tc := range []struct {
		cost string
		seen any
	}{
		{"0", time.Now().UTC()},
		{"0.00", time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)},
		{"1234567890.12", nil},
	} {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			var calls atomic.Int32
			salt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				http.Error(w, "unavailable", http.StatusServiceUnavailable)
			}))
			defer salt.Close()
			server.salt = saltstack.NewClient(salt.URL, "test-token", "", "", "", "glob")
			c, recorder := newTestContext(http.MethodGet, "/api/devices/asset-1", newTestClaims("admin", "user-1", "entity-1"))
			c.Params = gin.Params{{Key: "id", Value: "asset-1"}}
			for _, fixture := range deviceDetailFixtures("entity-1", "user-1", tc.cost, tc.seen) {
				expectDeviceDetailQuery(mock, fixture).WillReturnRows(fixture.rows()).RowsWillBeClosed()
			}
			server.getDeviceCompat(c)
			assertRouteResult(t, mock, recorder, http.StatusOK, "inventory detail")
			if calls.Load() != 0 || recorder.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("Salt calls=%d headers=%v", calls.Load(), recorder.Header())
			}
			var body map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			for key, want := range map[string]any{
				"id": "asset-1", "assetId": "AST-001", "assetTag": "AST-001", "name": "Laptop", "hostname": "host-1",
				"entityId": "entity-1", "deptId": "dept-1", "locationId": "branch-1", "assignedUserId": "user-1",
				"technicianInChargeId": "tech-1", "groupInChargeId": "group-1", "supplierId": "supplier-1", "manuallyManaged": true,
				"cost": tc.cost, "purchaseDate": "2024-02-29", "warrantyStartDate": "2026-01-01", "warrantyDurationMonths": "0", "warrantyExpiresAt": "2026-01-01",
				"manufacturer": "Maker", "model": "Model", "serialNumber": "SN-1", "deviceType": "laptop", "status": "in_use", "updateSources": "Manual entry",
				"osName": "Ubuntu", "osVersion": "24.04.0", "osBuild": "00042", "kernelVersion": "6.8.0-001", "biosVersion": "01.02", "architecture": "x86_64", "memory": "0", "storage": "0",
				"notes": "Manual note", "condition": "good", "maintenanceUntil": "2027-02-28", "saltMinionId": "minion-1", "salt_minion_id": "minion-1",
				"connected": nil, "connectivityCheckedAt": nil,
			} {
				if got, exists := body[key]; !exists || got != want {
					t.Errorf("%s=%v (present=%v), want %v", key, got, exists, want)
				}
			}
			for key, want := range map[string]string{"department": "Finance", "groupInCharge": "IT Support", "branch": "HQ", "supplier": "Supplier"} {
				if got := body[key].(map[string]any)["name"]; got != want {
					t.Errorf("%s.name=%v, want %s", key, got, want)
				}
			}
			for key, want := range map[string]string{"user": "Ava Example", "technicianInCharge": "Tech Example"} {
				person := body[key].(map[string]any)
				if person["fullName"] != want || person["name"] != nil || person["email"] == nil || person["employeeCode"] == nil {
					t.Errorf("incorrect person contract %s=%v", key, person)
				}
			}
			app := body["installedApps"].([]any)[0].(map[string]any)
			if app["version"] != "0" || app["installDate"] != "2024-02-29" {
				t.Errorf("application values lost: %v", app)
			}
			saltStatus := body["toolStatus"].(map[string]any)["salt"].(map[string]any)
			if connected, exists := saltStatus["connected"]; !exists || connected != nil {
				t.Errorf("inventory inferred connectivity: %v", saltStatus)
			}
			if tc.seen == nil && body["lastSeenAt"] != nil {
				t.Errorf("missing lastSeenAt fabricated: %v", body["lastSeenAt"])
			}
		})
	}
}

func TestDeviceCompatAuthorization(t *testing.T) {
	for i, tc := range []struct {
		role, entity, owner string
		delegated           bool
		status              int
	}{
		{"admin", "entity-1", "", false, 200},
		{"admin", "entity-2", "", true, 200},
		{"admin", "entity-2", "", false, 200},
		{"super_admin", "entity-2", "", false, 200},
		{"it_team", "entity-1", "", false, 200},
		{"it_team", "entity-2", "", true, 200},
		{"it_team", "entity-2", "", false, 403},
		{"auditor", "entity-1", "", false, 200},
		{"auditor", "entity-2", "", true, 200},
		{"auditor", "entity-2", "", false, 403},
		{"employee", "entity-2", "user-1", false, 200},
		{"employee", "entity-1", "other-user", false, 403},
		{"employee", "entity-1", "", false, 403},
		{"Admin", "entity-1", "", false, 403},
		{"administrator", "entity-1", "", false, 403},
	} {
		t.Run(fmt.Sprintf("%d_%s", i, tc.role), func(t *testing.T) {
			mock, recorder, router, request, cleanup := newRoleRouteRequest(t, tc.role, "user-1", "entity-1", http.MethodGet, "/api/devices/asset-1", "")
			defer cleanup()
			request.RemoteAddr = fmt.Sprintf("192.0.2.%d:4321", i+100)
			fixtures := deviceDetailFixtures(tc.entity, tc.owner, "0.00", nil)
			if tc.role != "Admin" && tc.role != "administrator" {
				expectDeviceDetailQuery(mock, fixtures[0]).WillReturnRows(fixtures[0].rows())
				if !isAdminRole(tc.role) && tc.role != "employee" && tc.entity != "entity-1" {
					expectEntityAccessCheck(mock, "user-1", tc.entity, tc.delegated)
				}
				if tc.status == 200 {
					for _, fixture := range fixtures[1:] {
						expectDeviceDetailQuery(mock, fixture).WillReturnRows(fixture.rows())
					}
				}
			}
			router.ServeHTTP(recorder, request)
			assertRouteResult(t, mock, recorder, tc.status, "device scope")
		})
	}
}

func TestDeviceCompatQueryFailuresAndDeadlines(t *testing.T) {
	// Exercise every DB stage, including delegated authorization. No subsequent
	// expectations are registered: partial/fabricated success must never follow.
	fixtures := deviceDetailFixtures("entity-2", "user-1", "0", nil)
	fixtures = append(fixtures[:1], append([]detailQueryFixture{{
		query:   regexp.QuoteMeta(`SELECT EXISTS(SELECT 1 FROM user_entity_access WHERE user_id = $1::uuid AND entity_id = $2::uuid)`),
		columns: []string{"exists"}, values: []driver.Value{true},
	}}, fixtures[1:]...)...)
	for _, mode := range []string{"sql-error", "deadline", "scan-error", "row-error"} {
		for stage := range fixtures {
			t.Run(fmt.Sprintf("%s/%d", mode, stage), func(t *testing.T) {
				server, mock, cleanup := newTestServer(t)
				defer cleanup()
				c, recorder := newTestContext(http.MethodGet, "/", newTestClaims("it_team", "user-1", "entity-1"))
				c.Params = gin.Params{{Key: "id", Value: "asset-1"}}
				if mode == "deadline" {
					ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Millisecond)
					defer cancel()
					c.Request = c.Request.WithContext(ctx)
				}
				for i, fixture := range fixtures[:stage+1] {
					query := mock.ExpectQuery(fixture.query)
					if i == 1 {
						query.WithArgs("user-1", "entity-2")
					} else {
						query.WithArgs("asset-1")
					}
					if i != stage {
						query.WillReturnRows(fixture.rows())
						continue
					}
					switch mode {
					case "sql-error":
						query.WillReturnError(errors.New("database failure"))
					case "deadline":
						query.WillDelayFor(time.Second).WillReturnRows(fixture.rows())
					case "scan-error":
						query.WillReturnRows(sqlmock.NewRows([]string{"wrong_columns"}).AddRow("not a boolean"))
					case "row-error":
						query.WillReturnRows(sqlmock.NewRows([]string{"broken"}).AddRow("broken").RowError(0, errors.New("iteration failed")))
					}
				}
				start := time.Now()
				server.getDeviceCompat(c)
				want := http.StatusInternalServerError
				if mode == "deadline" {
					want = http.StatusGatewayTimeout
					if elapsed := time.Since(start); elapsed >= 750*time.Millisecond {
						t.Errorf("request deadline ignored: %s", elapsed)
					}
				}
				assertRouteResult(t, mock, recorder, want, "query failure")
			})
		}
	}
}

func TestDeviceCompatDefaultDeadline(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	c, recorder := newTestContext(http.MethodGet, "/", newTestClaims("admin", "user-1", "entity-1"))
	c.Params = gin.Params{{Key: "id", Value: "asset-1"}}
	fixtures := deviceDetailFixtures("entity-1", "", "0", nil)
	// Spend part of the budget on the first query. The second must use the
	// original deadline, not a fresh eight-second timeout.
	expectDeviceDetailQuery(mock, fixtures[0]).WillDelayFor(2 * time.Second).WillReturnRows(fixtures[0].rows())
	expectDeviceDetailQuery(mock, fixtures[1]).WillDelayFor(deviceQueryTimeout).WillReturnRows(fixtures[1].rows())
	start := time.Now()
	server.getDeviceCompat(c)
	assertRouteResult(t, mock, recorder, http.StatusGatewayTimeout, "default deadline")
	if elapsed := time.Since(start); elapsed < deviceQueryTimeout || elapsed >= deviceQueryTimeout+time.Second {
		t.Fatalf("default deadline elapsed=%s, want %s", elapsed, deviceQueryTimeout)
	}
}

func TestDeviceCompatCanceledRequest(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	c, recorder := newTestContext(http.MethodGet, "/", newTestClaims("admin", "user-1", "entity-1"))
	c.Params = gin.Params{{Key: "id", Value: "asset-1"}}
	ctx, cancel := context.WithCancel(c.Request.Context())
	cancel()
	c.Request = c.Request.WithContext(ctx)
	server.getDeviceCompat(c)
	assertRouteResult(t, mock, recorder, http.StatusRequestTimeout, "canceled request performs no SQL")
}

func TestDeviceCompatMissingRecords(t *testing.T) {
	for _, missing := range []int{0, 1, 2, 4} {
		t.Run(fmt.Sprint(missing), func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			c, recorder := newTestContext(http.MethodGet, "/", newTestClaims("admin", "user-1", "entity-1"))
			c.Params = gin.Params{{Key: "id", Value: "asset-1"}}
			for i, fixture := range deviceDetailFixtures("entity-1", "", "0", nil) {
				query := expectDeviceDetailQuery(mock, fixture)
				if i == missing {
					query.WillReturnError(sql.ErrNoRows)
					if missing == 0 || missing == 4 {
						break
					}
				} else {
					query.WillReturnRows(fixture.rows())
				}
			}
			server.getDeviceCompat(c)
			want := http.StatusOK
			if missing == 0 {
				want = http.StatusNotFound
			} else if missing == 4 {
				want = http.StatusInternalServerError
			}
			assertRouteResult(t, mock, recorder, want, "missing inventory record")
		})
	}
}

func TestDeviceCompatMissingManagementDoesNotInventGroupOrZero(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	c, recorder := newTestContext(http.MethodGet, "/", newTestClaims("admin", "user-1", "entity-1"))
	c.Params = gin.Params{{Key: "id", Value: "asset-1"}}
	fixtures := deviceDetailFixtures("entity-1", "", "", nil)
	for i := range fixtures[4].values {
		if i != 3 && i != 4 && i != 16 { // Keep recorded department/location, but no group.
			fixtures[4].values[i] = ""
		}
	}
	fixtures[4].values[16] = false
	fixtures[3].values = nil
	for _, fixture := range fixtures {
		expectDeviceDetailQuery(mock, fixture).WillReturnRows(fixture.rows())
	}
	server.getDeviceCompat(c)
	assertRouteResult(t, mock, recorder, http.StatusOK, "missing optional management")
	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"cost", "user", "technicianInCharge", "groupInCharge", "groupInChargeId", "supplier", "warrantyStartDate", "warrantyDurationMonths", "updateSources"} {
		if value, exists := body[key]; !exists || value != nil {
			t.Errorf("%s=%v (present=%v), want explicit null", key, value, exists)
		}
	}
	if body["department"].(map[string]any)["name"] != "Finance" || len(body["installedApps"].([]any)) != 0 {
		t.Fatalf("optional absence damaged recorded data: %v", body)
	}
}

func TestDeviceCompatRejectsAnonymousAndNonCompute(t *testing.T) {
	t.Run("anonymous", func(t *testing.T) {
		mock, recorder, router, request, cleanup := newAnonymousRouteRequest(t, http.MethodGet, "/api/devices/asset-1")
		defer cleanup()
		request.RemoteAddr = "192.0.2.200:4321"
		router.ServeHTTP(recorder, request)
		assertRouteResult(t, mock, recorder, http.StatusUnauthorized, "anonymous detail")
	})
	t.Run("non-compute", func(t *testing.T) {
		server, mock, cleanup := newTestServer(t)
		defer cleanup()
		c, recorder := newTestContext(http.MethodGet, "/", newTestClaims("admin", "user-1", "entity-1"))
		c.Params = gin.Params{{Key: "id", Value: "asset-1"}}
		fixture := deviceDetailFixtures("entity-1", "", "0", nil)[0]
		fixture.values[5] = false
		expectDeviceDetailQuery(mock, fixture).WillReturnRows(fixture.rows())
		server.getDeviceCompat(c)
		assertRouteResult(t, mock, recorder, http.StatusBadRequest, "non-compute detail")
	})
}
