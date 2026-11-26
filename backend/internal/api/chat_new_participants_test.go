package api

import (
	"net/http"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestListNewChatParticipants(t *testing.T) {
	mock, rec, router, req, cleanup := newRoleRouteRequest(t, "employee", "user-1", "entity-1", http.MethodGet, "/api/chat/participants?page=1", "")
	defer cleanup()
	mock.ExpectQuery(`SELECT u.id::text, u.full_name`).WithArgs("", "user-1", "employee", "entity-1", 0, "").
		WillReturnRows(sqlmock.NewRows([]string{"id", "name", "member"}).AddRow("user-1", "Self", true).AddRow("user-2", "Person", false))
	router.ServeHTTP(rec, req)
	assertRouteResult(t, mock, rec, http.StatusOK, "new chat participants")
}

func TestSearchNewChatParticipants(t *testing.T) {
	mock, rec, router, req, cleanup := newRoleRouteRequest(t, "employee", "user-1", "entity-1", http.MethodGet, "/api/chat/participants?page=2&search=alex", "")
	defer cleanup()
	mock.ExpectQuery(`(?s)SELECT u.id::text, u.full_name.*strpos\(lower\(u.full_name\), lower\(\$6\)\).*strpos\(lower\(u.emp_id\), lower\(\$6\)\)`).
		WithArgs("", "user-1", "employee", "entity-1", 50, "alex").
		WillReturnRows(sqlmock.NewRows([]string{"id", "name", "member"}).AddRow("user-2", "Alex", false))
	router.ServeHTTP(rec, req)
	assertRouteResult(t, mock, rec, http.StatusOK, "search scoped participants")
}
