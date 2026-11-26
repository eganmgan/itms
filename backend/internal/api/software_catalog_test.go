package api

import (
	"database/sql"
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
	"itms/backend/internal/integrations/saltstack"
	"itms/backend/internal/platform/authn"
	"itms/backend/internal/platform/middleware"
)

const softwareTestApplication = "50000000-0000-0000-0000-000000000005"
const softwareTestRequest = "60000000-0000-0000-0000-000000000006"
const softwareTestBody = `{"applicationId":"` + softwareTestApplication + `","confirmed":true,"requestId":"` + softwareTestRequest + `","approvalId":"` + adminTestOther + `"}`
const softwareTestCreate = `{"entityId":"` + adminTestEntity + `","name":"Firefox","os":"linux","packageName":"firefox"}`

func softwareApplicationRows(active bool, os string) *sqlmock.Rows {
	return sqlmock.NewRows([]string{"id", "entity_id", "name", "description", "os", "package_name", "active", "updated_at"}).
		AddRow(softwareTestApplication, adminTestEntity, "Firefox", "", os, "firefox", active, time.Now().UTC())
}

func softwareRequestRows(status, code, actor, asset, application string) *sqlmock.Rows {
	return sqlmock.NewRows(strings.Split(strings.ReplaceAll(softwareInstallColumns, "::text", ""), ", ")).
		AddRow(softwareTestRequest, asset, application, "Firefox", "firefox", "linux", status, code, time.Now().UTC(), time.Now().UTC(), actor, adminTestEntity)
}

func softwareEmptyRequests() *sqlmock.Rows {
	return sqlmock.NewRows(strings.Split(softwareInstallColumns, ", "))
}

func softwareHandlerHarness(t *testing.T, role string, client *saltstack.Client) (sqlmock.Sqlmock, http.Handler) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	server := &apiServer{db: db, salt: client}
	router := gin.New()
	group := router.Group("/api", func(c *gin.Context) {
		c.Set(middleware.ClaimsKey, &authn.Claims{UserID: adminTestUser, EntityID: adminTestEntity, Role: role})
		c.Next()
	})
	server.registerSoftwareRoutes(group)
	return mock, router
}

func softwareServe(router http.Handler, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	return rec
}

func expectSoftwareAsset(mock sqlmock.Sqlmock, role, target, os string, compute bool) {
	scope := "TRUE"
	if !isAdminRole(role) {
		scope = "(a.entity_id = NULLIF($2, '')::uuid OR EXISTS (SELECT 1 FROM user_entity_access uea WHERE uea.user_id = $3::uuid AND uea.entity_id = a.entity_id))"
	}
	expected := mock.ExpectQuery(regexp.QuoteMeta(`SELECT a.entity_id::text, COALESCE(a.salt_minion_id, ''), a.is_compute, COALESCE(d.os_name, '') FROM assets a LEFT JOIN asset_compute_details d ON d.asset_id=a.id WHERE a.id=$1::uuid AND ` + scope + ` FOR SHARE OF a`))
	if isAdminRole(role) {
		expected.WithArgs(adminTestAsset)
	} else {
		expected.WithArgs(adminTestAsset, adminTestEntity, adminTestUser)
	}
	expected.WillReturnRows(sqlmock.NewRows([]string{"entity_id", "salt_minion_id", "is_compute", "os_name"}).AddRow(adminTestEntity, target, compute, os))
}

func expectSoftwarePrevious(mock sqlmock.Sqlmock, rows *sqlmock.Rows) {
	mock.ExpectQuery(`SELECT .* FROM software_install_requests WHERE request_id=\$1::uuid`).WithArgs(softwareTestRequest).WillReturnRows(rows)
}

func expectSoftwareEvents(mock sqlmock.Sqlmock, action string) {
	mock.ExpectExec(`INSERT INTO asset_history`).WithArgs(adminTestAsset, adminTestUser, action, sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO audit_log`).WithArgs(adminTestUser, adminTestEntity, action, adminTestAsset, sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
}

func TestSoftwareRouteRoleMatrix(t *testing.T) {
	for _, role := range []string{"", "employee", "auditor", "admin", "it_team", "super_admin", "Admin", "SUPER_ADMIN", "operator"} {
		for _, route := range []struct{ method, path string }{
			{"GET", "/api/software/permissions"}, {"GET", "/api/software/catalog"}, {"POST", "/api/software/catalog"},
			{"PATCH", "/api/software/catalog/" + softwareTestApplication}, {"POST", "/api/assets/" + adminTestAsset + "/software-install"},
			{"GET", "/api/assets/invalid/software-installs"},
		} {
			t.Run(role+route.method+route.path, func(t *testing.T) {
				mock, rec, router, req, cleanup := adminRoute(t, role, route.method, route.path, `{}`)
				defer cleanup()
				reader := role == "admin" || role == "it_team" || isAdminRole(role) || role == "auditor"
				allowed := false
				want := http.StatusForbidden
				switch {
				case strings.HasSuffix(route.path, "/permissions") || strings.HasSuffix(route.path, "/software-installs"):
					allowed = reader || role == "employee"
				case route.method == "GET":
					allowed = reader
				case strings.HasSuffix(route.path, "/software-install"):
					allowed = isAdminRole(role) || role == "it_team"
				default:
					allowed = isAdminRole(role)
				}
				if role == "" {
					want = http.StatusUnauthorized
				} else if allowed {
					want = http.StatusBadRequest
					if strings.HasSuffix(route.path, "/permissions") {
						want = http.StatusOK
					}
					if route.method == "GET" && route.path == "/api/software/catalog" {
						want = http.StatusOK
						mock.ExpectQuery(`SELECT .* FROM application_catalog x WHERE .*LIMIT 51 OFFSET`).WillReturnRows(sqlmock.NewRows([]string{"id"}))
					}
				}
				router.ServeHTTP(rec, req)
				assertRouteResult(t, mock, rec, want, "software role boundary")
				if allowed && strings.HasSuffix(route.path, "/permissions") {
					var caps softwareCapabilities
					if err := json.Unmarshal(rec.Body.Bytes(), &caps); err != nil {
						t.Fatal(err)
					}
					if caps.CanManageCatalog != (isAdminRole(role)) || caps.CanInstall != (isAdminRole(role) || role == "it_team") {
						t.Fatalf("caps=%+v", caps)
					}
				}
			})
		}
	}
}

func TestSoftwareStrictInput(t *testing.T) {
	for _, body := range []string{`{}`, `null`, `[]`, `{"Name":"a"}`, `{"name":"a","name":"b"}`, `{"active":null}`, `{"active":"true"}`, `{"name":4}`, `{"name":""}`, `{"os":"Linux"}`, `{"entityId":"bad"}`, `{"packageName":"--help"}`, `{"packageName":"a;id"}`, `{"body":"echo hi"}`, `{"script":"install"}`, `{"name":"a"} {}`, `{"name":"\u0000"}`, `{"description":"` + strings.Repeat("x", 4001) + `"}`, string([]byte{'{', '"', 'n', 'a', 'm', 'e', '"', ':', '"', 255, '"', '}'}), strings.Repeat(" ", 16385)} {
		t.Run(fmt.Sprintf("catalog/%d", len(body))+body[:min(len(body), 30)], func(t *testing.T) {
			if _, err := decodeSoftwareInput(strings.NewReader(body), false); err == nil {
				t.Fatal("accepted invalid payload")
			}
		})
	}
	for _, body := range []string{`{}`, `{"applicationId":"` + softwareTestApplication + `","requestId":"` + softwareTestRequest + `","confirmed":false}`, strings.Replace(softwareTestBody, `"confirmed":true`, `"Confirmed":true`, 1), strings.Replace(softwareTestBody, softwareTestRequest, "00000000-0000-0000-0000-000000000000", 1), strings.TrimSuffix(softwareTestBody, "}") + `,"command":"id"}`} {
		if _, err := decodeSoftwareInput(strings.NewReader(body), true); err == nil {
			t.Errorf("accepted %s", body)
		}
	}
	if _, err := decodeSoftwareInput(strings.NewReader(softwareTestBody), true); err != nil {
		t.Fatal(err)
	}
	if _, err := decodeSoftwareInput(strings.NewReader(softwareTestCreate), false); err != nil {
		t.Fatal(err)
	}
}

func TestSoftwareCatalogCreateAndSparsePatch(t *testing.T) {
	for _, create := range []bool{true, false} {
		t.Run(fmt.Sprint(create), func(t *testing.T) {
			mock, router := softwareHandlerHarness(t, "super_admin", nil)
			mock.ExpectBegin()
			if create {
				expectAdminEntity(mock, true)
				mock.ExpectQuery(`INSERT INTO application_catalog`).WithArgs(adminTestEntity, "Firefox", "", "linux", "firefox", true, adminTestUser).WillReturnRows(softwareApplicationRows(true, "linux"))
			} else {
				mock.ExpectQuery(`SELECT .* FROM application_catalog WHERE id = \$1::uuid FOR UPDATE`).WithArgs(softwareTestApplication).WillReturnRows(softwareApplicationRows(true, "linux"))
				mock.ExpectQuery(`UPDATE application_catalog SET`).WithArgs(softwareTestApplication, "Firefox", "", "linux", "firefox", false).WillReturnRows(softwareApplicationRows(false, "linux"))
			}
			mock.ExpectCommit()
			method, path, body, want := "PATCH", "/api/software/catalog/"+softwareTestApplication, `{"active":false}`, http.StatusOK
			if create {
				method, path, body, want = "POST", "/api/software/catalog", softwareTestCreate, http.StatusCreated
			}
			rec := softwareServe(router, method, path, body)
			assertRouteResult(t, mock, rec, want, "catalog write without Salt")
			if strings.Contains(rec.Body.String(), `"script"`) {
				t.Fatal("unexpected script content")
			}
		})
	}
}

func TestSoftwareCatalogScopedRead(t *testing.T) {
	for _, role := range []string{"admin", "it_team", "auditor"} {
		t.Run(role, func(t *testing.T) {
			mock, router := softwareHandlerHarness(t, role, nil)
			query := `SELECT ` + softwareCatalogColumns + ` FROM application_catalog x WHERE (x.entity_id = NULLIF($1, '')::uuid OR EXISTS (SELECT 1 FROM user_entity_access uea WHERE uea.user_id = $2::uuid AND uea.entity_id = x.entity_id)) AND x.entity_id = $3 AND x.os = $4 AND x.active = $5 ORDER BY name, id LIMIT 51 OFFSET $6`
			if role == "admin" {
				query = `SELECT ` + softwareCatalogColumns + ` FROM application_catalog x WHERE TRUE AND x.entity_id = $1 AND x.os = $2 AND x.active = $3 ORDER BY name, id LIMIT 51 OFFSET $4`
				mock.ExpectQuery(regexp.QuoteMeta(query)).WithArgs(adminTestOther, "linux", "true", 0).WillReturnRows(sqlmock.NewRows([]string{"id"}))
			} else {
				mock.ExpectQuery(regexp.QuoteMeta(query)).WithArgs(adminTestEntity, adminTestUser, adminTestOther, "linux", "true", 0).WillReturnRows(sqlmock.NewRows([]string{"id"}))
			}
			rec := softwareServe(router, "GET", "/api/software/catalog?entityId="+adminTestOther+"&os=linux&active=true", "")
			assertRouteResult(t, mock, rec, 200, "scoped empty catalog")
			if !strings.Contains(rec.Body.String(), `"items":[]`) {
				t.Fatal(rec.Body.String())
			}
		})
	}
}

func TestSoftwareInstallPreflightGuards(t *testing.T) {
	cases := []struct {
		name, target, os, catalogOS string
		compute, active             bool
		want                        int
	}{
		{"no target", "", "Ubuntu", "linux", true, true, 400}, {"wildcard", "*", "Ubuntu", "linux", true, true, 400},
		{"compound", "G@os:Linux", "Ubuntu", "linux", true, true, 400}, {"not compute", "host-1", "Ubuntu", "linux", false, true, 400},
		{"inactive", "host-1", "Ubuntu", "linux", true, false, 409}, {"wrong os", "host-1", "Windows 11", "linux", true, true, 409},
		{"unknown os", "host-1", "Plan9", "linux", true, true, 409}, {"unconfigured", "host-1", "Ubuntu", "linux", true, true, 503},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mock, router := softwareHandlerHarness(t, "it_team", nil)
			mock.ExpectBegin()
			expectSoftwareAsset(mock, "it_team", tc.target, tc.os, tc.compute)
			expectSoftwarePrevious(mock, softwareEmptyRequests())
			if tc.compute && saltstack.ValidExactMinion(tc.target) {
				mock.ExpectQuery(`SELECT .* FROM application_catalog WHERE id=\$1::uuid AND entity_id=\$2::uuid FOR SHARE`).WithArgs(softwareTestApplication, adminTestEntity).WillReturnRows(softwareApplicationRows(tc.active, tc.catalogOS))
			}
			mock.ExpectRollback()
			rec := softwareServe(router, "POST", "/api/assets/"+adminTestAsset+"/software-install", softwareTestBody)
			assertRouteResult(t, mock, rec, tc.want, "preflight guard")
		})
	}
}

func TestSoftwareInstallScopeAndEntityMismatch(t *testing.T) {
	for _, kind := range []string{"asset outside scope", "catalog other entity", "database error"} {
		t.Run(kind, func(t *testing.T) {
			mock, router := softwareHandlerHarness(t, "it_team", nil)
			mock.ExpectBegin()
			want := 404
			if kind == "catalog other entity" {
				expectSoftwareAsset(mock, "it_team", "host-1", "Ubuntu", true)
				expectSoftwarePrevious(mock, softwareEmptyRequests())
				mock.ExpectQuery(`SELECT .* FROM application_catalog WHERE id=\$1::uuid AND entity_id=\$2::uuid FOR SHARE`).WithArgs(softwareTestApplication, adminTestEntity).WillReturnError(sql.ErrNoRows)
			} else {
				err := sql.ErrNoRows
				if kind == "database error" {
					err = errors.New("secret connection infrastructure")
					want = 500
				}
				mock.ExpectQuery(`FROM assets a .*user_entity_access.*FOR SHARE OF a`).WithArgs(adminTestAsset, adminTestEntity, adminTestUser).WillReturnError(err)
			}
			mock.ExpectRollback()
			rec := softwareServe(router, "POST", "/api/assets/"+adminTestAsset+"/software-install", softwareTestBody)
			assertRouteResult(t, mock, rec, want, "scope denied")
			if strings.Contains(rec.Body.String(), "secret") {
				t.Fatal("leaked DB error")
			}
		})
	}
}

func TestSoftwareInstallReplayAndConflict(t *testing.T) {
	for _, kind := range []string{"succeeded", "failed", "unknown", "different actor", "different asset", "different application"} {
		t.Run(kind, func(t *testing.T) {
			mock, router := softwareHandlerHarness(t, "it_team", nil)
			mock.ExpectBegin()
			expectSoftwareAsset(mock, "it_team", "", "Unknown", true)
			status, actor, asset, app, want := kind, adminTestUser, adminTestAsset, softwareTestApplication, 200
			switch kind {
			case "unknown":
				want = 202
			case "different actor":
				actor = adminTestOther
				want = 409
			case "different asset":
				asset = adminTestOther
				want = 409
			case "different application":
				app = adminTestOther
				want = 409
			}
			expectSoftwarePrevious(mock, softwareRequestRows(status, "dispatch_unconfirmed", actor, asset, app))
			mock.ExpectRollback()
			rec := softwareServe(router, "POST", "/api/assets/"+adminTestAsset+"/software-install", softwareTestBody)
			assertRouteResult(t, mock, rec, want, "durable replay")
			if want != 409 && !strings.Contains(rec.Body.String(), `"replayed":true`) {
				t.Fatal(rec.Body.String())
			}
		})
	}
}

func TestSoftwareInstallDispatchAndPersistence(t *testing.T) {
	cases := []struct {
		name, reply, status, code string
		httpStatus                int
	}{
		{"success", `{"return":[{"host-1":{"firefox":{"old":"","new":"1"}}}]}`, "succeeded", "package_changed", 200},
		{"already present", `{"return":[{"host-1":{}}]}`, "succeeded", "already_present", 200},
		{"failed", `{"return":[{"host-1":"ERROR: private password path"}]}`, "failed", "provider_failed", 200},
		{"unknown", `{"return":[{}]}`, "unknown", "response_unavailable", 202},
		{"reservation failed", "", "", "", 500}, {"audit failed", "", "", "", 500}, {"commit ambiguous", "", "", "", 202},
		{"finish failed", `{"return":[{"host-1":{}}]}`, "succeeded", "already_present", 202},
		{"concurrent loser", "", "unknown", "dispatch_unconfirmed", 202},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				var payload struct {
					Function string `json:"fun"`
				}
				_ = json.NewDecoder(r.Body).Decode(&payload)
				if payload.Function == "pkg.version" {
					_, _ = w.Write([]byte(`{"return":[{"host-1":"1"}]}`))
					return
				}
				_, _ = w.Write([]byte(tc.reply))
			}))
			defer remote.Close()
			mock, router := softwareHandlerHarness(t, "it_team", saltstack.NewClient(remote.URL, "test-token", "", "", "", "glob"))
			mock.ExpectBegin()
			expectSoftwareAsset(mock, "it_team", "host-1", "Ubuntu 24.04", true)
			expectSoftwarePrevious(mock, softwareEmptyRequests())
			mock.ExpectQuery(`SELECT .* FROM application_catalog WHERE id=\$1::uuid AND entity_id=\$2::uuid FOR SHARE`).WithArgs(softwareTestApplication, adminTestEntity).WillReturnRows(softwareApplicationRows(true, "linux"))
			insert := mock.ExpectQuery(`INSERT INTO software_install_requests .*ON CONFLICT \(request_id\) DO NOTHING RETURNING`).WithArgs(softwareTestRequest, adminTestAsset, softwareTestApplication, adminTestEntity, adminTestUser, "Firefox", "firefox", "linux")
			wantCalls := 1
			if tc.name == "already present" || tc.name == "finish failed" {
				wantCalls = 2
			}
			switch tc.name {
			case "reservation failed":
				insert.WillReturnError(errors.New("secret database"))
				mock.ExpectRollback()
				wantCalls = 0
			case "concurrent loser":
				insert.WillReturnRows(softwareEmptyRequests())
				expectSoftwarePrevious(mock, softwareRequestRows("unknown", "dispatch_unconfirmed", adminTestUser, adminTestAsset, softwareTestApplication))
				mock.ExpectRollback()
				wantCalls = 0
			default:
				insert.WillReturnRows(softwareRequestRows("unknown", "dispatch_unconfirmed", adminTestUser, adminTestAsset, softwareTestApplication))
				expectApprovalConsumption(mock, "install")
				if tc.name == "audit failed" {
					mock.ExpectExec(`INSERT INTO asset_history`).WillReturnError(errors.New("history unavailable"))
					mock.ExpectRollback()
					wantCalls = 0
				} else {
					expectSoftwareEvents(mock, "software_install_requested")
					if tc.name == "commit ambiguous" {
						mock.ExpectCommit().WillReturnError(errors.New("commit unavailable"))
						wantCalls = 0
					} else {
						mock.ExpectCommit()
						if tc.name == "finish failed" {
							mock.ExpectBegin().WillReturnError(errors.New("secret db"))
						} else {
							mock.ExpectBegin()
							mock.ExpectQuery(`UPDATE software_install_requests SET status=\$2, outcome_code=\$3`).WithArgs(softwareTestRequest, tc.status, tc.code).WillReturnRows(softwareRequestRows(tc.status, tc.code, adminTestUser, adminTestAsset, softwareTestApplication))
							expectSoftwareEvents(mock, "software_install_outcome")
							mock.ExpectCommit()
						}
					}
				}
			}
			rec := softwareServe(router, "POST", "/api/assets/"+adminTestAsset+"/software-install", softwareTestBody)
			assertRouteResult(t, mock, rec, tc.httpStatus, "install dispatch")
			if calls != wantCalls {
				t.Fatalf("calls=%d want=%d", calls, wantCalls)
			}
			if strings.Contains(rec.Body.String(), "private") || strings.Contains(rec.Body.String(), "secret") || strings.Contains(rec.Body.String(), "host-1") {
				t.Fatal("unsafe response")
			}
			if (tc.name == "finish failed" || tc.name == "commit ambiguous") && (!strings.Contains(rec.Body.String(), `"status":"unknown"`) || !strings.Contains(rec.Body.String(), `"outcomePersistenceUnconfirmed":true`)) {
				t.Fatal(rec.Body.String())
			}
			if tc.status == "succeeded" && tc.name != "finish failed" && !strings.Contains(rec.Body.String(), `"inventoryRefreshRequired":true`) {
				t.Fatal(rec.Body.String())
			}
		})
	}
}

func TestSoftwareInstallHistoryScope(t *testing.T) {
	for _, tc := range []struct {
		role               string
		delegated, allowed bool
	}{{"super_admin", false, true}, {"admin", false, true}, {"it_team", true, true}, {"auditor", true, false}, {"employee", false, true}, {"employee", false, false}} {
		t.Run(fmt.Sprintf("%s/%t/%t", tc.role, tc.delegated, tc.allowed), func(t *testing.T) {
			mock, router := softwareHandlerHarness(t, tc.role, nil)
			entity := adminTestEntity
			if tc.delegated {
				entity = adminTestOther
			}
			// Existing asset loader and device reader scope are intentionally reused.
			columns := []string{"id", "asset_tag", "name", "hostname", "category", "is_compute", "serial_number", "manufacturer", "model", "entity_id", "assigned_to", "dept_id", "location_id", "purchase_date", "cost", "warranty_until", "maintenance_until", "status", "condition", "glpi_id", "salt_minion_id", "wazuh_agent_id", "notes"}
			assigned := ""
			if tc.role == "employee" && tc.allowed {
				assigned = adminTestUser
			}
			mock.ExpectQuery(`FROM assets WHERE id = \$1::uuid`).WithArgs(adminTestAsset).WillReturnRows(sqlmock.NewRows(columns).AddRow(adminTestAsset, "PC-1", "Computer", "host-1", "desktop", true, "", "", "", entity, assigned, "", "", "", "", "", "", "active", "good", 0, "host-1", "", ""))
			if tc.delegated {
				expectEntityAccessCheck(mock, adminTestUser, entity, tc.allowed)
			}
			want := 404
			if tc.allowed {
				want = 200
				mock.ExpectQuery(`FROM software_install_requests WHERE asset_id=\$1::uuid AND entity_id=\$2::uuid`).WithArgs(adminTestAsset, entity, softwareTestRequest).WillReturnRows(softwareRequestRows("succeeded", "package_changed", adminTestUser, adminTestAsset, softwareTestApplication))
			}
			rec := softwareServe(router, "GET", "/api/assets/"+adminTestAsset+"/software-installs?requestId="+softwareTestRequest, "")
			assertRouteResult(t, mock, rec, want, "scoped history")
			if strings.Contains(rec.Body.String(), `"actorId"`) || strings.Contains(rec.Body.String(), "host-1") {
				t.Fatal("internal fields exposed")
			}
		})
	}
}

func TestSoftwareInstallHistoryRejectsAmbiguousRequestFilter(t *testing.T) {
	for _, query := range []string{"?requestId=", "?requestId=bad", "?requestId=00000000-0000-0000-0000-000000000000", "?requestId=" + softwareTestRequest + "&requestId=" + softwareTestRequest} {
		mock, router := softwareHandlerHarness(t, "auditor", nil)
		rec := softwareServe(router, "GET", "/api/assets/"+adminTestAsset+"/software-installs"+query, "")
		assertRouteResult(t, mock, rec, 400, "invalid request filter must not query")
	}
}

func TestSoftwareOSFamilies(t *testing.T) {
	for name, want := range map[string]string{"Ubuntu 24.04": "linux", "Debian GNU/Linux": "linux", "Rocky Linux 9": "linux", "Windows 11": "windows", "Microsoft Windows 10": "windows", "macOS 15": "macos", "Darwin": "macos", "FreeBSD": "", "": "", "not windows": ""} {
		if got := softwareOS(name); got != want {
			t.Errorf("%q=%q want %q", name, got, want)
		}
	}
}

func TestSoftwareMacOSRequiresProvider(t *testing.T) {
	for _, available := range []bool{false, true} {
		t.Run(fmt.Sprint(available), func(t *testing.T) {
			calls := []string{}
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var payload map[string]any
				_ = json.NewDecoder(r.Body).Decode(&payload)
				function, _ := payload["fun"].(string)
				calls = append(calls, function)
				if function == "sys.list_functions" {
					if available {
						_, _ = w.Write([]byte(`{"return":[{"mac-1":["pkg.install"]}]}`))
					} else {
						_, _ = w.Write([]byte(`{"return":[{"mac-1":[]}]}`))
					}
				} else if function == "pkg.version" {
					_, _ = w.Write([]byte(`{"return":[{"mac-1":"1"}]}`))
				} else {
					if !available {
						t.Error("install called without provider")
					}
					_, _ = w.Write([]byte(`{"return":[{"mac-1":{}}]}`))
				}
			}))
			defer remote.Close()
			mock, router := softwareHandlerHarness(t, "super_admin", saltstack.NewClient(remote.URL, "test-token", "", "", "", "glob"))
			mock.ExpectBegin()
			expectSoftwareAsset(mock, "super_admin", "mac-1", "macOS 15", true)
			expectSoftwarePrevious(mock, softwareEmptyRequests())
			mock.ExpectQuery(`SELECT .* FROM application_catalog WHERE id=\$1::uuid AND entity_id=\$2::uuid FOR SHARE`).WithArgs(softwareTestApplication, adminTestEntity).WillReturnRows(softwareApplicationRows(true, "macos"))
			mock.ExpectQuery(`INSERT INTO software_install_requests`).WithArgs(softwareTestRequest, adminTestAsset, softwareTestApplication, adminTestEntity, adminTestUser, "Firefox", "firefox", "macos").WillReturnRows(softwareRequestRows("unknown", "dispatch_unconfirmed", adminTestUser, adminTestAsset, softwareTestApplication))
			expectApprovalConsumption(mock, "install")
			expectSoftwareEvents(mock, "software_install_requested")
			mock.ExpectCommit()
			status, code := "failed", "provider_unavailable"
			if available {
				status, code = "succeeded", "already_present"
			}
			mock.ExpectBegin()
			mock.ExpectQuery(`UPDATE software_install_requests SET`).WithArgs(softwareTestRequest, status, code).WillReturnRows(softwareRequestRows(status, code, adminTestUser, adminTestAsset, softwareTestApplication))
			expectSoftwareEvents(mock, "software_install_outcome")
			mock.ExpectCommit()
			rec := softwareServe(router, "POST", "/api/assets/"+adminTestAsset+"/software-install", softwareTestBody)
			assertRouteResult(t, mock, rec, 200, "macOS provider gate")
			wantCalls := 1
			if available {
				wantCalls = 3
			}
			if len(calls) != wantCalls || calls[0] != "sys.list_functions" || (available && calls[1] != "pkg.install") {
				t.Fatalf("calls=%v", calls)
			}
		})
	}
}

func TestSoftwareInstallDelegatedEntity(t *testing.T) {
	mock, router := softwareHandlerHarness(t, "it_team", nil)
	mock.ExpectBegin()
	mock.ExpectQuery(`FROM assets a .*user_entity_access.*FOR SHARE OF a`).WithArgs(adminTestAsset, adminTestEntity, adminTestUser).
		WillReturnRows(sqlmock.NewRows([]string{"entity_id", "salt_minion_id", "is_compute", "os_name"}).AddRow(adminTestOther, "host-1", true, "Windows 11"))
	expectSoftwarePrevious(mock, softwareEmptyRequests())
	mock.ExpectQuery(`SELECT .* FROM application_catalog WHERE id=\$1::uuid AND entity_id=\$2::uuid FOR SHARE`).WithArgs(softwareTestApplication, adminTestOther).
		WillReturnRows(sqlmock.NewRows([]string{"id", "entity_id", "name", "description", "os", "package_name", "active", "updated_at"}).AddRow(softwareTestApplication, adminTestOther, "Firefox", "", "windows", "firefox", true, time.Now().UTC()))
	mock.ExpectRollback()
	rec := softwareServe(router, "POST", "/api/assets/"+adminTestAsset+"/software-install", softwareTestBody)
	assertRouteResult(t, mock, rec, 503, "delegation accepted; provider unavailable")
}

func TestSoftwareCatalogWriteValidationAndAudit(t *testing.T) {
	t.Run("immutable entity", func(t *testing.T) {
		mock, router := softwareHandlerHarness(t, "super_admin", nil)
		rec := softwareServe(router, "PATCH", "/api/software/catalog/"+softwareTestApplication, `{"entityId":"`+adminTestOther+`"}`)
		assertRouteResult(t, mock, rec, 400, "immutable catalog entity")
	})
	t.Run("missing entity", func(t *testing.T) {
		mock, router := softwareHandlerHarness(t, "super_admin", nil)
		mock.ExpectBegin()
		expectAdminEntity(mock, false)
		mock.ExpectRollback()
		rec := softwareServe(router, "POST", "/api/software/catalog", softwareTestCreate)
		assertRouteResult(t, mock, rec, 400, "invalid entity")
	})
	t.Run("database failure", func(t *testing.T) {
		mock, router := softwareHandlerHarness(t, "super_admin", nil)
		mock.ExpectBegin().WillReturnError(errors.New("postgres://private-secret"))
		rec := softwareServe(router, "POST", "/api/software/catalog", softwareTestCreate)
		assertRouteResult(t, mock, rec, 500, "generic database error")
		if strings.Contains(rec.Body.String(), "private-secret") {
			t.Fatal("secret exposed")
		}
	})
	t.Run("router audit", func(t *testing.T) {
		mock, rec, router, req, cleanup := adminRoute(t, "super_admin", "POST", "/api/software/catalog", softwareTestCreate)
		defer cleanup()
		mock.ExpectBegin()
		expectAdminEntity(mock, true)
		mock.ExpectQuery(`INSERT INTO application_catalog`).WillReturnRows(softwareApplicationRows(true, "linux"))
		mock.ExpectCommit()
		mock.ExpectExec(`INSERT INTO audit_log`).WithArgs(adminTestUser, adminTestEntity, "application_catalog_changed", "application_catalog", softwareTestApplication, sqlmock.AnyArg(), strings.Split(req.RemoteAddr, ":")[0], "Bearer [REDACTED]").WillReturnResult(sqlmock.NewResult(0, 1))
		router.ServeHTTP(rec, req)
		assertRouteResult(t, mock, rec, 201, "catalog audited")
	})
}
