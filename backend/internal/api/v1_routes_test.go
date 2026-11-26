package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestV1OpenAPIDocumentsRequiredRoutes(t *testing.T) {
	_, mock, recorder, router, cleanup := newRouterTestHarness(t)
	defer cleanup()

	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/openapi.json", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	var document struct {
		OpenAPI string                           `json:"openapi"`
		Paths   map[string]map[string]interface{} `json:"paths"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &document); err != nil {
		t.Fatalf("decode OpenAPI document: %v", err)
	}
	if document.OpenAPI != "3.0.3" {
		t.Fatalf("openapi = %q, want 3.0.3", document.OpenAPI)
	}
	for path, method := range map[string]string{
		"/auth/forgot-password": "post",
		"/auth/reset-password":  "post",
		"/settings":             "get",
		"/tickets/{id}":         "get",
	} {
		if _, ok := document.Paths[path][method]; !ok {
			t.Errorf("OpenAPI missing %s %s", method, path)
		}
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestV1ForgotPasswordAlias(t *testing.T) {
	_, mock, recorder, router, cleanup := newRouterTestHarness(t)
	defer cleanup()
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT id FROM users WHERE lower(email) = lower($1) AND is_active = TRUE AND auth_type = 'local'`)).
		WithArgs("missing@example.com").
		WillReturnError(sqlmock.ErrCancelled)

	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/forgot-password", strings.NewReader(`{"email":"missing@example.com"}`))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d; body = %s", recorder.Code, http.StatusAccepted, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestV1SettingsRequiresAuthentication(t *testing.T) {
	_, mock, recorder, router, cleanup := newRouterTestHarness(t)
	defer cleanup()

	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/settings", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusUnauthorized)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestEmployeeCannotReadAnotherUsersTicket(t *testing.T) {
	const ticketID = "11111111-1111-1111-1111-111111111111"
	const userID = "22222222-2222-2222-2222-222222222222"
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "employee", userID, "33333333-3333-3333-3333-333333333333", http.MethodGet, "/api/v1/tickets/"+ticketID, "")
	defer cleanup()
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT EXISTS(SELECT 1 FROM requests WHERE id = $1::uuid AND requester_id = $2::uuid)`)).
		WithArgs(ticketID, userID).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))

	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNotFound)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestEmployeeCannotReadInternalNotes(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "employee", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333", http.MethodGet, "/api/v1/tickets/11111111-1111-1111-1111-111111111111/internal-notes", "")
	defer cleanup()

	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusForbidden)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestTicketAttachmentRejectsUnsupportedContent(t *testing.T) {
	const ticketID = "11111111-1111-1111-1111-111111111111"
	const userID = "22222222-2222-2222-2222-222222222222"
	mock, recorder, router, request, cleanup := newRoleMultipartRouteRequest(t, "employee", userID, "33333333-3333-3333-3333-333333333333", http.MethodPost, "/api/v1/tickets/"+ticketID+"/attachments", "", "program.bin", "application/octet-stream", append([]byte{0x7f, 'E', 'L', 'F'}, make([]byte, 508)...))
	defer cleanup()
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT EXISTS(SELECT 1 FROM requests WHERE id = $1::uuid AND requester_id = $2::uuid)`)).
		WithArgs(ticketID, userID).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))

	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body = %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestRefreshRejectsConsumedToken(t *testing.T) {
	_, mock, recorder, router, cleanup := newRouterTestHarness(t)
	defer cleanup()
	mock.ExpectQuery(regexp.QuoteMeta(`DELETE FROM refresh_tokens WHERE token_hash = $1 AND expires_at > NOW() RETURNING user_id`)).
		WithArgs(tokenHash("consumed-token")).
		WillReturnError(sql.ErrNoRows)
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM refresh_tokens WHERE token_hash = $1`)).
		WithArgs(tokenHash("consumed-token")).
		WillReturnResult(sqlmock.NewResult(0, 0))
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh", nil)
	request.AddCookie(&http.Cookie{Name: refreshCookieName, Value: "consumed-token", Path: "/api"})

	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusUnauthorized)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestResetPasswordAliasEnforcesPasswordPolicy(t *testing.T) {
	_, mock, recorder, router, cleanup := newRouterTestHarness(t)
	defer cleanup()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/reset-password", strings.NewReader(`{"token":"reset-token","newPassword":"weak"}`))
	request.Header.Set("Content-Type", "application/json")

	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}