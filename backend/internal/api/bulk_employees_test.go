package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

const bulkEmployeeCSV = "emp_id,full_name,email\nEMP001,Taylor Example,taylor@example.invalid\n"

func TestBulkEmployeeDownloadTemplate(t *testing.T) {
	header, err := os.ReadFile("../../../frontend/public/templates/bulk-employees.csv")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parseBulkEmployees(string(header), ""); err == nil {
		t.Fatal("unfilled template accepted")
	}
	input := strings.TrimSpace(string(header)) + "\nEMP001,Taylor Example,taylor@example.invalid\n"
	rows, err := parseBulkEmployees(input, "example.invalid")
	if err != nil || len(rows) != 1 || len(rows[0].Issues) != 0 {
		t.Fatalf("template rejected: %#v %v", rows, err)
	}
	if _, err := parseGLPICSV(strings.NewReader(input)); err == nil {
		t.Fatal("employee template accepted as assets")
	}
}

func TestBulkEmployeeParser(t *testing.T) {
	rows, err := parseBulkEmployees("\ufeffemail,full_name,emp_id\nTAYLOR@example.invalid,\"Taylor, Example\",EMP001\n", "example.invalid")
	if err != nil || len(rows) != 1 || rows[0].Email != "taylor@example.invalid" || len(rows[0].Issues) != 0 {
		t.Fatalf("parse: %#v %v", rows, err)
	}
	for _, body := range []string{"emp_id,email\n", "emp_id,full_name,email,password\n", "emp_id,email,email\n", "emp_id,full_name,email\n\"unfinished", "emp_id,full_name,email\n", strings.Repeat("x", bulkEmployeeMaxBytes+1)} {
		if _, err := parseBulkEmployees(body, ""); err == nil {
			t.Fatal("invalid CSV accepted")
		}
	}
	rows, err = parseBulkEmployees("emp_id,full_name,email\nEMP001,Taylor,taylor@example.invalid\nemp001,Other,TAYLOR@example.invalid\n,Missing,bad-email\n", "company.invalid")
	if err != nil || len(rows[0].Issues) != 3 || len(rows[1].Issues) != 3 || len(rows[2].Issues) < 2 {
		t.Fatalf("issues %#v %v", rows, err)
	}
}

func bulkEmployeeBody(digest string, selected []int) string {
	body, _ := json.Marshal(bulkEmployeeRequest{CSV: bulkEmployeeCSV, EntityID: adminTestEntity, Digest: digest, Rows: selected})
	return string(body)
}

func expectBulkEmployeePlan(mock sqlmock.Sqlmock, duplicate bool) {
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT EXISTS.*FROM entities").WithArgs(adminTestEntity).WillReturnRows(sqlmock.NewRows([]string{"active", "role"}).AddRow(true, true))
	rows := sqlmock.NewRows([]string{"emp_id", "email"})
	if duplicate {
		rows.AddRow("EMP001", "taylor@example.invalid")
	}
	mock.ExpectQuery("SELECT emp_id, email FROM users").WillReturnRows(rows)
}

func TestBulkEmployeeRoleBoundary(t *testing.T) {
	for _, role := range []string{"", "employee", "Admin", "it_team", "auditor"} {
		for _, route := range []string{"preview", "import"} {
			mock, rec, router, req, cleanup := adminRoute(t, role, "POST", "/api/admin/employees/"+route, bulkEmployeeBody("", nil))
			router.ServeHTTP(rec, req)
			want := http.StatusForbidden
			if role == "" {
				want = http.StatusUnauthorized
			}
			assertRouteResult(t, mock, rec, want, "bulk employee role")
			cleanup()
		}
	}
}

func TestBulkEmployeePreviewAndCreate(t *testing.T) {
	var preview struct {
		Rows   []bulkEmployeeRow `json:"rows"`
		Digest string            `json:"digest"`
	}
	mock, rec, router, req, cleanup := adminRoute(t, "admin", "POST", "/api/admin/employees/preview", bulkEmployeeBody("", nil))
	expectBulkEmployeePlan(mock, false)
	mock.ExpectRollback()
	router.ServeHTTP(rec, req)
	assertRouteResult(t, mock, rec, http.StatusOK, "read-only preview")
	if err := json.Unmarshal(rec.Body.Bytes(), &preview); err != nil || len(preview.Rows) != 1 || len(preview.Rows[0].Issues) != 0 {
		t.Fatalf("preview failed %s", rec.Body.String())
	}
	cleanup()
	for _, mode := range []string{"success", "duplicate", "write failure"} {
		t.Run(mode, func(t *testing.T) {
			mock, rec, router, req, cleanup := adminRoute(t, "super_admin", "POST", "/api/admin/employees/import", bulkEmployeeBody(preview.Digest, []int{1}))
			defer cleanup()
			expectBulkEmployeePlan(mock, mode == "duplicate")
			want := http.StatusCreated
			if mode == "duplicate" {
				want = http.StatusConflict
				mock.ExpectRollback()
			} else {
				mock.ExpectQuery("INSERT INTO users .*password_hash, is_active.*").WithArgs("EMP001", "Taylor Example", "taylor@example.invalid", adminTestEntity).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(adminTestUser))
				if mode == "write failure" {
					mock.ExpectExec("INSERT INTO user_entity_access").WillReturnError(errors.New("private SQL detail"))
					mock.ExpectRollback()
					want = http.StatusInternalServerError
				} else {
					mock.ExpectExec("INSERT INTO user_entity_access").WithArgs(adminTestUser, adminTestEntity).WillReturnResult(sqlmock.NewResult(0, 1))
					mock.ExpectCommit()
				}
			}
			router.ServeHTTP(rec, req)
			assertRouteResult(t, mock, rec, want, "create only import")
			if strings.Contains(rec.Body.String(), "private SQL") {
				t.Fatal("private error exposed")
			}
		})
	}
}
