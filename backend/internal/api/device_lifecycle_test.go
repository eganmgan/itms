package api

import (
	"context"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

const lifecycleTestAsset = "30000000-0000-0000-0000-000000000003"
const lifecycleTestEntity = "10000000-0000-0000-0000-000000000001"

func TestLifecycleEditValidation(t *testing.T) {
	for _, test := range []struct {
		key, value string
		valid      bool
	}{
		{"cost", "0", true}, {"cost", "9999999999.99", true}, {"cost", "-1", false}, {"cost", "1.001", false},
		{"warrantyDurationMonths", "0", true}, {"warrantyDurationMonths", "1201", false}, {"warrantyDurationMonths", "1.5", false},
		{"purchaseDate", "2026-02-28", true}, {"purchaseDate", "2026-02-30", false}, {"purchaseDate", "0000-01-01", false},
		{"supplierName", "Example supplier", true}, {"supplierName", "bad\x00name", false}, {"cost", "", true},
	} {
		err := validateLifecycleFields(map[string]*string{test.key: &test.value})
		if (err == nil) != test.valid {
			t.Errorf("%s=%q: %v", test.key, test.value, err)
		}
	}
}

func TestLifecycleEditRoles(t *testing.T) {
	for _, role := range []string{"super_admin", "it_team", "admin", "employee", "auditor", ""} {
		for _, used := range []bool{false, true} {
			want := role == "super_admin" || role == "it_team" && !used
			if canEditLifecycle(role, used) != want {
				t.Fatalf("role=%s used=%v", role, used)
			}
		}
	}
}

func TestLifecycleEditLock(t *testing.T) {
	for _, used := range []bool{false, true} {
		db, mock, err := sqlmock.New()
		if err != nil {
			t.Fatal(err)
		}
		mock.ExpectBegin()
		mock.ExpectQuery("SELECT entity_id::text FROM assets.*FOR UPDATE").WithArgs(lifecycleTestAsset).
			WillReturnRows(sqlmock.NewRows([]string{"entity_id"}).AddRow(lifecycleTestEntity))
		mock.ExpectQuery("SELECT EXISTS.*it_team_lifecycle_saved").WithArgs(lifecycleTestAsset).
			WillReturnRows(sqlmock.NewRows([]string{"used"}).AddRow(used))
		mock.ExpectRollback()
		tx, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		entityID, actual, err := lockLifecycleEdit(context.Background(), tx, lifecycleTestAsset)
		if err != nil || actual != used || entityID != lifecycleTestEntity {
			t.Fatalf("entity=%s used=%v err=%v", entityID, actual, err)
		}
		_ = tx.Rollback()
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
		_ = db.Close()
	}
}

func TestLifecycleEditLookupFailure(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectQuery("SELECT EXISTS.*it_team_lifecycle_saved").WillReturnError(errors.New("unavailable"))
	if _, err := lifecycleEditUsed(context.Background(), db, lifecycleTestAsset); err == nil {
		t.Fatal("lookup failure must not grant an edit")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
