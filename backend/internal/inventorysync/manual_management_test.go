package inventorysync

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// SQL contract tests deliberately check every owned column in BOTH update paths.
// No live database or environment configuration is used.
func TestManualManagementSurvivesInventoryUpserts(t *testing.T) {
	for _, existing := range []bool{true, false} {
		t.Run(fmt.Sprintf("existing=%t", existing), func(t *testing.T) {
			matcher := sqlmock.QueryMatcherFunc(func(expected, actual string) error {
				actual = strings.Join(strings.Fields(actual), " ")
				if expected == "lookup" {
					if !strings.HasPrefix(actual, "SELECT id::text FROM assets") {
						return fmt.Errorf("expected identity lookup, got %s", actual)
					}
					return nil
				}
				prefix, owner, columnPrefix := "UPDATE assets SET", "manually_managed", ""
				if !existing {
					prefix, owner, columnPrefix = "INSERT INTO assets", "assets.manually_managed", "assets."
					if !strings.Contains(actual, "ON CONFLICT (asset_tag) DO UPDATE SET") {
						return fmt.Errorf("missing conflict path")
					}
				}
				if !strings.HasPrefix(actual, prefix) {
					return fmt.Errorf("expected %s", prefix)
				}
				for _, column := range []string{"name", "hostname", "category", "is_compute", "serial_number", "manufacturer", "model", "entity_id", "assigned_to", "dept_id", "location_id", "purchase_date", "warranty_until", "status", "condition", "notes"} {
					guard := column + " = CASE WHEN " + owner + " THEN " + columnPrefix + column + " ELSE "
					if !strings.Contains(actual, guard) {
						return fmt.Errorf("manual %s could be overwritten: missing %s", column, guard)
					}
				}
				// These management columns must never be written by the agent.
				for _, column := range []string{"cost", "warranty_start_date", "warranty_duration_months", "supplier_id", "technician_in_charge_id", "group_in_charge_id", "update_sources", "manually_managed"} {
					if strings.Contains(actual, column+" =") {
						return fmt.Errorf("sync writes administrator-owned %s", column)
					}
				}
				for _, column := range []string{"purchase_date", "warranty_until", "status"} {
					if !strings.Contains(actual, "ELSE COALESCE("+columnPrefix+column+",") {
						return fmt.Errorf("legacy lifecycle field %s is not preserved", column)
					}
				}
				if existing && !strings.Contains(actual, "asset_tag = CASE WHEN manually_managed THEN asset_tag ELSE $2 END") {
					return fmt.Errorf("manual asset number can be overwritten")
				}
				identity := "salt_minion_id = COALESCE(NULLIF($20, ''), salt_minion_id)"
				if !existing {
					identity = "salt_minion_id = COALESCE(EXCLUDED.salt_minion_id, assets.salt_minion_id)"
				}
				if !strings.Contains(actual, identity) {
					return fmt.Errorf("omitted Salt identity can erase enrollment")
				}
				return nil
			})
			db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(matcher))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			mock.ExpectBegin()
			lookup := mock.ExpectQuery("lookup").WithArgs("", "", "", "PC-1", "pc-1")
			if existing {
				lookup.WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("asset-1"))
			} else {
				lookup.WillReturnError(sql.ErrNoRows)
			}
			mock.ExpectQuery("upsert").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("asset-1"))
			mock.ExpectRollback()
			tx, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			service := &Service{db: db}
			// Empty purchase/warranty and default in_use status simulate routine polling.
			id, err := service.upsertAsset(context.Background(), tx, sourceAsset{AssetTag: "PC-1", Hostname: "pc-1", IsCompute: true}, "entity-1", "", "", "")
			if err != nil || id != "asset-1" {
				t.Fatalf("upsert = %s, %v", id, err)
			}
			_ = tx.Rollback()
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestManualManagementOSPreservedWhileTelemetryUpdates(t *testing.T) {
	matcher := sqlmock.QueryMatcherFunc(func(_, actual string) error {
		actual = strings.Join(strings.Fields(actual), " ")
		// A legacy computer claimed via a metadata-only PATCH can lack a detail
		// row. Protect its unrecorded OS on INSERT, not just ON CONFLICT.
		insert := strings.SplitN(actual, "ON CONFLICT", 2)[0]
		for _, param := range []string{"$9", "$12"} {
			guard := "CASE WHEN EXISTS (SELECT 1 FROM assets WHERE id = $1::uuid AND manually_managed) THEN NULL ELSE NULLIF(" + param + ", '') END"
			if !strings.Contains(insert, guard) {
				return fmt.Errorf("missing initial OS ownership guard: %s", param)
			}
		}
		for _, field := range []string{"os_name", "architecture"} {
			guard := field + " = CASE WHEN EXISTS (SELECT 1 FROM assets WHERE id = EXCLUDED.asset_id AND manually_managed) THEN asset_compute_details." + field
			if !strings.Contains(actual, guard) {
				return fmt.Errorf("missing OS ownership guard: %s", field)
			}
		}
		for _, assignment := range []string{"pending_updates = COALESCE($17, asset_compute_details.pending_updates)", "last_seen = COALESCE(EXCLUDED.last_seen, asset_compute_details.last_seen)", "processor = COALESCE(EXCLUDED.processor, asset_compute_details.processor)"} {
			if !strings.Contains(actual, assignment) {
				return fmt.Errorf("telemetry update removed: %s", assignment)
			}
		}
		return nil
	})
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(matcher))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectBegin()
	mock.ExpectExec("compute upsert").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectRollback()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{db: db}
	count := 3
	if err := service.upsertComputeDetails(context.Background(), tx, "asset-1", &computeDetails{OSName: "Agent OS", Architecture: "arm64", PendingUpdates: &count}); err != nil {
		t.Fatal(err)
	}
	_ = tx.Rollback()
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
