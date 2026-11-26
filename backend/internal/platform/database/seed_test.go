package database

import (
	"database/sql"
	"errors"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"

	"itms/backend/internal/app"
)

const seedEntitySQL = `
	INSERT INTO entities (short_code, full_name)
	VALUES ($1, $2)
	ON CONFLICT (short_code) DO NOTHING`

const seedLocationSQL = `
	INSERT INTO locations (entity_id, location_code, full_name, city, state)
	SELECT id, $2, $3, $4, $5
	FROM entities
	WHERE short_code = $1
	ON CONFLICT (location_code) DO NOTHING`

// No conflict target: both (entity_id, name) and (entity_id, short_code)
// must preserve existing departments, including renamed built-in departments.
const seedDepartmentSQL = `
	INSERT INTO departments (entity_id, name, short_code, description)
	SELECT id, $2, $3, $4
	FROM entities
	WHERE short_code = $1
	ON CONFLICT DO NOTHING`

const seedCategorySQL = `
	INSERT INTO ticket_categories (entity_id, name, description)
	SELECT id, $1, $2
	FROM entities
	WHERE short_code = 'ZBL'
	ON CONFLICT (entity_id, name) DO NOTHING`

const seedAdminExistsSQL = `
	SELECT EXISTS(
		SELECT 1
		FROM users u
		LEFT JOIN roles r ON r.id = u.role_id
		WHERE lower(u.email) = $1 OR r.name IN ('admin', 'super_admin')
	)`

func newSeedTestDB(t *testing.T) (*sql.DB, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherEqual))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Errorf("seed SQL expectations: %v", err)
		}
		_ = db.Close()
	})
	return db, mock
}

func expectSeedEntities(mock sqlmock.Sqlmock, rowsAffected int64) {
	for _, entity := range [][2]string{
		{"ZBL", "Zerodha Broking Limited"},
		{"ZC", "Zerodha Commodities"},
		{"ETS", "ETS"},
		{"NKS", "NK Square"},
		{"ZCAP", "Zerodha Capital"},
		{"RM", "Rainmatter"},
		{"ZTEC", "Zerodha Technology"},
	} {
		mock.ExpectExec(seedEntitySQL).WithArgs(entity[0], entity[1]).
			WillReturnResult(sqlmock.NewResult(0, rowsAffected))
	}
	for _, location := range [][5]string{
		{"ZBL", "ZBL-BLR-HO", "ZBL Head Office, Bangalore", "Bangalore", "Karnataka"},
		{"ZBL", "ZBL-BLR-SO", "ZBL Support Office, Bangalore", "Bangalore", "Karnataka"},
		{"ZBL", "ZBL-BGM-SO", "ZBL Support Office, Belgaum", "Belgaum", "Karnataka"},
	} {
		mock.ExpectExec(seedLocationSQL).
			WithArgs(location[0], location[1], location[2], location[3], location[4]).
			WillReturnResult(sqlmock.NewResult(0, rowsAffected))
	}
}

func expectSeedDepartmentInserts(mock sqlmock.Sqlmock, rowsAffected int64) {
	for _, department := range [][2]string{
		{"IT Team", "ITTEAM"}, {"Support", "SUPPORT"}, {"Accounts", "ACCOUNTS"},
		{"Sales", "SALES"}, {"Quality", "QUALITY"}, {"Human Resources (HR)", "HRESOURCE"},
		{"Mutual Funds", "MFUNDS"}, {"BOCO", "BOCO"}, {"Z-Team", "ZTEAM"},
		{"ACOP", "ACOP"}, {"Process", "PROCESS"},
	} {
		mock.ExpectExec(seedDepartmentSQL).
			WithArgs("ZBL", department[0], department[1], sqlmock.AnyArg()).
			WillReturnResult(sqlmock.NewResult(0, rowsAffected))
	}
}

func expectSeedDepartments(mock sqlmock.Sqlmock, rowsAffected int64) {
	mock.ExpectBegin()
	expectSeedDepartmentInserts(mock, rowsAffected)
	mock.ExpectCommit()
}

func expectSeedCategories(mock sqlmock.Sqlmock, rowsAffected int64) {
	for _, name := range []string{"Hardware", "Software", "Access", "Network", "Security", "General Support"} {
		mock.ExpectExec(seedCategorySQL).WithArgs(name, sqlmock.AnyArg()).
			WillReturnResult(sqlmock.NewResult(0, rowsAffected))
	}
}

func expectSeedRoles(mock sqlmock.Sqlmock, rowsAffected int64) {
	// Production iterates a permission-label map, so its order is unspecified.
	mock.MatchExpectationsInOrder(false)
	for _, key := range []string{
		"assets.view", "assets.edit", "assets.delete", "assets.assign",
		"patches.run", "scripts.run", "terminal.open", "remote.open",
		"users.view", "users.manage", "audit.view", "gatepass.create", "gatepass.approve",
		"dept.manage", "location.manage", "entity.manage", "roles.manage",
	} {
		mock.ExpectExec(`INSERT INTO permissions (key, label) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`).
			WithArgs(key, sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, rowsAffected))
	}
	for role, permissions := range map[string][]string{
		"super_admin": {
			"assets.view", "assets.edit", "assets.delete", "assets.assign",
			"patches.run", "scripts.run", "terminal.open", "remote.open",
			"users.view", "users.manage", "audit.view", "gatepass.create", "gatepass.approve",
			"dept.manage", "location.manage", "entity.manage", "roles.manage",
		},
		"it_team": {
			"assets.view", "assets.edit", "assets.assign", "patches.run", "scripts.run",
			"terminal.open", "remote.open", "users.view", "audit.view", "gatepass.create", "gatepass.approve",
		},
		"employee": {"assets.view", "gatepass.create"},
		"auditor":  {"assets.view", "audit.view"},
	} {
		mock.ExpectExec(`
			INSERT INTO roles (name, is_system) VALUES ($1, $2)
			ON CONFLICT (name) DO UPDATE SET is_system = EXCLUDED.is_system`).
			WithArgs(role, true).WillReturnResult(sqlmock.NewResult(0, 1))
		for _, permission := range permissions {
			mock.ExpectExec(`
				INSERT INTO role_permissions (role_id, permission_id)
				SELECT r.id, p.id FROM roles r
				JOIN permissions p ON p.key = $2 WHERE r.name = $1
				ON CONFLICT (role_id, permission_id) DO NOTHING`).
				WithArgs(role, permission).WillReturnResult(sqlmock.NewResult(0, rowsAffected))
		}
	}
}

func TestSeedEntitiesAndLocationsInsertOnly(t *testing.T) {
	for _, rows := range []int64{0, 1} {
		name := "existing_customized_defaults"
		if rows == 1 {
			name = "missing_defaults"
		}
		t.Run(name, func(t *testing.T) {
			db, mock := newSeedTestDB(t)
			expectSeedEntities(mock, rows)
			if err := seedEntities(db); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSeedDepartmentsNeverDeletesUnassignsOrOverwrites(t *testing.T) {
	for _, rows := range []int64{0, 1} {
		name := "name_or_short_code_conflict"
		if rows == 1 {
			name = "missing_defaults"
		}
		t.Run(name, func(t *testing.T) {
			db, mock := newSeedTestDB(t)
			// Only exact insert-only SQL is allowed: no DELETE, UPDATE, metadata
			// upsert, hostname sequence cleanup, or user/asset unassignment.
			expectSeedDepartments(mock, rows)
			if err := seedDepartments(db); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSeedDepartmentsRollsBackOnInsertError(t *testing.T) {
	db, mock := newSeedTestDB(t)
	want := errors.New("insert failed")
	mock.ExpectBegin()
	mock.ExpectExec(seedDepartmentSQL).WillReturnError(want)
	mock.ExpectRollback()
	if err := seedDepartments(db); !errors.Is(err, want) {
		t.Fatalf("seedDepartments error = %v, want %v", err, want)
	}
}

func TestSeedDepartmentsTransactionErrors(t *testing.T) {
	for _, stage := range []string{"begin", "commit"} {
		t.Run(stage, func(t *testing.T) {
			db, mock := newSeedTestDB(t)
			want := errors.New(stage + " failed")
			if stage == "begin" {
				mock.ExpectBegin().WillReturnError(want)
			} else {
				mock.ExpectBegin()
				expectSeedDepartmentInserts(mock, 0)
				mock.ExpectCommit().WillReturnError(want)
			}
			if err := seedDepartments(db); !errors.Is(err, want) {
				t.Fatalf("seedDepartments error = %v, want %v", err, want)
			}
		})
	}
}

func TestSeedTicketCategoriesPreservesMetadataAndInactiveState(t *testing.T) {
	db, mock := newSeedTestDB(t)
	expectSeedCategories(mock, 0)
	if err := seedTicketCategories(db); err != nil {
		t.Fatal(err)
	}
}

func TestSeedRolesPreservesAdditionalGrantsAndPermissionLabels(t *testing.T) {
	db, mock := newSeedTestDB(t)
	for _, rows := range []int64{1, 0} {
		expectSeedRoles(mock, rows)
		if err := seedRolesAndPermissions(db); err != nil {
			t.Fatal(err)
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSeedDefaultAdminPreservesExistingAccount(t *testing.T) {
	db, mock := newSeedTestDB(t)
	mock.ExpectQuery(seedAdminExistsSQL).WithArgs("existing@example.com").
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	// A nil hasher proves an existing email OR any super-admin skips hashing,
	// inserts, credential resets, profile changes, and activation changes.
	if err := seedDefaultAdmin(db, app.Config{DefaultAdminEmail: "Existing@Example.com"}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestSeedDefaultAdminCreatesOnlyWhenAbsent(t *testing.T) {
	db, mock := newSeedTestDB(t)
	config := app.Config{
		DefaultAdminEmail:    "Admin@Example.com",
		DefaultAdminName:     "Test Admin",
		DefaultAdminPassword: "test-only-input",
	}
	mock.ExpectQuery(seedAdminExistsSQL).WithArgs("admin@example.com").
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectExec(`
		INSERT INTO users (
			emp_id, full_name, email, entity_id, location_id, role_id, password_hash, is_active
		)
		SELECT 'EMP001', $1, $2, e.id, l.id, r.id, $3, TRUE
		FROM entities e
		JOIN roles r ON r.name = 'super_admin'
		LEFT JOIN locations l ON l.location_code = 'ZBL-BLR-HO'
		WHERE e.short_code = 'ZBL'`).
		WithArgs(config.DefaultAdminName, "admin@example.com", "test-only-hash").
		WillReturnResult(sqlmock.NewResult(0, 1))
	calls := 0
	if err := seedDefaultAdmin(db, config, func(password string) (string, error) {
		calls++
		if password != config.DefaultAdminPassword {
			t.Fatal("wrong password passed to hasher")
		}
		return "test-only-hash", nil
	}); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("hasher calls = %d, want 1", calls)
	}
}

func TestSeedDefaultAdminLookupFailureDoesNotResetCredentials(t *testing.T) {
	db, mock := newSeedTestDB(t)
	want := errors.New("lookup failed")
	mock.ExpectQuery(seedAdminExistsSQL).WithArgs("admin@example.com").WillReturnError(want)
	if err := seedDefaultAdmin(db, app.Config{DefaultAdminEmail: "admin@example.com"}, nil); !errors.Is(err, want) {
		t.Fatalf("seedDefaultAdmin error = %v, want %v", err, want)
	}
}

func TestSeedRepeatedStartupPreservesManualRecords(t *testing.T) {
	db, mock := newSeedTestDB(t)
	for restart := 0; restart < 2; restart++ {
		// These exact SQL contracts allow only missing-default inserts and the
		// essential system-role flag. Existing/custom catalog rows, assignments,
		// extra role grants, and accounts must never be updated or deleted.
		expectSeedEntities(mock, 0)
		expectSeedDepartments(mock, 0)
		expectSeedCategories(mock, 0)
		expectSeedRoles(mock, 0)
		mock.ExpectQuery(seedAdminExistsSQL).WithArgs("admin@example.com").
			WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
		if err := Seed(db, app.Config{DefaultAdminEmail: "admin@example.com"}, nil); err != nil {
			t.Fatalf("startup %d: %v", restart, err)
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSeedStopsOnCatalogError(t *testing.T) {
	db, mock := newSeedTestDB(t)
	want := errors.New("entity insert failed")
	mock.ExpectExec(seedEntitySQL).WithArgs("ZBL", "Zerodha Broking Limited").WillReturnError(want)
	err := Seed(db, app.Config{}, nil)
	if !errors.Is(err, want) || !strings.Contains(err.Error(), "seed entity ZBL") {
		t.Fatalf("Seed error = %v, want contextual entity error", err)
	}
}
