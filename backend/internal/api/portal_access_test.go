package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"itms/backend/internal/platform/authn"
	"itms/backend/internal/platform/middleware"
)

func TestPortalSectionDefaultsAndValidation(t *testing.T) {
	if len(defaultPortalSections("employee")) != 3 || len(defaultPortalSections("auditor")) != 5 || len(defaultPortalSections("it_team")) != 5 || len(defaultPortalSections("unknown")) != 0 {
		t.Fatal("incorrect role defaults")
	}
	if _, err := normalizePortalSections([]string{"settings"}); err == nil {
		t.Fatal("unknown section accepted")
	}
	sections, err := normalizePortalSections([]string{"security", "devices", "devices"})
	if err != nil || len(sections) != 2 || sections[0] != "devices" {
		t.Fatal("sections not normalized")
	}
}

func TestPortalAccessGuard(t *testing.T) {
	for _, scenario := range []struct {
		name, role, method, path string
		stored                   any
		want                     int
	}{
		{"employee patch denied", "employee", "GET", "/api/patch/dashboard", nil, 403},
		{"employee devices allowed", "employee", "GET", "/api/devices", nil, 200},
		{"user override grants section", "employee", "GET", "/api/patch/dashboard", `{"sections":["patch"]}`, 200},
		{"staff override restricts section", "it_team", "GET", "/api/devices", `{"sections":[]}`, 403},
		{"auditor read", "auditor", "GET", "/api/gatepass", nil, 200},
		{"auditor websocket denied", "auditor", "GET", "/ws/ssh/assets/device-1", nil, 403},
		{"auditor write denied", "auditor", "POST", "/api/gatepass", nil, 403},
		{"auditor chat write denied", "auditor", "POST", "/api/chat/channels", nil, 403},
		{"invalid record denied", "employee", "GET", "/api/devices", `broken`, 503},
		{"v1 section denied", "employee", "GET", "/api/v1/patch/jobs", nil, 403},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			server.auth = authn.NewManager("portal-test-secret-with-sufficient-length", time.Hour)
			token := issueRouterTestToken(t, server.auth, scenario.role, "user-1", "entity-1")
			if scenario.role != "auditor" || scenario.method == "GET" {
				mock.ExpectQuery(regexp.QuoteMeta(portalAccessSQL)).WithArgs("user-1").WillReturnRows(sqlmock.NewRows([]string{"role", "active", "value"}).AddRow(scenario.role, true, scenario.stored))
			}
			router := gin.New()
			router.Use(middleware.AuthRequired(server.auth), server.portalAccessGuard)
			router.Handle(scenario.method, scenario.path, func(c *gin.Context) { c.Status(200) })
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, newAuthorizedRequest(scenario.method, scenario.path, token, ""))
			if recorder.Code != scenario.want {
				t.Fatalf("status %d, want %d: %s", recorder.Code, scenario.want, recorder.Body.String())
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestPortalGuardAnonymousDenied(t *testing.T) {
	server, _, cleanup := newTestServer(t)
	defer cleanup()
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/devices", nil)
	server.portalAccessGuard(ctx)
	if recorder.Code != 401 {
		t.Fatal("anonymous request allowed")
	}
}

func TestPortalAuditorScopedRequests(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "auditor", "user-1", "entity-1", http.MethodGet, "/api/requests", "")
	defer cleanup()
	createdAt := time.Now().UTC()
	expectRequestListSummaryQuery(mock, "entity-1", "user-1", 1, 1, 0, 0, 0, 0)
	expectRequestLoad(mock, `WHERE 1 = 1 AND (requester.entity_id = $1::uuid OR EXISTS (SELECT 1 FROM user_entity_access uea WHERE uea.user_id = $2::uuid AND uea.entity_id = requester.entity_id)) AND r.status <> 'rejected'`, []any{"entity-1", "user-1"}, "request-1", "support_chat", "Support", "Recorded request", "pending", "", createdAt, createdAt, "requester-1", "Requester", "assignee-1", "Assignee")
	expectRequestCommentBatchLookup(mock, "request-1", "comment-1", "Assignee", "Recorded comment", createdAt)
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusOK, "auditor scoped requests")
}

func TestPortalAuditorScopedGatepassAudit(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	context, recorder := newTestContext(http.MethodGet, "/audit?entity_type=gatepass", newTestClaims("auditor", "user-1", "entity-1"))
	mock.ExpectQuery(`(?s)FROM audit_log a.*a.entity_id = \$1::uuid.*uea.user_id = \$2::uuid`).WithArgs("entity-1", "user-1").WillReturnRows(sqlmock.NewRows([]string{"id", "full_name", "emp_id", "short_code", "action", "target_type", "target_id", "detail", "created_at"}))
	server.listAudit(context)
	assertRouteResult(t, mock, recorder, http.StatusOK, "auditor scoped gatepass audit")
}

func TestPortalAccessManagement(t *testing.T) {
	const targetID = "aaaaaaaa-0000-0000-0000-000000000001"
	for _, scenario := range []struct {
		name, actor, target, method, body string
		want                              int
		write, reset                      bool
	}{
		{"read defaults", "super_admin", "employee", "GET", "", 200, false, false},
		{"save sections", "super_admin", "employee", "PUT", `{"sections":["patch","devices","devices"]}`, 200, true, false},
		{"disable all", "super_admin", "it_team", "PUT", `{"sections":[]}`, 200, true, false},
		{"auditor stays read only", "super_admin", "auditor", "PUT", `{"sections":["patch"]}`, 200, true, false},
		{"restore defaults", "super_admin", "employee", "PUT", `{"useDefaults":true}`, 200, true, true},
		{"admin cannot configure", "admin", "employee", "PUT", `{"sections":[]}`, 403, false, false},
		{"employee cannot configure", "employee", "employee", "GET", "", 403, false, false},
		{"super admin cannot be restricted", "super_admin", "super_admin", "PUT", `{"sections":[]}`, 400, false, false},
		{"unknown section rejected", "super_admin", "employee", "PUT", `{"sections":["settings"]}`, 400, false, false},
		{"missing sections rejected", "super_admin", "employee", "PUT", `{}`, 400, false, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			server.auth = authn.NewManager("portal-test-secret-with-sufficient-length", time.Hour)
			token := issueRouterTestToken(t, server.auth, scenario.actor, "actor", "entity-1")
			mock.ExpectQuery(regexp.QuoteMeta(portalAccessSQL)).WithArgs("actor").WillReturnRows(sqlmock.NewRows([]string{"role", "active", "value"}).AddRow(scenario.actor, true, nil))
			if scenario.actor == "super_admin" {
				mock.ExpectQuery(regexp.QuoteMeta(portalAccessSQL)).WithArgs(targetID).WillReturnRows(sqlmock.NewRows([]string{"role", "active", "value"}).AddRow(scenario.target, true, nil))
			}
			if scenario.write {
				if scenario.reset {
					mock.ExpectExec("DELETE FROM settings").WithArgs("portal_access:" + targetID).WillReturnResult(sqlmock.NewResult(0, 1))
				} else {
					var input struct {
						Sections []string `json:"sections"`
					}
					_ = json.Unmarshal([]byte(scenario.body), &input)
					sections, _ := normalizePortalSections(input.Sections)
					payload, _ := json.Marshal(gin.H{"sections": sections})
					mock.ExpectExec("INSERT INTO settings").WithArgs("portal_access:"+targetID, string(payload)).WillReturnResult(sqlmock.NewResult(0, 1))
				}
			}
			router := gin.New()
			router.Use(middleware.AuthRequired(server.auth), server.portalAccessGuard)
			router.Handle(scenario.method, "/api/users/:id/portal-access", server.managePortalAccess)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, newAuthorizedRequest(scenario.method, "/api/users/AAAAAAAA-0000-0000-0000-000000000001/portal-access", token, scenario.body))
			if recorder.Code != scenario.want {
				t.Fatalf("status %d want %d: %s", recorder.Code, scenario.want, recorder.Body.String())
			}
			if scenario.want == 200 {
				var result portalAccess
				if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				if result.Role != scenario.target || result.ReadOnly != (scenario.target == "auditor") || result.Customized != (scenario.write && !scenario.reset) {
					t.Fatalf("unexpected access: %+v", result)
				}
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
