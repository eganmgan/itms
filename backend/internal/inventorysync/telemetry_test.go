package inventorysync

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestTelemetryJSONAndRetention(t *testing.T) {
	for _, tc := range []struct {
		name, payload    string
		replace, updates bool
	}{
		{"legacy omitted", `{}`, false, false},
		{"legacy empty", `{"installed_software":[],"compute_details":{"pending_updates":0}}`, false, false},
		{"legacy nonempty", `{"installed_software":[{"name":"app"}]}`, false, false},
		{"failed", `{"installed_software":[],"collection_status":{"software":{"status":"failed"},"updates":{"status":"failed"}},"compute_details":{"pending_updates":null,"pending_update_details":[]}}`, false, false},
		{"partial", `{"installed_software":[{"name":"app"}],"collection_status":{"software":{"status":"partial"}}}`, false, false},
		{"success empty", `{"installed_software":[],"collection_status":{"software":{"status":"success"},"updates":{"status":"success"}},"compute_details":{"pending_updates":0,"pending_update_details":[]}}`, true, true},
		{"success but omitted", `{"collection_status":{"software":{"status":"success"},"updates":{"status":"success"}}}`, false, false},
		{"inconsistent zero", `{"collection_status":{"updates":{"status":"success"}},"compute_details":{"pending_updates":0,"pending_update_details":["pkg"]}}`, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var asset sourceAsset
			if err := json.Unmarshal([]byte(tc.payload), &asset); err != nil {
				t.Fatal(err)
			}
			if softwareSnapshotReplaceable(asset) != tc.replace || updateSnapshotSuccessful(asset) != tc.updates {
				t.Fatalf("incorrect retention: %+v", asset)
			}
		})
	}
}

func testTelemetryAsset(count int) sourceAsset {
	pending := []string{}
	if count > 0 {
		pending = []string{"package 2.0"}
	}
	return sourceAsset{AssetTag: "TEST", EntityID: "entity", IsCompute: true,
		CollectionStatus:  map[string]SectionStatus{"software": {Status: "success"}, "updates": {Status: "success"}},
		InstalledSoftware: []softwareRecord{}, ComputeDetails: &computeDetails{PendingUpdates: &count, PendingUpdateDetails: pending}}
}

func TestTelemetryReconciliationAlertsAndHistory(t *testing.T) {
	for _, state := range []string{"pending", "clean", "reboot", "failed", "partial", "legacy", "heartbeat"} {
		t.Run(state, func(t *testing.T) {
			asset := testTelemetryAsset(1)
			switch state {
			case "clean":
				asset = testTelemetryAsset(0)
			case "reboot":
				asset = testTelemetryAsset(0)
				reboot := true
				asset.ComputeDetails.RebootRequired = &reboot
			case "failed", "partial":
				asset.CollectionStatus["updates"] = SectionStatus{Status: state}
			case "legacy":
				asset.CollectionStatus = nil
			}
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			mock.ExpectBegin()
			query := mock.ExpectQuery("SELECT fingerprint FROM asset_inventory_telemetry").WithArgs("asset")
			if state == "heartbeat" {
				query.WillReturnRows(sqlmock.NewRows([]string{"fingerprint"}).AddRow(telemetryFingerprint(asset)))
			} else {
				query.WillReturnError(sql.ErrNoRows)
			}
			var expectedCount any = 1
			var expectedReboot any
			expectedDetails := `["package 2.0"]`
			switch state {
			case "clean", "reboot":
				expectedCount, expectedDetails = 0, `[]`
				if state == "reboot" {
					expectedReboot = true
				}
			case "failed", "legacy":
				expectedCount, expectedDetails = nil, `[]`
			case "partial":
				expectedCount = nil
			}
			mock.ExpectExec("INSERT INTO asset_inventory_telemetry").
				WithArgs("asset", sqlmock.AnyArg(), expectedCount, expectedDetails, expectedReboot, sqlmock.AnyArg()).
				WillReturnResult(sqlmock.NewResult(0, 1))
			if state != "heartbeat" {
				mock.ExpectExec("INSERT INTO asset_history").WillReturnResult(sqlmock.NewResult(0, 1))
			}
			if state == "pending" || state == "heartbeat" || state == "reboot" {
				mock.ExpectExec("(?s)INSERT INTO asset_alerts.*ON CONFLICT.*is_resolved = FALSE.*DO UPDATE SET detail").WithArgs("asset", sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
			} else if state == "clean" {
				mock.ExpectExec("(?s)UPDATE asset_alerts SET is_resolved = TRUE.*source = 'patch_inventory' AND is_resolved = FALSE").WithArgs("asset").WillReturnResult(sqlmock.NewResult(0, 1))
			}
			mock.ExpectCommit()
			tx, _ := db.Begin()
			if err := (&Service{db: db}).reconcileTelemetry(context.Background(), tx, "asset", asset); err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestTelemetryFingerprintIgnoresPollingAndOrder(t *testing.T) {
	asset := testTelemetryAsset(1)
	asset.InstalledSoftware = []softwareRecord{{Name: "b", Version: "1"}, {Name: "a", Version: "1"}}
	before := telemetryFingerprint(asset)
	asset.ComputeDetails.LastSeen = "later"
	asset.CollectionStatus["updates"] = SectionStatus{Status: "success", ScannedAt: "later"}
	asset.InstalledSoftware[0], asset.InstalledSoftware[1] = asset.InstalledSoftware[1], asset.InstalledSoftware[0]
	if telemetryFingerprint(asset) != before {
		t.Fatal("heartbeat or order recorded history")
	}
	asset.InstalledSoftware[0].Version = "2"
	if telemetryFingerprint(asset) == before {
		t.Fatal("software change missed")
	}
	before = telemetryFingerprint(asset)
	asset.ComputeDetails.RAM = "32 GB"
	if telemetryFingerprint(asset) == before {
		t.Fatal("hardware change missed")
	}
}

func TestTelemetrySyncSuccessfulEmptyDeletesButFailurePreserves(t *testing.T) {
	for _, status := range []string{"success", "failed", "uncollected", "partial"} {
		t.Run(status, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			asset := testTelemetryAsset(0)
			asset.CollectionStatus["software"] = SectionStatus{Status: status}
			asset.CollectionStatus["updates"] = SectionStatus{Status: status}
			mock.ExpectBegin()
			mock.ExpectQuery("(?s)SELECT id::text FROM assets").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("asset"))
			mock.ExpectQuery("UPDATE assets SET").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("asset"))
			mock.ExpectExec("INSERT INTO asset_compute_details").WillReturnResult(sqlmock.NewResult(0, 1))
			if status == "success" {
				mock.ExpectExec("DELETE FROM asset_software_inventory").WillReturnResult(sqlmock.NewResult(0, 1))
			}
			mock.ExpectQuery("SELECT fingerprint FROM asset_inventory_telemetry").WillReturnError(sql.ErrNoRows)
			mock.ExpectExec("INSERT INTO asset_inventory_telemetry").WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectExec("INSERT INTO asset_history").WillReturnResult(sqlmock.NewResult(0, 1))
			if status == "success" {
				mock.ExpectExec("UPDATE asset_alerts SET is_resolved = TRUE").WillReturnResult(sqlmock.NewResult(0, 0))
			}
			mock.ExpectCommit()
			count, err := (&Service{db: db}).syncAssets(context.Background(), []sourceAsset{asset})
			if err != nil || count != 1 {
				t.Fatalf("sync = %d, %v", count, err)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestTelemetryUpdateSQLPreservesUnknownAndClearsSuccess(t *testing.T) {
	matcher := sqlmock.QueryMatcherFunc(func(_, query string) error {
		if !strings.Contains(query, "WHEN $17::integer IS NULL THEN asset_compute_details.pending_update_details_json") || !strings.Contains(query, "pending_updates = COALESCE($17, asset_compute_details.pending_updates)") {
			t.Error("unknown scan can overwrite data")
		}
		return nil
	})
	db, mock, _ := sqlmock.New(sqlmock.QueryMatcherOption(matcher))
	defer db.Close()
	mock.ExpectBegin()
	mock.ExpectExec("upsert").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectRollback()
	tx, _ := db.Begin()
	if err := (&Service{}).upsertComputeDetails(context.Background(), tx, "asset", testTelemetryAsset(0).ComputeDetails); err != nil {
		t.Fatal(err)
	}
	_ = tx.Rollback()
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
