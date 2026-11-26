package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"

	"itms/backend/internal/app"
	"itms/backend/internal/platform/authn"
)

func TestDeviceTelemetryContract(t *testing.T) {
	for _, state := range []string{"success", "failed", "partial", "legacy"} {
		t.Run(state, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			c, recorder := newTestContext(http.MethodGet, "/api/devices/asset-1", newTestClaims("admin", "user-1", "entity-1"))
			c.Params = gin.Params{{Key: "id", Value: "asset-1"}}
			fixtures := deviceDetailFixtures("entity-1", "user-1", "", nil)
			for _, fixture := range fixtures[:len(fixtures)-1] {
				expectDeviceDetailQuery(mock, fixture).WillReturnRows(fixture.rows())
			}
			rows := sqlmock.NewRows([]string{"sections", "pending_updates", "pending_update_details", "reboot_required", "services", "section", "last_success_at", "updated_at"})
			observed := time.Date(2026, 9, 21, 10, 0, 0, 0, time.UTC)
			services := []byte(`[{"name":"ssh.service","display_name":"ssh.service","state":"active/running","start_mode":"enabled","source":"systemd"}]`)
			section := []byte(`{"status":"` + state + `","source":"systemd","scanned_at":"2026-09-21T10:00:00Z"}`)
			if state == "success" {
				rows.AddRow([]byte(`{"updates":{"status":"success","source":"apt","scanned_at":"2026-09-19T10:00:00Z"},"software":{"status":"partial","truncated":true}}`), 1, []byte(`["package 2.0"]`), true, services, section, observed, observed)
			} else if state == "failed" || state == "partial" {
				rows.AddRow([]byte(`{"updates":{"status":"failed","source":"apt","error":"timeout","scanned_at":"2026-09-19T10:00:00Z"}}`), nil, []byte(`[]`), nil, services, section, observed.Add(-6*time.Hour), observed)
			}
			mock.ExpectQuery("FROM asset_inventory_telemetry WHERE asset_id").WithArgs("asset-1").WillReturnRows(rows)
			server.getDeviceCompat(c)
			assertRouteResult(t, mock, recorder, http.StatusOK, "telemetry")
			var body map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			serviceStatus := body["collectionStatus"].(map[string]any)["services"].(map[string]any)
			if state == "legacy" {
				if len(body["services"].([]any)) != 0 || serviceStatus["status"] != "uncollected" || body["servicesLastSuccessAt"] != nil {
					t.Fatalf("legacy service coverage: %v", body)
				}
			} else if len(body["services"].([]any)) != 1 || serviceStatus["status"] != state || body["servicesLastSuccessAt"] == nil || body["servicesUpdatedAt"] == nil {
				t.Fatalf("service snapshot missing: %v", body)
			}
			if state == "success" {
				if body["pendingUpdates"] != float64(1) || body["updateScanStatus"] != "success" || body["rebootRequired"] != true || body["updateScannedAt"] != "2026-09-19T10:00:00Z" {
					t.Fatalf("telemetry missing: %v", body)
				}
				if len(body["pendingUpdateDetails"].([]any)) != 1 {
					t.Fatal("pending list missing")
				}
			} else if body["pendingUpdates"] != nil || body["patchStatus"] != "unknown" || body["complianceScore"] != nil {
				t.Fatalf("unverified scan looks clean: %v", body)
			}
		})
	}
}

func TestServiceTelemetrySnapshotWithoutGeneralTelemetry(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	observed := time.Date(2026, 9, 21, 10, 0, 0, 0, time.UTC)
	mock.ExpectQuery(`(?s)FROM \(SELECT \* FROM asset_inventory_telemetry WHERE asset_id = \$1::uuid\) t.*FULL JOIN \(SELECT \* FROM asset_service_inventory WHERE asset_id = \$1::uuid\) s`).
		WithArgs("asset").WillReturnRows(sqlmock.NewRows([]string{"sections", "pending_updates", "pending_update_details", "reboot_required", "services", "section", "last_success_at", "updated_at"}).
		AddRow([]byte(`{}`), nil, []byte(`[]`), nil, []byte(`[]`), []byte(`{"status":"success","source":"systemd","total":0,"returned":0}`), observed, observed))
	result, err := server.fetchDeviceTelemetry(context.Background(), "asset")
	if err != nil {
		t.Fatal(err)
	}
	if result.CollectionStatus["services"].Status != "success" || result.CollectionStatus["updates"].Status != "uncollected" || result.Services == nil || len(result.Services) != 0 || result.ServicesLastSuccessAt == nil {
		t.Fatalf("incorrect independent service snapshot: %+v", result)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestTelemetryScopedReadersMatchDeviceScope(t *testing.T) {
	for _, reader := range []string{"device_alerts", "asset_alerts", "history"} {
		for _, allowed := range []bool{false, true} {
			t.Run(reader+"/"+map[bool]string{true: "delegated", false: "denied"}[allowed], func(t *testing.T) {
				server, mock, cleanup := newTestServer(t)
				defer cleanup()
				c, recorder := newTestContext(http.MethodGet, "/", newTestClaims("it_team", "admin-1", "entity-1"))
				c.Params = gin.Params{{Key: "id", Value: "asset-1"}}
				expectAssetLookup(mock, "asset-1", "TAG", "Device", "host", "laptop", true, "other-entity", "", "", "in_use", "good")
				mock.ExpectQuery("SELECT EXISTS.*user_entity_access").WithArgs("admin-1", "other-entity").WillReturnRows(sqlmock.NewRows([]string{"allowed"}).AddRow(allowed))
				if allowed {
					if reader == "history" {
						mock.ExpectQuery("(?s)FROM asset_history.*LIMIT 200").WithArgs("asset-1").WillReturnRows(sqlmock.NewRows([]string{"id", "actor", "action", "detail", "created_at"}))
					} else {
						mock.ExpectQuery("(?s)FROM asset_alerts.*is_resolved = FALSE OR created_at").WithArgs("asset-1").WillReturnRows(sqlmock.NewRows([]string{"id", "source", "severity", "title", "detail", "is_resolved", "resolved_at", "mttr_seconds", "created_at"}))
					}
				}
				switch reader {
				case "device_alerts":
					server.getDeviceAlertsCompat(c)
				case "asset_alerts":
					server.getAssetAlerts(c)
				case "history":
					server.getAssetHistory(c)
				}
				status := http.StatusForbidden
				if allowed {
					status = http.StatusOK
				}
				assertRouteResult(t, mock, recorder, status, "scoped read")
			})
		}
	}
}

func TestWindowsInstallCommandUsesFileAndQuotes(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	server.config = app.Config{PublicServerURL: "https://itms.example.test/o'path", InventoryIngestToken: "never-return-this", SSHTerminalPrivateKey: mustGenerateRouterTestPrivateKey(t)}
	server.auth = authn.NewManager("test-secret-with-sufficient-length-123", 0)
	expectUserByIDLookup(mock, "target", "EMP-9", "Ava O'Neil", "ava@example.test", "entity-1", "employee", true)
	c, recorder := newTestContext(http.MethodPost, "/api/devices/install-command", newTestClaims("it_team", "operator", "entity-1"))
	c.Request.Body = io.NopCloser(strings.NewReader(`{"userId":"target","os":"windows"}`))
	c.Request.Header.Set("Content-Type", "application/json")
	server.createDeviceInstallCommand(c)
	assertRouteResult(t, mock, recorder, http.StatusOK, "Windows command")
	var body struct {
		Command string `json:"command"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for _, part := range []string{"-OutFile $p", "& $p -ServerUrl", "o''path", "Ava O''Neil", "-EnrollmentToken", "-UseDetailedHardwareInventory $true", "finally", "Remove-Item"} {
		if !strings.Contains(body.Command, part) {
			t.Errorf("command missing %q", part)
		}
	}
	if strings.Contains(body.Command, "scriptblock") || strings.Contains(body.Command, server.config.InventoryIngestToken) || recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("unsafe Windows enrollment command")
	}
}

func TestInventoryPatchAlertsUseScopedPatchReader(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	c, recorder := newTestContext(http.MethodGet, "/api/patch/alerts", newTestClaims("it_team", "operator", "entity-1"))
	mock.ExpectQuery(`(?s)FROM asset_alerts aa.*'patch_inventory'.*user_entity_access.*LIMIT 200`).
		WithArgs("it_team", "entity-1", "operator").
		WillReturnRows(sqlmock.NewRows([]string{"id", "asset", "tag", "hostname", "department", "source", "severity", "title", "detail", "resolved", "created_at"}))
	server.listPatchAlerts(c)
	assertRouteResult(t, mock, recorder, http.StatusOK, "patch telemetry alerts")
}
