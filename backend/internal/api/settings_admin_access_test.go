package api

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestAdminSettingsEntityListIncludesOtherEntities(t *testing.T) {
	mock, recorder, router, request, cleanup := adminRoute(t, "admin", http.MethodGet, "/api/entities", "")
	defer cleanup()
	createdAt := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	mock.ExpectQuery(`SELECT id, short_code, full_name, is_active, created_at FROM entities ORDER BY short_code`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "short_code", "full_name", "is_active", "created_at"}).
			AddRow(adminTestOther, "OTHER", "Other Entity", true, createdAt))

	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusOK, "admin global Settings entity list")
	var items []map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &items); err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0]["id"] != adminTestOther {
		t.Fatalf("admin did not receive the entity outside the account scope: %s", recorder.Body.String())
	}
}

func TestAdminUserListIncludesUsersFromOtherEntities(t *testing.T) {
	mock, recorder, router, request, cleanup := adminRoute(t, "admin", http.MethodGet, "/api/users?page=1&page_size=25", "")
	defer cleanup()
	mock.ExpectQuery(`SELECT u.id::text,[\s\S]*FROM users u[\s\S]*WHERE 1 = 1 AND lower\(u.full_name\) NOT LIKE '%probe%'[\s\S]*ORDER BY COALESCE\(u.full_name, ''\), COALESCE\(u.email, ''\), u.id LIMIT \$1 OFFSET \$2`).
		WithArgs(25, 0).
		WillReturnRows(sqlmock.NewRows([]string{"id", "full_name", "email", "emp_id", "status", "entity_id", "dept_id", "location_id", "role", "department", "location", "asset_count", "count"}).
			AddRow(adminTestOther, "Other Admin", "other@example.invalid", "EMP-OTHER", "active", adminTestOther, "", "", "super_admin", "", "", 0, 1))
	mock.ExpectQuery(`SELECT department_label, COUNT\(\*\)[\s\S]*WHERE 1 = 1 AND lower\(u\.full_name\) NOT LIKE '%probe%'`).
		WillReturnRows(sqlmock.NewRows([]string{"department_label", "count"}))

	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusOK, "admin global user list")
	var response struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Items) != 1 || response.Items[0]["role"] != "super_admin" || response.Items[0]["entity_id"] != adminTestOther {
		t.Fatalf("admin did not receive the super_admin account outside its entity: %s", recorder.Body.String())
	}
}

func TestAdminCanReadGlobalWorkflowSettings(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "admin", "user-1", "entity-1", http.MethodGet, "/api/settings/workflow", "")
	defer cleanup()
	expectWorkflowSettingsLookup(mock, `{}`)

	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusOK, "admin workflow Settings access")
}

func TestAdminCanReadChatAssignmentSettings(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "admin", "user-1", "entity-1", http.MethodGet, "/api/settings/chat", "")
	defer cleanup()
	expectWorkflowSettingsLookup(mock, `{}`)
	mock.ExpectQuery(`SELECT u.id, u.full_name, r.name,[\s\S]*ORDER BY u.full_name, u.id`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "full_name", "name", "online"}))

	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusOK, "admin chat Settings access")
}
