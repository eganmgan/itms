package api

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/lib/pq"

	"itms/backend/internal/platform/authn"
	"itms/backend/internal/platform/middleware"
)

const manualTestEntity = "11000000-0000-0000-0000-000000000001"
const manualTestUser = "11000000-0000-0000-0000-000000000002"
const manualTestDept = "11000000-0000-0000-0000-000000000003"
const manualTestLocation = "11000000-0000-0000-0000-000000000004"
const manualTestPassword = "ManualTest#2026"

func manualTestInput() map[string]any {
	return map[string]any{
		"full_name": "Jane Doe", "emp_id": "EMP-123", "email": "jane@example.com",
		"entity_id": manualTestEntity, "role": "employee", "initial_password": manualTestPassword,
	}
}

func manualTestJSON(t *testing.T, input any) string {
	t.Helper()
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func manualTestContext(t *testing.T, method string, input any) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(method, "/api/users", strings.NewReader(manualTestJSON(t, input)))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Set(middleware.ClaimsKey, newTestClaims("super_admin", manualTestUser, manualTestEntity))
	c.Params = gin.Params{{Key: "id", Value: manualTestUser}}
	return c, recorder
}

func expectManualEntity(mock sqlmock.Sqlmock, exists bool) {
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT EXISTS(SELECT 1 FROM entities WHERE id = $1::uuid)`)).
		WithArgs(manualTestEntity).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(exists))
}

func expectManualRole(mock sqlmock.Sqlmock, role string, exists bool) {
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT EXISTS(SELECT 1 FROM roles WHERE name = $1)`)).
		WithArgs(role).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(exists))
}

type manualPasswordHash struct{ value *string }

func (matcher manualPasswordHash) Match(value driver.Value) bool {
	hash, ok := value.(string)
	if !ok || hash == manualTestPassword || authn.CheckPassword(manualTestPassword, hash) != nil {
		return false
	}
	*matcher.value = hash
	return true
}

func expectManualInsert(mock sqlmock.Sqlmock, role string, hash *string) *sqlmock.ExpectedQuery {
	return mock.ExpectQuery("INSERT INTO users").WithArgs("EMP-123", "Jane Doe", "jane@example.com", manualTestEntity, "", "", manualPasswordHash{hash}, true, role)
}

func assertManualAudit(t *testing.T, c *gin.Context, action, hash string, passwordChanged bool) {
	t.Helper()
	value, ok := c.Get(middleware.AuditMetaKey)
	if !ok {
		t.Fatal("missing audit metadata")
	}
	meta := value.(middleware.AuditMeta)
	if meta.Action != action || meta.TargetID != manualTestUser {
		t.Fatal("incorrect audit action/target")
	}
	raw := manualTestJSON(t, meta.Detail)
	for _, secret := range []string{manualTestPassword, "initial_password", "password_hash", hash} {
		if secret != "" && strings.Contains(raw, secret) {
			t.Fatal("audit metadata contains a password or hash")
		}
	}
	var detail map[string]any
	if err := json.Unmarshal([]byte(raw), &detail); err != nil {
		t.Fatal(err)
	}
	key := "password_set"
	if action == "user_updated" {
		key = "password_reset"
	}
	if len(detail) != 9 || detail[key] != passwordChanged {
		t.Fatal("audit must contain only allowlisted fields and a boolean password marker")
	}
}

func TestManualUserCreateHashedAtomicAndSecretFree(t *testing.T) {
	for _, role := range []string{"employee", "admin", "it_team", "auditor", "super_admin", "custom_role"} {
		t.Run(role, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			input := manualTestInput()
			input["role"] = role
			input["full_name"], input["email"] = " Jane Doe ", " JANE@EXAMPLE.COM "
			c, rec := manualTestContext(t, http.MethodPost, input)
			expectManualEntity(mock, true)
			expectManualRole(mock, role, true)
			mock.ExpectBegin()
			var hash string
			expectManualInsert(mock, role, &hash).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(manualTestUser))
			mock.ExpectExec("INSERT INTO user_entity_access").WithArgs(manualTestUser, manualTestEntity).WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectCommit()
			server.createUser(c)
			assertRouteResult(t, mock, rec, http.StatusCreated, "manual user create")
			if rec.Body.String() != `{"id":"`+manualTestUser+`"}` {
				t.Fatal("unexpected create envelope")
			}
			assertManualAudit(t, c, "user_added", hash, true)
		})
	}
}

func TestManualUserUpdatePreservesSecretFreeAuditAndRoleManagement(t *testing.T) {
	for _, reset := range []bool{false, true} {
		t.Run(fmt.Sprint(reset), func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			input := map[string]any{"role": "super_admin"}
			if reset {
				input["initial_password"] = manualTestPassword
			}
			c, rec := manualTestContext(t, http.MethodPatch, input)
			c.Set(middleware.ClaimsKey, newTestClaims("admin", manualTestUser, manualTestEntity))
			mock.ExpectQuery("SELECT email, COALESCE").WithArgs(manualTestUser).
				WillReturnRows(sqlmock.NewRows([]string{"email", "entity", "dept", "location"}).AddRow("jane@example.com", manualTestEntity, manualTestDept, manualTestLocation))
			expectManualEntity(mock, true)
			mock.ExpectQuery("SELECT EXISTS\\(SELECT 1 FROM departments").WithArgs(manualTestDept, manualTestEntity).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
			mock.ExpectQuery("SELECT EXISTS\\(SELECT 1 FROM locations").WithArgs(manualTestLocation, manualTestEntity).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
			expectManualRole(mock, "super_admin", true)
			var hash string
			var passwordArg driver.Value = ""
			if reset {
				passwordArg = manualPasswordHash{&hash}
			}
			mock.ExpectExec("UPDATE users u").WithArgs(manualTestUser, "", "", "jane@example.com", manualTestEntity, manualTestDept, manualTestLocation, "super_admin", nil, passwordArg).WillReturnResult(sqlmock.NewResult(0, 1))
			server.updateUser(c)
			assertRouteResult(t, mock, rec, http.StatusOK, "manual user update")
			assertManualAudit(t, c, "user_updated", hash, reset)
		})
	}
}

func TestManualUserCreateRollsBackAndSanitizesErrors(t *testing.T) {
	for _, stage := range []string{"begin", "duplicate", "insert", "access", "commit"} {
		t.Run(stage, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			c, rec := manualTestContext(t, http.MethodPost, manualTestInput())
			expectManualEntity(mock, true)
			expectManualRole(mock, "employee", true)
			failure := errors.New("database detail " + manualTestPassword)
			begin := mock.ExpectBegin()
			var hash string
			status := http.StatusInternalServerError
			if stage == "begin" {
				begin.WillReturnError(failure)
			} else {
				insert := expectManualInsert(mock, "employee", &hash)
				switch stage {
				case "duplicate":
					insert.WillReturnError(&pq.Error{Code: "23505", Detail: manualTestPassword})
					status = http.StatusConflict
					mock.ExpectRollback()
				case "insert":
					insert.WillReturnError(failure)
					mock.ExpectRollback()
				default:
					insert.WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(manualTestUser))
					access := mock.ExpectExec("INSERT INTO user_entity_access").WithArgs(manualTestUser, manualTestEntity)
					if stage == "access" {
						access.WillReturnError(failure)
						mock.ExpectRollback()
					} else {
						access.WillReturnResult(sqlmock.NewResult(0, 1))
						mock.ExpectCommit().WillReturnError(failure)
					}
				}
			}
			server.createUser(c)
			assertRouteResult(t, mock, rec, status, "manual failure")
			if strings.Contains(rec.Body.String(), manualTestPassword) || (hash != "" && strings.Contains(rec.Body.String(), hash)) {
				t.Fatal("DB error leaked secret")
			}
			if _, exists := c.Get(middleware.AuditMetaKey); exists {
				t.Fatal("failed write tagged as successful audit")
			}
		})
	}
}

func TestManualUserInvalidInputDoesNotTouchDB(t *testing.T) {
	cases := []struct{ field, value string }{
		{"full_name", " "}, {"full_name", strings.Repeat("a", 101)}, {"full_name", "Jane\x00Doe"},
		{"emp_id", ""}, {"emp_id", "12345678901"}, {"emp_id", "EMP 1"},
		{"email", ""}, {"email", "not-an-email"}, {"email", "Jane <jane@example.com>"},
		{"email", strings.Repeat("a", 140) + "@example.com"}, {"email", "a@b@example.com"},
		{"entity_id", ""}, {"entity_id", "not-a-uuid"}, {"dept_id", "invalid"}, {"location_id", "invalid"},
		{"role", ""}, {"role", strings.Repeat("a", 61)}, {"role", "employee\nrole"},
		{"initial_password", ""}, {"initial_password", "weak"}, {"initial_password", " " + manualTestPassword},
		{"initial_password", strings.Repeat("A", 129)},
	}
	for _, tc := range cases {
		t.Run(tc.field+"/"+fmt.Sprint(len(tc.value))+tc.value[:min(5, len(tc.value))], func(t *testing.T) {
			input := manualTestInput()
			input[tc.field] = tc.value
			c, rec := manualTestContext(t, http.MethodPost, input)
			server := &apiServer{} // A DB call here panics instead of hiding an unexpected SQLmock call.
			server.createUser(c)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", rec.Code)
			}
		})
	}
	for _, input := range []any{map[string]any{"email": "invalid"}, map[string]any{"emp_id": "12345678901"}, map[string]any{"dept_id": "invalid"}} {
		c, rec := manualTestContext(t, http.MethodPatch, input)
		(&apiServer{}).updateUser(c)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("invalid PATCH status = %d", rec.Code)
		}
	}
	c, rec := manualTestContext(t, http.MethodPatch, map[string]any{})
	c.Params[0].Value = "invalid"
	(&apiServer{}).updateUser(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatal("invalid user ID accepted")
	}
}

func TestManualUserHostedDomainPreserved(t *testing.T) {
	c, rec := manualTestContext(t, http.MethodPost, manualTestInput())
	server := &apiServer{}
	server.config.GoogleHostedDomain = "company.example"
	server.createUser(c)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "domain") {
		t.Fatal("hosted-domain restriction not enforced before DB")
	}
}

func TestManualUserRejectsUnknownRoleAndCrossEntityLinks(t *testing.T) {
	for _, failure := range []string{"entity", "department", "location", "role", "database"} {
		t.Run(failure, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			input := manualTestInput()
			status := http.StatusBadRequest
			if failure == "database" {
				mock.ExpectQuery("SELECT EXISTS").WillReturnError(errors.New(manualTestPassword))
				status = http.StatusInternalServerError
			} else {
				expectManualEntity(mock, failure != "entity")
			}
			switch failure {
			case "department":
				input["dept_id"] = manualTestDept
				mock.ExpectQuery("SELECT EXISTS\\(SELECT 1 FROM departments").WithArgs(manualTestDept, manualTestEntity).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
			case "location":
				input["location_id"] = manualTestLocation
				mock.ExpectQuery("SELECT EXISTS\\(SELECT 1 FROM locations").WithArgs(manualTestLocation, manualTestEntity).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
			case "role":
				expectManualRole(mock, "employee", false)
			}
			c, rec := manualTestContext(t, http.MethodPost, input)
			server.createUser(c)
			assertRouteResult(t, mock, rec, status, "invalid manual link/role")
			if strings.Contains(rec.Body.String(), manualTestPassword) {
				t.Fatal("lookup error leaked DB details")
			}
		})
	}
}

func TestManualUserHonorsRequestDeadline(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	c, rec := manualTestContext(t, http.MethodPost, manualTestInput())
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Millisecond)
	defer cancel()
	c.Request = c.Request.WithContext(ctx)
	mock.ExpectQuery("SELECT EXISTS").WillDelayFor(time.Second).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	server.createUser(c)
	assertRouteResult(t, mock, rec, http.StatusInternalServerError, "request deadline")
}

type manualAuditJSON struct{ hash *string }

func (matcher manualAuditJSON) Match(value driver.Value) bool {
	raw, ok := value.(string)
	if !ok || strings.Contains(raw, manualTestPassword) || strings.Contains(raw, *matcher.hash) || strings.Contains(raw, "initial_password") || strings.Contains(raw, "password_hash") {
		return false
	}
	var data map[string]any
	return json.Unmarshal([]byte(raw), &data) == nil && len(data) == 9 && data["password_set"] == true
}

func TestManualUserRouterPersistsOnlySafeAuditMetadata(t *testing.T) {
	mock, rec, router, req, cleanup := newRoleRouteRequest(t, "super_admin", manualTestUser, manualTestEntity, http.MethodPost, "/api/users", manualTestJSON(t, manualTestInput()))
	defer cleanup()
	req.RemoteAddr = "192.0.2.210:1234"
	expectManualEntity(mock, true)
	expectManualRole(mock, "employee", true)
	mock.ExpectBegin()
	var hash string
	expectManualInsert(mock, "employee", &hash).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(manualTestUser))
	mock.ExpectExec("INSERT INTO user_entity_access").WithArgs(manualTestUser, manualTestEntity).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	mock.ExpectExec("INSERT INTO audit_log").WithArgs(manualTestUser, manualTestEntity, "user_added", "user", manualTestUser, manualAuditJSON{&hash}, sqlmock.AnyArg(), sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
	router.ServeHTTP(rec, req)
	assertRouteResult(t, mock, rec, http.StatusCreated, "safe persisted audit")
}

func TestManualCreationRouterRoleMatrix(t *testing.T) {
	index := 1
	for _, path := range []string{"users", "entities", "departments", "locations"} {
		for _, role := range []string{"admin", "it_team", "employee", "auditor", "super_admin", "anonymous"} {
			t.Run(path+"/"+role, func(t *testing.T) {
				mock, rec, router, req, cleanup := newRoleRouteRequest(t, role, manualTestUser, manualTestEntity, http.MethodPost, "/api/"+path, `{}`)
				defer cleanup()
				req.RemoteAddr = fmt.Sprintf("192.0.2.%d:1234", index)
				index++
				status := http.StatusForbidden
				if isAdminRole(role) {
					status = http.StatusBadRequest // Reached server-side validation, never a DB write.
				} else if role == "anonymous" {
					req.Header.Del("Authorization")
					status = http.StatusUnauthorized
				}
				router.ServeHTTP(rec, req)
				assertRouteResult(t, mock, rec, status, "manual create authorization")
			})
		}
	}
}

func TestManualMasterCreateValidationAndPersistence(t *testing.T) {
	for _, kind := range []string{"entity", "department", "location"} {
		for _, outcome := range []string{"success", "invalid", "duplicate", "database", "unknown_entity"} {
			if kind == "entity" && outcome == "unknown_entity" {
				continue
			}
			t.Run(kind+"/"+outcome, func(t *testing.T) {
				server, mock, cleanup := newTestServer(t)
				defer cleanup()
				input := map[string]any{"entity_id": manualTestEntity, "short_code": "ENG", "name": "Engineering", "full_name": " Main Office ", "location_code": " main ", "city": " London ", "state": " London ", "description": "First line\nSecond line"}
				status := http.StatusCreated
				if outcome == "invalid" {
					input["name"], input["full_name"] = " ", " "
					server.db = nil // Enforce zero DB calls.
					status = http.StatusBadRequest
				} else {
					if kind != "entity" {
						expectManualEntity(mock, outcome != "unknown_entity")
					}
					if outcome == "unknown_entity" {
						status = http.StatusBadRequest
					} else {
						var query *sqlmock.ExpectedQuery
						switch kind {
						case "entity":
							query = mock.ExpectQuery("INSERT INTO entities").WithArgs("ENG", "Main Office", true)
						case "department":
							query = mock.ExpectQuery("INSERT INTO departments").WithArgs(manualTestEntity, "Engineering", "eng", "First line\nSecond line")
						case "location":
							query = mock.ExpectQuery("INSERT INTO locations").WithArgs(manualTestEntity, "MAIN", "Main Office", "London", "London", true)
						}
						switch outcome {
						case "duplicate":
							query.WillReturnError(&pq.Error{Code: "23505", Detail: manualTestPassword})
							status = http.StatusConflict
						case "database":
							query.WillReturnError(errors.New(manualTestPassword))
							status = http.StatusInternalServerError
						default:
							query.WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(manualTestEntity))
						}
					}
				}
				c, rec := manualTestContext(t, http.MethodPost, input)
				switch kind {
				case "entity":
					server.createEntity(c)
				case "department":
					server.createDepartment(c)
				case "location":
					server.createLocation(c)
				}
				assertRouteResult(t, mock, rec, status, "manual master create")
				if strings.Contains(rec.Body.String(), manualTestPassword) {
					t.Fatal("master DB error leaked details")
				}
			})
		}
	}
}

func TestManualMasterInvalidFieldsDoNotTouchDB(t *testing.T) {
	cases := []struct {
		kind, field, value string
	}{
		{"entity", "short_code", ""}, {"entity", "short_code", "12345678901"},
		{"entity", "short_code", "bad code"}, {"entity", "full_name", strings.Repeat("a", 151)},
		{"entity", "full_name", "Bad\x00Name"},
		{"department", "entity_id", "bad"}, {"department", "entity_id", ""},
		{"department", "name", strings.Repeat("a", 101)}, {"department", "name", "Bad\nName"},
		{"department", "short_code", strings.Repeat("a", 21)}, {"department", "short_code", "bad code"},
		{"department", "description", strings.Repeat("a", 4001)},
		{"location", "entity_id", "bad"}, {"location", "entity_id", ""},
		{"location", "location_code", ""}, {"location", "location_code", strings.Repeat("a", 31)},
		{"location", "full_name", strings.Repeat("a", 151)},
		{"location", "city", strings.Repeat("a", 81)}, {"location", "state", strings.Repeat("a", 81)},
	}
	for index, tc := range cases {
		t.Run(fmt.Sprintf("%s/%s/%d", tc.kind, tc.field, index), func(t *testing.T) {
			input := map[string]any{"entity_id": manualTestEntity, "short_code": "eng", "name": "Engineering", "full_name": "Main Office", "location_code": "main"}
			input[tc.field] = tc.value
			c, rec := manualTestContext(t, http.MethodPost, input)
			server := &apiServer{}
			switch tc.kind {
			case "entity":
				server.createEntity(c)
			case "department":
				server.createDepartment(c)
			case "location":
				server.createLocation(c)
			}
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", rec.Code)
			}
		})
	}
}

func TestManualUserMalformedAndOversizedPayloadsDoNotTouchDB(t *testing.T) {
	for _, body := range []string{`{`, `{"full_name":123}`, `{"is_active":"yes"}`, `{"full_name":"` + strings.Repeat("a", 16385) + `"}`} {
		c, rec := manualTestContext(t, http.MethodPost, nil)
		c.Request = httptest.NewRequest(http.MethodPost, "/api/users", strings.NewReader(body))
		c.Request.Header.Set("Content-Type", "application/json")
		(&apiServer{}).createUser(c)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	}
}
