package api

import (
	"encoding/json"
	"net/http"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
)

func TestRouterGetDeviceCompatIncludesSaltMinionIDAlias(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "super_admin", "user-1", "entity-1", http.MethodGet, "/api/devices/asset-1", "")
	defer cleanup()

	expectAssetLookup(mock, "asset-1", "AST-001", "Spare Laptop", "spare-ho", "laptop", true, "entity-1", "spare.ho-003", "wazuh-1", "in_use", "good")
	mock.ExpectQuery(regexp.QuoteMeta(`
		SELECT COALESCE(processor, ''), COALESCE(ram, ''), COALESCE(storage, ''), COALESCE(gpu, ''), COALESCE(display, ''), COALESCE(bios_version, ''), COALESCE(mac_address, ''),
			COALESCE(os_name, ''), COALESCE(os_version, ''), COALESCE(kernel, ''), COALESCE(architecture, ''), COALESCE(os_build, ''), last_boot, last_seen, pending_updates,
			COALESCE(anydesk_id, ''), COALESCE(rustdesk_id, ''), COALESCE(disk_layout, ''), volumes_json, logged_in_users_json, pending_update_details_json
		FROM asset_compute_details WHERE asset_id = $1::uuid
	`)).WithArgs("asset-1").WillReturnRows(sqlmock.NewRows([]string{
		"processor", "ram", "storage", "gpu", "display", "bios_version", "mac_address",
		"os_name", "os_version", "kernel", "architecture", "os_build", "last_boot", "last_seen", "pending_updates",
		"anydesk_id", "rustdesk_id", "disk_layout", "volumes_json", "logged_in_users_json", "pending_update_details_json",
	}).AddRow("", "", "", "", "", "", "", "Ubuntu 24.04", "24.04", "", "x86_64", "", nil, nil, 0, "", "", "", []byte(`[]`), []byte(`[]`), []byte(`["openssl"]`)))
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT COALESCE(wired_ip::text, ''), COALESCE(wireless_ip::text, ''), COALESCE(netbird_ip::text, ''), COALESCE(dns, ''), COALESCE(gateway::text, ''), interface_stats FROM asset_network_snapshots WHERE asset_id = $1::uuid`)).
		WithArgs("asset-1").
		WillReturnRows(sqlmock.NewRows([]string{"wired_ip", "wireless_ip", "netbird_ip", "dns", "gateway", "interface_stats"}).AddRow("", "", "", "", "", []byte(`{}`)))
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT id, name, COALESCE(version, ''), COALESCE(install_date::text, ''), COALESCE(source, '') FROM asset_software_inventory WHERE asset_id = $1::uuid ORDER BY name`)).
		WithArgs("asset-1").
		WillReturnRows(sqlmock.NewRows([]string{"id", "name", "version", "install_date", "source"}))
	mock.ExpectQuery(regexp.QuoteMeta(`
		SELECT COALESCE(u.full_name, ''), COALESCE(u.email, ''), COALESCE(u.emp_id, ''), COALESCE(d.name, ''), COALESCE(l.full_name, ''),
		       COALESCE(technician.full_name, ''), COALESCE(supplier.name, ''), COALESCE(a.warranty_start_date::text, ''),
		       COALESCE(a.warranty_duration_months::text, ''), COALESCE(a.update_sources, ''),
		       COALESCE(a.technician_in_charge_id::text, ''), COALESCE(technician.email, ''), COALESCE(technician.emp_id, ''),
		       COALESCE(a.group_in_charge_id::text, ''), COALESCE(charge_group.name, ''), COALESCE(a.supplier_id::text, ''), a.manually_managed
		FROM assets a
		LEFT JOIN users u ON u.id = a.assigned_to
		LEFT JOIN departments d ON d.id = a.dept_id
		LEFT JOIN locations l ON l.id = a.location_id
		LEFT JOIN users technician ON technician.id = a.technician_in_charge_id
		LEFT JOIN departments charge_group ON charge_group.id = a.group_in_charge_id
		LEFT JOIN suppliers supplier ON supplier.id = a.supplier_id
		WHERE a.id = $1::uuid
	`)).WithArgs("asset-1").WillReturnRows(sqlmock.NewRows([]string{
		"full_name", "email", "emp_id", "name", "location", "technician", "supplier", "warranty_start_date",
		"warranty_duration_months", "update_sources", "technician_id", "technician_email", "technician_emp_id",
		"group_id", "group_name", "supplier_id", "manually_managed",
	}).AddRow("", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", false))
	mock.ExpectQuery(regexp.QuoteMeta(`
		SELECT id, source, severity, title, COALESCE(detail, ''), is_resolved, COALESCE(resolved_at::text, ''), COALESCE(mttr_seconds, 0), created_at
		FROM asset_alerts
		WHERE asset_id = $1::uuid AND (is_resolved = FALSE OR created_at >= NOW() - INTERVAL '7 days')
		ORDER BY created_at DESC
	`)).WithArgs("asset-1").WillReturnRows(sqlmock.NewRows([]string{"id", "source", "severity", "title", "detail", "is_resolved", "resolved_at", "mttr_seconds", "created_at"}))
	mock.ExpectQuery(regexp.QuoteMeta(`
		SELECT COALESCE(t.sections, '{}'::jsonb), t.pending_updates,
		COALESCE(t.pending_update_details, '[]'::jsonb), t.reboot_required,
		COALESCE(s.services, '[]'::jsonb), s.section, s.last_success_at, s.updated_at
		FROM (SELECT * FROM asset_inventory_telemetry WHERE asset_id = $1::uuid) t
		FULL JOIN (SELECT * FROM asset_service_inventory WHERE asset_id = $1::uuid) s ON TRUE`)).
		WithArgs("asset-1").WillReturnRows(sqlmock.NewRows([]string{"sections", "pending_updates", "pending_update_details", "reboot_required", "services", "section", "last_success_at", "updated_at"}).
		AddRow([]byte(`{}`), nil, []byte(`[]`), nil, []byte(`[]`), nil, nil, nil))

	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusOK, "get device compat includes salt minion alias")

	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if body["saltMinionId"] != "spare.ho-003" {
		t.Fatalf("saltMinionId = %v, want spare.ho-003", body["saltMinionId"])
	}
	if body["salt_minion_id"] != "spare.ho-003" {
		t.Fatalf("salt_minion_id = %v, want spare.ho-003", body["salt_minion_id"])
	}
	if body["hostname"] != "spare-ho" {
		t.Fatalf("hostname = %v, want spare-ho", body["hostname"])
	}
}

func TestOpenSCAPComplianceScoreUsesRulePassPercentage(t *testing.T) {
	score, ok := openSCAPComplianceScore([]gin.H{{
		"source": "openscap",
		"detail": "Rules checked: 81; passed: 63; failed: 18; errors: 0; unknown: 0",
	}})
	if !ok {
		t.Fatal("expected OpenSCAP score")
	}
	if score != 78 {
		t.Fatalf("score = %d, want 78", score)
	}
}
