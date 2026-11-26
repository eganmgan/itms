package inventorysync

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestServiceSnapshotRetention(t *testing.T) {
	old := ServiceRecord{Name: "old.service", Source: "systemd", State: "inactive/dead"}
	current := ServiceRecord{Name: "new.service", Source: "systemd", State: "active/running"}
	for _, tc := range []struct {
		name, status string
		rows         []ServiceRecord
		want         []ServiceRecord
		complete     bool
	}{
		{"success", "success", []ServiceRecord{current}, []ServiceRecord{current}, true},
		{"success empty", "success", []ServiceRecord{}, []ServiceRecord{}, true},
		{"success omitted", "success", nil, []ServiceRecord{old}, false},
		{"partial", "partial", []ServiceRecord{current}, []ServiceRecord{current, old}, false},
		{"partial update", "partial", []ServiceRecord{{Name: old.Name, Source: old.Source, State: "active/running"}}, []ServiceRecord{{Name: old.Name, Source: old.Source, State: "active/running"}}, false},
		{"failed", "failed", []ServiceRecord{current}, []ServiceRecord{old}, false},
		{"unsupported", "unsupported", []ServiceRecord{}, []ServiceRecord{old}, false},
		{"uncollected", "uncollected", []ServiceRecord{}, []ServiceRecord{old}, false},
		{"invalid", "bogus", []ServiceRecord{}, []ServiceRecord{old}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			mock.ExpectBegin()
			previous, _ := json.Marshal([]ServiceRecord{old})
			want, _ := json.Marshal(tc.want)
			mock.ExpectQuery("SELECT services FROM asset_service_inventory.*FOR UPDATE").WithArgs("asset").
				WillReturnRows(sqlmock.NewRows([]string{"services"}).AddRow(previous))
			mock.ExpectExec("(?s)INSERT INTO asset_service_inventory.*last_success_at = CASE WHEN.*ELSE asset_service_inventory.last_success_at END").
				WithArgs("asset", string(want), sqlmock.AnyArg(), tc.complete).WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectCommit()
			tx, _ := db.Begin()
			asset := sourceAsset{Services: tc.rows, CollectionStatus: map[string]SectionStatus{"services": {Status: tc.status}}}
			if err := (&Service{db: db}).reconcileServices(context.Background(), tx, "asset", &asset); err != nil {
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

func TestServiceLegacyOmissionMakesNoSnapshotQueries(t *testing.T) {
	for _, rows := range [][]ServiceRecord{nil, {}, {{Name: "legacy", Source: "systemd"}}} {
		db, mock, _ := sqlmock.New()
		mock.ExpectBegin()
		mock.ExpectCommit()
		tx, _ := db.Begin()
		asset := sourceAsset{Services: rows}
		if err := (&Service{db: db}).reconcileServices(context.Background(), tx, "asset", &asset); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
		db.Close()
	}
}

func TestServiceNormalizationBoundsAndAuthority(t *testing.T) {
	rows := make([]ServiceRecord, 10001)
	for i := range rows {
		rows[i] = ServiceRecord{Name: fmt.Sprintf("s%05d", i), Source: "systemd"}
	}
	bounded, section := normalizeServices(rows, SectionStatus{Status: "success"})
	if len(bounded) != 10000 || section.Status != "partial" || !section.Truncated || section.TruncatedCount != 1 || *section.Total != 10001 {
		t.Fatalf("unbounded snapshot or silent truncation: %+v", section)
	}
	wrong := 5
	for _, metadata := range []SectionStatus{
		{Status: "success", Truncated: true},
		{Status: "success", TruncatedCount: 3},
		{Status: "success", Total: &wrong},
		{Status: "success", Returned: &wrong},
		{Status: "success", Error: "secret credentials"},
	} {
		_, status := normalizeServices(rows[:1], metadata)
		if status.Status != "partial" || strings.Contains(status.Error, "secret") {
			t.Fatalf("unsafe authority: %+v", status)
		}
	}
	_, status := normalizeServices([]ServiceRecord{{Name: "", Source: "systemd"}}, SectionStatus{Status: "success"})
	if status.Status != "partial" {
		t.Fatal("invalid row cleared inventory")
	}
	bounded, status = normalizeServices([]ServiceRecord{{Name: strings.Repeat("a", 300), Source: "systemd", DisplayName: "a\x00b"}}, SectionStatus{Status: "success"})
	if len(bounded[0].Name) != 256 || bounded[0].DisplayName != "ab" || status.Status != "partial" {
		t.Fatal("unbounded/unclean fields")
	}
}

func TestServicePartialMergeAtCapacityRetainsPriorKeys(t *testing.T) {
	previous := make([]ServiceRecord, maxServiceRecords)
	for i := range previous {
		previous[i] = ServiceRecord{Name: fmt.Sprintf("s%05d", i), Source: "systemd"}
	}
	changed := previous[0]
	changed.State = "running"
	rows, dropped := mergeServiceObservations(previous, []ServiceRecord{changed, {Name: "new", Source: "systemd"}})
	if len(rows) != maxServiceRecords || dropped != 1 || rows[0].State != "running" || rows[len(rows)-1] != previous[len(previous)-1] {
		t.Fatal("partial merge erased prior observations or exceeded cap")
	}
}

func TestServiceDecodeDropsExecutableFields(t *testing.T) {
	assets, err := (&Service{}).DecodePayload([]byte(`{"assets":[{"asset_tag":"test","services":[{"name":"service","display_name":"Service","state":"stopped","start_mode":"disabled","source":"win32_service","commandline":"never-store-this","StartName":"never-store-this"}],"collection_status":{"services":{"status":"success"}}}]}`))
	if err != nil || len(assets) != 1 {
		t.Fatalf("decode: %v", err)
	}
	rows, section := normalizeServices(assets[0].Services, assets[0].CollectionStatus["services"])
	raw, err := json.Marshal(rows)
	if err != nil || strings.Contains(string(raw), "never-store") || section.Status != "success" {
		t.Fatalf("unexpected service metadata: %s, %v", raw, err)
	}
}

func TestServiceFingerprintIgnoresTimeAndOrderButDetectsState(t *testing.T) {
	asset := sourceAsset{Services: []ServiceRecord{{Name: "b", Source: "systemd"}, {Name: "a", Source: "systemd"}},
		CollectionStatus: map[string]SectionStatus{"services": {Status: "success", ScannedAt: "earlier"}}}
	before := telemetryFingerprint(asset)
	asset.Services[0], asset.Services[1] = asset.Services[1], asset.Services[0]
	asset.CollectionStatus["services"] = SectionStatus{Status: "success", ScannedAt: "later"}
	if telemetryFingerprint(asset) != before {
		t.Fatal("service heartbeat changed fingerprint")
	}
	asset.Services[0].State = "running"
	if telemetryFingerprint(asset) == before {
		t.Fatal("service state change not detected")
	}
	asset.CollectionStatus["services"] = SectionStatus{Status: "failed"}
	before = telemetryFingerprint(asset)
	asset.Services = nil
	if telemetryFingerprint(asset) != before {
		t.Fatal("failed rows affect fingerprint")
	}
}

func TestServiceSyncSnapshotInSameTransaction(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			db, mock, _ := sqlmock.New()
			defer db.Close()
			asset := testTelemetryAsset(0)
			asset.Services = []ServiceRecord{{Name: "ssh.service", Source: "systemd"}}
			asset.CollectionStatus["services"] = SectionStatus{Status: "success"}
			mock.ExpectBegin()
			mock.ExpectQuery("(?s)SELECT id::text FROM assets").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("asset"))
			mock.ExpectQuery("UPDATE assets SET").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("asset"))
			mock.ExpectExec("INSERT INTO asset_compute_details").WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectExec("DELETE FROM asset_software_inventory").WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectQuery("SELECT services FROM asset_service_inventory").WithArgs("asset").WillReturnError(sql.ErrNoRows)
			write := mock.ExpectExec("INSERT INTO asset_service_inventory")
			if fail {
				write.WillReturnError(fmt.Errorf("fixture write failure"))
				mock.ExpectRollback()
			} else {
				write.WillReturnResult(sqlmock.NewResult(0, 1))
				mock.ExpectQuery("SELECT fingerprint FROM asset_inventory_telemetry").WillReturnError(sql.ErrNoRows)
				mock.ExpectExec("INSERT INTO asset_inventory_telemetry").WillReturnResult(sqlmock.NewResult(0, 1))
				mock.ExpectExec("INSERT INTO asset_history").WillReturnResult(sqlmock.NewResult(0, 1))
				mock.ExpectExec("UPDATE asset_alerts SET is_resolved = TRUE").WillReturnResult(sqlmock.NewResult(0, 1))
				mock.ExpectCommit()
			}
			count, err := (&Service{db: db}).syncAssets(context.Background(), []sourceAsset{asset})
			if (err != nil) != fail || !fail && count != 1 {
				t.Fatalf("sync: %d, %v", count, err)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
