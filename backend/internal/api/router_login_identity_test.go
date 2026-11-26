package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"itms/backend/internal/app"
	"itms/backend/internal/platform/authn"
)

func assertLoginRejectedWithoutSession(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "authentication failed" || len(body) != 1 {
		t.Fatalf("expected uniform authentication failure, got %s", recorder.Body.String())
	}
	if len(recorder.Result().Cookies()) != 0 {
		t.Fatal("rejected login must not set session cookies")
	}
}

func loginIdentityRows(hash any, active bool, mfa bool, email string) *sqlmock.Rows {
	return sqlmock.NewRows([]string{"id", "emp_id", "full_name", "email", "entity_id", "dept_id", "location_id", "role", "password_hash", "is_active", "mfa_enabled", "totp_secret", "mfa_backup_codes"}).
		AddRow("user-1", "Z3662", "Test User", email, "entity-1", nil, nil, "employee", hash, active, mfa, nil, "{}")
}

func TestRouterLoginIdentitySecurity(t *testing.T) {
	const password = "ValidPass#2026"
	hash, err := authn.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name     string
		payload  string
		argument string
		employee bool
		unknown  bool
		inactive bool
		mfa      bool
		hash     any
		email    string
		status   int
	}{
		{name: "email field", payload: `{"email":" USER@ZERODHA.COM ","password":"ValidPass#2026"}`, argument: "user@zerodha.com", hash: hash, status: 200},
		{name: "email identity", payload: `{"identity":" USER@ZERODHA.COM ","password":"ValidPass#2026"}`, argument: "user@zerodha.com", hash: hash, status: 200},
		{name: "employee identity", payload: `{"identity":" z3662 ","password":"ValidPass#2026"}`, argument: "z3662", employee: true, hash: hash, status: 200},
		{name: "email takes precedence", payload: `{"email":"user@zerodha.com","identity":"OTHER-ID","password":"ValidPass#2026"}`, argument: "user@zerodha.com", hash: hash, status: 200},
		{name: "blank email uses identity", payload: `{"email":" ","identity":"Z3662","password":"ValidPass#2026"}`, argument: "Z3662", employee: true, hash: hash, status: 200},
		{name: "unknown email does not fall back", payload: `{"email":"user@zerodha.com","identity":"Z3662","password":"ValidPass#2026"}`, argument: "user@zerodha.com", unknown: true, status: 401},
		{name: "unknown employee", payload: `{"identity":"Z3662","password":"ValidPass#2026"}`, argument: "Z3662", employee: true, unknown: true, status: 401},
		{name: "inactive employee", payload: `{"identity":"Z3662","password":"ValidPass#2026"}`, argument: "Z3662", employee: true, hash: hash, inactive: true, status: 401},
		{name: "employee wrong password", payload: `{"identity":"Z3662","password":"wrong"}`, argument: "Z3662", employee: true, hash: hash, status: 401},
		{name: "email wrong password", payload: `{"identity":"user@zerodha.com","password":"wrong"}`, argument: "user@zerodha.com", hash: hash, status: 401},
		{name: "employee empty hash", payload: `{"identity":"Z3662","password":"ValidPass#2026"}`, argument: "Z3662", employee: true, hash: "", status: 401},
		{name: "employee null hash", payload: `{"identity":"Z3662","password":"ValidPass#2026"}`, argument: "Z3662", employee: true, status: 401},
		{name: "email null hash", payload: `{"email":"user@zerodha.com","password":"ValidPass#2026"}`, argument: "user@zerodha.com", status: 401},
		{name: "employee invalid hash", payload: `{"identity":"Z3662","password":"ValidPass#2026"}`, argument: "Z3662", employee: true, hash: "not-a-password-hash", status: 401},
		{name: "employee foreign domain", payload: `{"identity":"Z3662","password":"ValidPass#2026"}`, argument: "Z3662", employee: true, hash: hash, email: "user@external.example", status: 401},
		{name: "employee subdomain denied", payload: `{"identity":"Z3662","password":"ValidPass#2026"}`, argument: "Z3662", employee: true, hash: hash, email: "user@sub.zerodha.com", status: 401},
		{name: "employee malformed resolved email", payload: `{"identity":"Z3662","password":"ValidPass#2026"}`, argument: "Z3662", employee: true, hash: hash, email: "User <user@zerodha.com>", status: 401},
		{name: "employee MFA required", payload: `{"identity":"Z3662","password":"ValidPass#2026"}`, argument: "Z3662", employee: true, hash: hash, mfa: true, status: 200},
		{name: "email MFA required", payload: `{"email":"user@zerodha.com","password":"ValidPass#2026"}`, argument: "user@zerodha.com", hash: hash, mfa: true, status: 200},
		{name: "MFA does not bypass password", payload: `{"identity":"Z3662","password":"wrong"}`, argument: "Z3662", employee: true, hash: hash, mfa: true, status: 401},
		{name: "MFA does not bypass missing hash", payload: `{"identity":"Z3662","password":"ValidPass#2026"}`, argument: "Z3662", employee: true, mfa: true, status: 401},
		{name: "blank identity", payload: `{"identity":" ","password":"ValidPass#2026"}`, status: 401},
		{name: "missing identity", payload: `{"password":"ValidPass#2026"}`, status: 401},
		{name: "malformed employee", payload: `{"identity":"Z3662' OR 1=1--","password":"ValidPass#2026"}`, status: 401},
		{name: "employee internal whitespace", payload: `{"identity":"Z 3662","password":"ValidPass#2026"}`, status: 401},
		{name: "malformed email", payload: `{"identity":"user@@zerodha.com","password":"ValidPass#2026"}`, status: 401},
		{name: "display name email", payload: `{"identity":"User <user@zerodha.com>","password":"ValidPass#2026"}`, status: 401},
		{name: "foreign email", payload: `{"identity":"user@external.example","password":"ValidPass#2026"}`, status: 401},
		{name: "invalid email does not fall back", payload: `{"email":"invalid","identity":"Z3662","password":"ValidPass#2026"}`, status: 401},
		{name: "employee in email field denied", payload: `{"email":"Z3662","password":"ValidPass#2026"}`, status: 401},
		{name: "missing password", payload: `{"identity":"Z3662"}`, status: 401},
		{name: "blank password", payload: `{"identity":"Z3662","password":""}`, status: 401},
		{name: "malformed JSON", payload: `{"identity":`, status: 400},
		{name: "nonstring identity", payload: `{"identity":123,"password":"ValidPass#2026"}`, status: 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			config := app.Config{FrontendOrigin: "http://localhost:5173", JWTSecret: "test-secret-with-sufficient-length-123", JWTTTL: time.Hour, GoogleHostedDomain: "zerodha.com"}
			router := NewRouter(db, config, nil)
			if test.argument != "" {
				predicate := `WHERE lower(u.email) = lower($1)`
				if test.employee {
					predicate = `WHERE upper(u.emp_id) = upper($1) AND (SELECT count(*) FROM users WHERE upper(emp_id) = upper($1)) = 1`
				}
				query := mock.ExpectQuery(regexp.QuoteMeta(predicate)).WithArgs(test.argument)
				if test.unknown {
					query.WillReturnError(sql.ErrNoRows)
				} else {
					email := test.email
					if email == "" {
						email = "user@zerodha.com"
					}
					query.WillReturnRows(loginIdentityRows(test.hash, !test.inactive, test.mfa, email))
				}
			}
			if test.status == http.StatusOK && !test.mfa {
				mock.ExpectExec(`INSERT INTO audit_log`).WithArgs("", "", "login", "user", "user-1", sqlmock.AnyArg(), "192.0.2.1", "password").WillReturnResult(sqlmock.NewResult(0, 1))
			}
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(test.payload))
			request.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(recorder, request)
			assertRouteResult(t, mock, recorder, test.status, test.name)
			if test.status == http.StatusUnauthorized {
				assertLoginRejectedWithoutSession(t, recorder)
			}
			if test.status == http.StatusOK {
				var body map[string]any
				if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if test.mfa {
					if body["mfaRequired"] != true || body["email"] != "user@zerodha.com" || body["token"] != nil || body["user"] != nil || len(recorder.Result().Cookies()) != 0 {
						t.Fatalf("MFA must not issue a session: %s", recorder.Body.String())
					}
				} else {
					token, _ := body["token"].(string)
					claims, err := authn.NewManager(config.JWTSecret, config.JWTTTL).ParseToken(token)
					if err != nil || claims.UserID != "user-1" || claims.Email != "user@zerodha.com" {
						t.Fatalf("expected resolved account token, got %s (error %v)", recorder.Body.String(), err)
					}
				}
			}
		})
	}
}

func TestRouterLoginIdentitySharesEmailAttemptLimit(t *testing.T) {
	hash, err := authn.HashPassword("ValidPass#2026")
	if err != nil {
		t.Fatal(err)
	}
	_, mock, _, router, cleanup := newRouterTestHarness(t)
	defer cleanup()
	// Fail through the employee alias, then verify email cannot bypass the lock.
	for attempt := 0; attempt < 11; attempt++ {
		payload := `{"identity":"z3662","password":"wrong"}`
		status := http.StatusUnauthorized
		if attempt < 10 {
			mock.ExpectQuery(`WHERE upper\(u\.emp_id\) = upper\(\$1\)`).WithArgs("z3662").
				WillReturnRows(loginIdentityRows(hash, true, false, "user@zerodha.com"))
		} else {
			payload = `{"email":"user@zerodha.com","password":"ValidPass#2026"}`
			status = http.StatusTooManyRequests
		}
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(payload))
		request.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(recorder, request)
		assertRouteResult(t, mock, recorder, status, "shared identity attempt limit")
	}
}
