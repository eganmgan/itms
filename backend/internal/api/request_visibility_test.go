package api

import (
	"database/sql"
	"errors"
	"net/http"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestITRequestVisibilityRequiresRequesterOrAssignee(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	context, _ := newTestContext(http.MethodGet, "/requests/request-1", newTestClaims("it_team", "user-1", "entity-1"))
	query := regexp.QuoteMeta(`
		SELECT requester.entity_id::text, r.type
		FROM requests r
		JOIN users requester ON requester.id = r.requester_id
		WHERE r.id = $1::uuid
	`) + regexp.QuoteMeta(` AND (r.requester_id = $2::uuid OR r.assignee_id = $2::uuid)`)
	mock.ExpectQuery(query).WithArgs("request-1", "user-1").
		WillReturnRows(sqlmock.NewRows([]string{"entity", "type"}).AddRow("entity-1", "hardware"))
	mock.ExpectQuery(query).WithArgs("request-2", "user-1").WillReturnError(sql.ErrNoRows)
	if kind, err := server.requestScope(context, "request-1"); err != nil || kind != "hardware" {
		t.Fatalf("allowed request: type=%q err=%v", kind, err)
	}
	if _, err := server.requestScope(context, "request-2"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("other request: err=%v, want not found", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestITRequestListFiltersSummaryAndItems(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "it_team", "user-1", "entity-1", http.MethodGet, "/api/requests", "")
	defer cleanup()
	clause := "1 = 1 AND (requester.entity_id = $1::uuid OR EXISTS (SELECT 1 FROM user_entity_access uea WHERE uea.user_id = $2::uuid AND uea.entity_id = requester.entity_id)) AND (r.requester_id = $2::uuid OR r.assignee_id = $2::uuid) AND r.status <> 'rejected'"
	expectRequestListSummaryWithClause(mock, clause, []any{"entity-1", "user-1"}, 0, 0, 0, 0, 0, 0)
	mock.ExpectQuery(`(?s)SELECT r.id, r.type.*WHERE `+regexp.QuoteMeta(clause)).
		WithArgs("entity-1", "user-1").
		WillReturnRows(sqlmock.NewRows([]string{"id", "type", "title", "description", "status", "notes", "created", "updated", "requester", "requester_name", "assignee", "assignee_name", "ticket_number"}))
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusOK, "filtered request list")
}
