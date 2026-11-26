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

func TestGLPICSVFormats(t *testing.T) {
	input := "\ufeff\"Name\";\"Entity\";\"Status\";\"Inventory/Asset Number\";\"Comments\";\n\"Keyboard (100)\";\"Example Ltd\";\"Deployed\";\" TAG-1 \";\"line one\nline two; with separator\";\n"
	rows, err := parseGLPICSV(strings.NewReader(input))
	if err != nil || len(rows) != 1 {
		t.Fatalf("parse: %v, rows %d", err, len(rows))
	}
	if rows[0].Fields["Inventory/Asset Number"] != "TAG-1" || rows[0].Fields["Comments"] != "line one\nline two; with separator" || len(rows[0].Issues) != 0 {
		t.Fatalf("unexpected row: %#v", rows[0])
	}
	computer := "Name;Entity;Status;Serial Number;Type;Model;Inventory/Asset Number;Operating System - Name;Technician in Charge;Financial & Administrative Information - Start Date of Warranty;Components - Firmware;\nLaptop (2);Example Ltd;Scrapped;SERIAL;Critical Asset;ThinkPad;TAG-2;Linux;Technician (8);2022-08-01;BIOS;\n"
	rows, err = parseGLPICSV(strings.NewReader(computer))
	if err != nil || len(rows) != 1 || rows[0].Fields["Serial Number"] != "SERIAL" || rows[0].Fields["Technician in Charge"] != "Technician (8)" {
		t.Fatalf("computer parse: %v, %#v", err, rows)
	}
}

func TestBulkAssetDownloadTemplate(t *testing.T) {
	header, err := os.ReadFile("../../../frontend/public/templates/bulk-assets.csv")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parseGLPICSV(strings.NewReader(string(header))); err == nil {
		t.Fatal("unfilled template accepted")
	}
	input := strings.TrimSpace(string(header)) + "\nExample keyboard;Example Ltd;Deployed;KEY-1;Wired Keyboard;SER-1;Dell;KB216;;;2022-08-01;Imported equipment\n"
	rows, err := parseGLPICSV(strings.NewReader(input))
	if err != nil || len(rows) != 1 {
		t.Fatalf("template rejected: %v", err)
	}
	draft := glpiValidateDraft(rows[0], nil)
	if len(draft.Issues) != 0 || draft.Category != "accessory" || draft.Fields["Model"] != "KB216" {
		t.Fatalf("template issues: %#v", draft)
	}
	if _, err := parseBulkEmployees(input, ""); err == nil {
		t.Fatal("asset template accepted as employees")
	}
}

func TestGLPICSVReviewIssues(t *testing.T) {
	rows, err := parseGLPICSV(strings.NewReader("Name;Entity;Status;Inventory/Asset Number;\nFirst;Example;Deployed; tag-1 ;\nSecond;Example;Scrapped;TAG-1;\nThird;Example;;;\n"))
	if err != nil || len(rows) != 3 {
		t.Fatalf("parse: %v", err)
	}
	if len(rows[0].Issues) != 1 || len(rows[1].Issues) != 1 || len(rows[2].Issues) != 2 {
		t.Fatalf("issues: %#v", rows)
	}
}

func TestGLPICSVRejectsMalformed(t *testing.T) {
	for _, input := range []string{
		"Name,Entity,Status,Inventory/Asset Number\n",
		"Name;Entity;Status;Inventory/Asset Number;Name\n",
		"Name;Entity;Status;Inventory/Asset Number;\n",
		"Name;Entity;Status;Inventory/Asset Number;\nA;B;Deployed;TAG;extra\n",
		"Name;Entity;Status;Inventory/Asset Number;\n\"unterminated;B;Deployed;TAG;\n",
		"Name;Entity;Status;Inventory/Asset Number;\nA;B;Deployed;TAG\n",
		"Name;Entity;Status;Inventory/Asset Number;\nA;B;Deployed;\xff;\n",
	} {
		if _, err := parseGLPICSV(strings.NewReader(input)); err == nil {
			t.Fatal("malformed CSV accepted")
		}
	}
}

const glpiTestCSV = "Name;Entity;Status;Inventory/Asset Number;Type;\nKeyboard;Example Ltd;Deployed;KEY-1;Wired Keyboard;\n"

func glpiTestBody(digest string, rows []int) string {
	body, _ := json.Marshal(glpiRequest{CSV: glpiTestCSV, Digest: digest, Rows: rows})
	return string(body)
}

func expectGLPIPlan(mock sqlmock.Sqlmock, existing bool) {
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT id::text, full_name FROM entities WHERE is_active").WillReturnRows(sqlmock.NewRows([]string{"id", "full_name"}).AddRow(adminTestEntity, "Example Ltd"))
	mock.ExpectQuery("SELECT id::text, entity_id::text, full_name FROM locations WHERE is_active").WillReturnRows(sqlmock.NewRows([]string{"id", "entity_id", "full_name"}))
	assets := sqlmock.NewRows([]string{"asset_tag", "serial_number"})
	if existing {
		assets.AddRow(" key-1 ", "")
	}
	mock.ExpectQuery("SELECT asset_tag, COALESCE").WillReturnRows(assets)
}

func TestGLPIRoleBoundary(t *testing.T) {
	for _, role := range []string{"", "employee", "it_team", "Admin", "auditor"} {
		for _, path := range []string{"/api/admin/glpi/preview", "/api/admin/glpi/import"} {
			mock, rec, router, req, cleanup := adminRoute(t, role, "POST", path, glpiTestBody("", nil))
			router.ServeHTTP(rec, req)
			want := http.StatusForbidden
			if role == "" {
				want = http.StatusUnauthorized
			}
			assertRouteResult(t, mock, rec, want, "GLPI role boundary")
			cleanup()
		}
	}
}

func TestGLPIPreviewAndImport(t *testing.T) {
	var preview struct {
		Rows   []glpiDraft `json:"rows"`
		Digest string      `json:"digest"`
	}
	mock, rec, router, req, cleanup := adminRoute(t, "admin", "POST", "/api/admin/glpi/preview", glpiTestBody("", nil))
	expectGLPIPlan(mock, false)
	mock.ExpectRollback()
	router.ServeHTTP(rec, req)
	assertRouteResult(t, mock, rec, http.StatusOK, "GLPI preview read only")
	if err := json.Unmarshal(rec.Body.Bytes(), &preview); err != nil || len(preview.Rows) != 1 || len(preview.Rows[0].Issues) != 0 || preview.Rows[0].IsCompute {
		t.Fatalf("preview: %v %s", err, rec.Body.String())
	}
	cleanup()
	for _, existing := range []bool{false, true} {
		mock, rec, router, req, cleanup := adminRoute(t, "super_admin", "POST", "/api/admin/glpi/import", glpiTestBody(preview.Digest, []int{1}))
		expectGLPIPlan(mock, existing)
		want := http.StatusCreated
		if existing {
			want = http.StatusConflict
			mock.ExpectRollback()
		} else {
			mock.ExpectQuery("INSERT INTO assets").WithArgs("KEY-1", "Keyboard", "accessory", false, "", "", "", adminTestEntity, "", "in_use", "", sqlmock.AnyArg()).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(adminTestAsset))
			mock.ExpectExec("INSERT INTO asset_history").WithArgs(adminTestAsset, adminTestUser, 1).WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectCommit()
		}
		router.ServeHTTP(rec, req)
		assertRouteResult(t, mock, rec, want, "GLPI commit revalidation")
		cleanup()
	}
}

func TestGLPICategoryAndStatus(t *testing.T) {
	row := glpiRow{Fields: map[string]string{"Name": "Computer", "Type": "Critical Asset", "Status": "Scrapped", "Inventory/Asset Number": "PC-1"}, Issues: []string{}}
	draft := glpiValidateDraft(row, map[string]string{"Critical Asset": "laptop"})
	if !draft.IsCompute || draft.Status != "scrapped" || len(draft.Issues) != 0 {
		t.Fatalf("invalid mapping: %#v", draft)
	}
	draft = glpiValidateDraft(row, nil)
	if len(draft.Issues) == 0 {
		t.Fatal("unmapped critical type accepted")
	}
}

func TestGLPIAutomaticCategories(t *testing.T) {
	for _, test := range []struct{ name, kind, equipment, category, source string }{
		{"keyboard", "Wired Keyboard", "Dell Keyboard", "accessory", "type"},
		{"charger", "65 Watt Standard adaptor-Type C", "Lenovo 65W AC Adapter", "accessory", "type"},
		{"missing type adapter", "", "Headset Iphone Adaptor 3.5 to C type", "accessory", "name"},
		{"missing type mouse", "", "Wireless Mouse", "accessory", "name"},
		{"missing type monitor", "", "Dell Monitor", "monitor", "name"},
		{"critical laptop", "Critical Asset", "Lenovo ThinkPad", "laptop", "name"},
		{"critical desktop", "Critical Asset", "Dell OptiPlex", "desktop", "name"},
		{"critical unknown", "Critical Asset", "acop.zbl-2766|Example (3138)", "", "unresolved"},
		{"missing unknown", "", "Equipment 123", "", "unresolved"},
		{"conflicting labels", "Wired Keyboard", "Dell Monitor", "", "unresolved"},
		{"ambiguous equipment", "", "Printer / Scanner", "", "unresolved"},
		{"laptop charger", "", "Laptop charger", "accessory", "name"},
		{"word boundaries", "", "backups phonebook mousepad", "", "unresolved"},
		{"network", "Network Switch", "Cisco", "network", "type"},
		{"cctv", "CCTV", "Camera", "cctv", "type"},
		{"ups", "UPS", "APC", "ups", "type"},
	} {
		t.Run(test.name, func(t *testing.T) {
			row := glpiRow{Fields: map[string]string{"Type": test.kind, "Name": test.equipment, "Status": "Deployed", "Inventory/Asset Number": "TAG-1"}, Issues: []string{}}
			draft := glpiValidateDraft(row, nil)
			if draft.Category != test.category || draft.CategorySource != test.source || (len(draft.Issues) == 0) != (test.category != "") {
				t.Fatalf("unexpected suggestion: %#v", draft)
			}
			if test.category != "" && !strings.Contains(strings.Join(draft.Warnings, " "), "automatically suggested") {
				t.Fatal("automatic suggestion missing review warning")
			}
			overridden := glpiValidateDraft(row, map[string]string{test.kind: "server"})
			if overridden.Category != "server" || overridden.CategorySource != "manual" || !overridden.IsCompute {
				t.Fatalf("manual override ignored: %#v", overridden)
			}
		})
	}
}

func TestAdminAccessoriesReadOnly(t *testing.T) {
	for _, role := range []string{"super_admin", "admin", "employee", ""} {
		mock, rec, router, req, cleanup := adminRoute(t, role, "GET", "/api/admin/accessories?search=keyboard&page=2", "")
		want := http.StatusForbidden
		if role == "" {
			want = http.StatusUnauthorized
		} else if isAdminRole(role) {
			want = http.StatusOK
			mock.ExpectQuery("WITH equipment AS").WithArgs("keyboard", 50).WillReturnRows(sqlmock.NewRows([]string{"item"}).AddRow([]byte(`{"id":"example","source":"asset","name":"Keyboard"}`)))
		}
		router.ServeHTTP(rec, req)
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
		assertRouteResult(t, mock, rec, want, "read-only accessories")
		cleanup()
	}
}

func TestGLPIImportRollsBackFailedWrite(t *testing.T) {
	rows, _ := parseGLPICSV(strings.NewReader(glpiTestCSV))
	draft := glpiValidateDraft(rows[0], nil)
	draft.EntityID = adminTestEntity
	mock, rec, router, req, cleanup := adminRoute(t, "super_admin", "POST", "/api/admin/glpi/import", glpiTestBody(glpiDigest([]glpiDraft{draft}), []int{1}))
	defer cleanup()
	expectGLPIPlan(mock, false)
	mock.ExpectQuery("INSERT INTO assets").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(adminTestAsset))
	mock.ExpectExec("INSERT INTO asset_history").WillReturnError(errors.New("private database error"))
	mock.ExpectRollback()
	router.ServeHTTP(rec, req)
	assertRouteResult(t, mock, rec, http.StatusInternalServerError, "atomic rollback")
	if strings.Contains(rec.Body.String(), "private database error") {
		t.Fatal("database details leaked")
	}
}

func TestGLPIImportComputerDoesNotInventAgentReport(t *testing.T) {
	input := glpiRequest{CSV: "Name;Entity;Status;Inventory/Asset Number;Type;Serial Number;Operating System - Name;\nLaptop;Example Ltd;Scrapped;PC-1;Critical Asset;SER-1;Ubuntu;\n", Categories: map[string]string{"Critical Asset": "laptop"}, Rows: []int{1}}
	rows, _ := parseGLPICSV(strings.NewReader(input.CSV))
	draft := glpiValidateDraft(rows[0], input.Categories)
	draft.EntityID = adminTestEntity
	input.Digest = glpiDigest([]glpiDraft{draft})
	body, _ := json.Marshal(input)
	mock, rec, router, req, cleanup := adminRoute(t, "super_admin", "POST", "/api/admin/glpi/import", string(body))
	defer cleanup()
	expectGLPIPlan(mock, false)
	mock.ExpectQuery("INSERT INTO assets").WithArgs("PC-1", "Laptop", "laptop", true, "SER-1", "", "", adminTestEntity, "", "scrapped", "", sqlmock.AnyArg()).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(adminTestAsset))
	mock.ExpectExec(`INSERT INTO asset_compute_details \(asset_id, os_name\) VALUES`).WithArgs(adminTestAsset, "Ubuntu").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO asset_history").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	router.ServeHTTP(rec, req)
	assertRouteResult(t, mock, rec, http.StatusCreated, "computer import without agent timestamp")
}
