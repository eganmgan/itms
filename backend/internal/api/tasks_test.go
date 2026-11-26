package api

import (
	"net/http"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

const taskAssigneeQuery = `(?s)SELECT u\.entity_id::text, u\.is_active, r\.name\s+FROM users u\s+JOIN roles r ON r\.id = u\.role_id\s+WHERE u\.id = \$1::uuid`

func TestListEmployeeTasksForAdmin(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "admin", "admin-1", "entity-1", http.MethodGet, "/api/tasks", "")
	defer cleanup()
	mock.ExpectQuery(`(?s)SELECT t\.id::text, t\.task_number.*FROM employee_tasks t`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "task_number", "title", "description", "status", "priority", "due_date", "created_at", "updated_at", "assignee_id", "assignee_name", "creator_id", "creator_name"}))
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusOK, "employee task list")
}

func TestCreateEmployeeTask(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "admin", "admin-1", "entity-1", http.MethodPost, "/api/tasks", `{"title":"Prepare laptop","description":"Image and assign","assigneeId":"11111111-1111-4111-8111-111111111111","priority":"high","dueDate":"2026-11-25"}`)
	defer cleanup()
	mock.ExpectQuery(taskAssigneeQuery).
		WithArgs("11111111-1111-4111-8111-111111111111").
		WillReturnRows(sqlmock.NewRows([]string{"entity_id", "is_active", "role"}).AddRow("entity-1", true, "it_team"))
	mock.ExpectQuery(`(?s)INSERT INTO employee_tasks .*RETURNING id::text, task_number`).
		WithArgs("entity-1", "Prepare laptop", "Image and assign", "high", "11111111-1111-4111-8111-111111111111", "admin-1", "2026-11-25").
		WillReturnRows(sqlmock.NewRows([]string{"id", "task_number"}).AddRow("22222222-2222-4222-8222-222222222222", "IT-TASK-000001"))
	expectAuditInsert(mock, "admin-1", "entity-1", "task_created", "employee_task", "22222222-2222-4222-8222-222222222222", "")
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusCreated, "create employee task")
}

func TestCreateEmployeeTaskAllowsSuperAdminAssignee(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "admin", "admin-1", "entity-1", http.MethodPost, "/api/tasks", `{"title":"Review deployment","assigneeId":"11111111-1111-4111-8111-111111111111"}`)
	defer cleanup()
	mock.ExpectQuery(taskAssigneeQuery).
		WithArgs("11111111-1111-4111-8111-111111111111").
		WillReturnRows(sqlmock.NewRows([]string{"entity_id", "is_active", "role"}).AddRow("entity-1", true, "super_admin"))
	mock.ExpectQuery(`(?s)INSERT INTO employee_tasks .*RETURNING id::text, task_number`).
		WithArgs("entity-1", "Review deployment", "", "medium", "11111111-1111-4111-8111-111111111111", "admin-1", nil).
		WillReturnRows(sqlmock.NewRows([]string{"id", "task_number"}).AddRow("22222222-2222-4222-8222-222222222222", "IT-TASK-000002"))
	expectAuditInsert(mock, "admin-1", "entity-1", "task_created", "employee_task", "22222222-2222-4222-8222-222222222222", "")
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusCreated, "create task for super admin")
}

func TestCreateEmployeeTaskRejectsEmployeeAssignee(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "admin", "admin-1", "entity-1", http.MethodPost, "/api/tasks", `{"title":"Review deployment","assigneeId":"11111111-1111-4111-8111-111111111111"}`)
	defer cleanup()
	mock.ExpectQuery(taskAssigneeQuery).
		WithArgs("11111111-1111-4111-8111-111111111111").
		WillReturnRows(sqlmock.NewRows([]string{"entity_id", "is_active", "role"}).AddRow("entity-1", true, "employee"))
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusBadRequest, "reject employee task assignee")
}

func TestEmployeeCannotManageTasks(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "employee", "employee-1", "entity-1", http.MethodPost, "/api/tasks", `{"title":"Restricted task"}`)
	defer cleanup()
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusForbidden, "employee task access")
}

func TestUpdateEmployeeTaskRejectsInvalidStatus(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "admin", "admin-1", "entity-1", http.MethodPatch, "/api/tasks/22222222-2222-4222-8222-222222222222", `{"status":"done"}`)
	defer cleanup()
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusBadRequest, "invalid task status")
}

func TestUpdateEmployeeTaskChangesStatusAndAssignee(t *testing.T) {
	taskID := "22222222-2222-4222-8222-222222222222"
	assigneeID := "11111111-1111-4111-8111-111111111111"
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "admin", "admin-1", "entity-1", http.MethodPatch, "/api/tasks/"+taskID, `{"status":"completed","assigneeId":"11111111-1111-4111-8111-111111111111","dueDate":"2026-11-25"}`)
	defer cleanup()
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT entity_id::text FROM employee_tasks WHERE id = $1::uuid`)).
		WithArgs(taskID).WillReturnRows(sqlmock.NewRows([]string{"entity_id"}).AddRow("entity-1"))
	mock.ExpectQuery(taskAssigneeQuery).
		WithArgs(assigneeID).WillReturnRows(sqlmock.NewRows([]string{"entity_id", "is_active", "role"}).AddRow("entity-2", true, "it_team"))
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE employee_tasks SET status = $2, assignee_id = $3::uuid, entity_id = $4::uuid, due_date = $5::date, updated_at = NOW() WHERE id = $1::uuid`)).
		WithArgs(taskID, "completed", assigneeID, "entity-2", "2026-11-25").
		WillReturnResult(sqlmock.NewResult(1, 1))
	expectAuditInsert(mock, "admin-1", "entity-1", "task_updated", "employee_task", taskID, "")
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusOK, "update employee task")
}

func TestUpdateEmployeeTaskRejectsEmployeeAssignee(t *testing.T) {
	taskID := "22222222-2222-4222-8222-222222222222"
	assigneeID := "11111111-1111-4111-8111-111111111111"
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "admin", "admin-1", "entity-1", http.MethodPatch, "/api/tasks/"+taskID, `{"assigneeId":"11111111-1111-4111-8111-111111111111"}`)
	defer cleanup()
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT entity_id::text FROM employee_tasks WHERE id = $1::uuid`)).
		WithArgs(taskID).WillReturnRows(sqlmock.NewRows([]string{"entity_id"}).AddRow("entity-1"))
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT u.entity_id::text, u.is_active, r.name
		FROM users u
		JOIN roles r ON r.id = u.role_id
		WHERE u.id = $1::uuid`)).
		WithArgs(assigneeID).WillReturnRows(sqlmock.NewRows([]string{"entity_id", "is_active", "role"}).AddRow("entity-2", true, "employee"))
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusBadRequest, "reject employee task reassignment")
}

func TestAdminCanReadRequests(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "admin", "admin-1", "entity-1", http.MethodGet, "/api/requests?status=all", "")
	defer cleanup()
	expectRequestListSummaryWithClause(mock, "1 = 1", nil, 0, 0, 0, 0, 0, 0)
	mock.ExpectQuery(`(?s)SELECT r\.id, r\.type.*WHERE 1 = 1`).
		WillReturnRows(sqlmock.NewRows([]string{"id", "type", "title", "description", "status", "notes", "created", "updated", "requester", "requester_name", "assignee", "assignee_name", "ticket_number"}))
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusOK, "admin request list")
}
