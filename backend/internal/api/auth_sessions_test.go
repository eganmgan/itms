package api

import (
	"net/http"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"itms/backend/internal/app"
)

func TestIssueRefreshCookieStoresHashAndSetsSecureCookie(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO refresh_tokens`).
		WithArgs("user-1", sqlmock.AnyArg(), int64((7 * 24 * time.Hour).Seconds())).
		WillReturnResult(sqlmock.NewResult(0, 1))
	context, recorder := newTestContext(http.MethodPost, "/api/auth/refresh", nil)
	server := &apiServer{db: db, config: app.Config{RefreshTokenTTL: 7 * 24 * time.Hour, RefreshCookieSecure: true}}

	if err := server.issueRefreshCookie(context, "user-1"); err != nil {
		t.Fatalf("issueRefreshCookie: %v", err)
	}

	cookies := recorder.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookie count = %d, want 1", len(cookies))
	}
	cookie := cookies[0]
	if cookie.Name != refreshCookieName || cookie.Value == "" || !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != 3 || cookie.Path != "/api" {
		t.Fatalf("unexpected refresh cookie: %+v", cookie)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("sql expectations: %v", err)
	}
}