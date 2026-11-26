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
	"itms/backend/internal/integrations/saltstack"
)

const managementTestPath = "/api/assets/" + adminTestAsset + "/management-actions"
const managementTestServiceBody = `{"requestId":"` + softwareTestRequest + `","kind":"service","action":"start","serviceName":"example","confirmed":true}`
const managementTestSoftwareBody = `{"requestId":"` + softwareTestRequest + `","kind":"software","action":"remove","applicationId":"` + softwareTestApplication + `","confirmed":true,"approvalId":"` + adminTestOther + `"}`

func managementRecord(kind, status, code string) endpointManagementRecord {
	r := endpointManagementRecord{RequestID: softwareTestRequest, AssetID: adminTestAsset, Kind: kind, Status: status, OutcomeCode: code, ActorID: adminTestUser, EntityID: adminTestEntity, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	if kind == "software" {
		r.Action, r.ApplicationID = "remove", softwareTestApplication
	} else {
		r.Action, r.ServiceName = "start", "example"
	}
	return r
}

func managementRows(records ...endpointManagementRecord) *sqlmock.Rows {
	rows := sqlmock.NewRows([]string{"request_id", "asset_id", "kind", "action", "application_id", "service_name", "status", "outcome_code", "created_at", "updated_at", "actor_id", "entity_id"})
	for _, r := range records {
		rows.AddRow(r.RequestID, r.AssetID, r.Kind, r.Action, r.ApplicationID, r.ServiceName, r.Status, r.OutcomeCode, r.CreatedAt, r.UpdatedAt, r.ActorID, r.EntityID)
	}
	return rows
}

func expectManagementPrevious(mock sqlmock.Sqlmock, records ...endpointManagementRecord) {
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT ` + endpointManagementColumns + ` FROM endpoint_management_requests WHERE request_id=$1::uuid`)).WithArgs(softwareTestRequest).WillReturnRows(managementRows(records...))
}

func expectManagementReadAsset(mock sqlmock.Sqlmock, role, target string) *sqlmock.ExpectedQuery {
	scope := "TRUE"
	if !isAdminRole(role) {
		scope = "(a.entity_id = NULLIF($2, '')::uuid OR EXISTS (SELECT 1 FROM user_entity_access uea WHERE uea.user_id = $3::uuid AND uea.entity_id = a.entity_id))"
	}
	q := mock.ExpectQuery(regexp.QuoteMeta(`SELECT a.entity_id::text, COALESCE(a.salt_minion_id, ''), a.is_compute, COALESCE(d.os_name, '') FROM assets a LEFT JOIN asset_compute_details d ON d.asset_id=a.id WHERE a.id=$1::uuid AND ` + scope))
	if isAdminRole(role) {
		q.WithArgs(adminTestAsset)
	} else {
		q.WithArgs(adminTestAsset, adminTestEntity, adminTestUser)
	}
	return q
}

func TestEndpointManagementRoleMatrix(t *testing.T) {
	for _, role := range []string{"", "employee", "admin", "auditor", "it_team", "super_admin", "Admin", "SUPER_ADMIN", "operator"} {
		for _, route := range []struct{ method, path string }{{"GET", "/api/assets/bad/services"}, {"GET", "/api/assets/bad/management-actions"}, {"POST", "/api/assets/bad/management-actions"}} {
			t.Run(role+route.method+route.path, func(t *testing.T) {
				mock, rec, router, req, cleanup := adminRoute(t, role, route.method, route.path, `{}`)
				defer cleanup()
				want := 403
				allowed := isAdminRole(role) || role == "it_team" || (route.method == "GET" && (role == "admin" || role == "auditor"))
				if allowed {
					want = 400
				}
				if role == "" {
					want = 401
				}
				router.ServeHTTP(rec, req)
				assertRouteResult(t, mock, rec, want, "management role gate")
			})
		}
	}
}

func TestEndpointManagementStrictInput(t *testing.T) {
	for _, body := range []string{managementTestServiceBody, managementTestSoftwareBody, strings.Replace(managementTestServiceBody, "example", "worker@tenant-1.service", 1)} {
		if _, err := decodeEndpointManagement(strings.NewReader(body)); err != nil {
			t.Fatal(err)
		}
	}
	bad := []string{`{}`, `[]`, `null`, `{`, managementTestServiceBody + `{}`, strings.Repeat(" ", 4097), "{\"kind\":\"\xff\"}"}
	for _, replacement := range []string{`"confirmed":false`, `"confirmed":null`, `"confirmed":"true"`, `"Confirmed":true`, `"confirmed":true,"confirmed":true`, `"confirmed":true,"command":"id"`, `"confirmed":true,"target":"*"`, `"confirmed":true,"applicationId":""`} {
		bad = append(bad, strings.Replace(managementTestServiceBody, `"confirmed":true`, replacement, 1))
	}
	for _, name := range []string{"*", "a,b", "a;id", "a\nb", "a\x00b", "-a", "$(id)", "a?", "a/b", "", strings.Repeat("a", 256)} {
		raw, _ := json.Marshal(name)
		bad = append(bad, strings.Replace(managementTestServiceBody, `"example"`, string(raw), 1))
	}
	for _, replacement := range []string{`"kind":"Service"`, `"kind":null`, `"kind":4`, `"kind":"shell"`} {
		bad = append(bad, strings.Replace(managementTestServiceBody, `"kind":"service"`, replacement, 1))
	}
	for _, action := range []string{"reload", "remove", "uninstall", "delete", "mask", "cmd.run"} {
		bad = append(bad, strings.Replace(managementTestServiceBody, `"start"`, `"`+action+`"`, 1))
	}
	bad = append(bad, strings.Replace(managementTestSoftwareBody, `"remove"`, `"install"`, 1), strings.Replace(managementTestSoftwareBody, softwareTestApplication, "bad", 1), strings.Replace(managementTestSoftwareBody, softwareTestRequest, "00000000-0000-0000-0000-000000000000", 1))
	for i, body := range bad {
		mock, router := softwareHandlerHarness(t, "it_team", nil)
		rec := softwareServe(router, "POST", managementTestPath, body)
		assertRouteResult(t, mock, rec, 400, fmt.Sprintf("strict management payload %d", i))
	}
}

func TestEndpointManagementScopeAndCatalogGuards(t *testing.T) {
	for _, tc := range []struct {
		name, target, os, pkg string
		compute, active       bool
		want                  int
	}{
		{"missing asset", "host-1", "Ubuntu", "firefox", true, true, 404},
		{"db error", "host-1", "Ubuntu", "firefox", true, true, 500},
		{"missing catalog", "host-1", "Ubuntu", "firefox", true, true, 404},
		{"wildcard", "*", "Ubuntu", "firefox", true, true, 400},
		{"empty target", "", "Ubuntu", "firefox", true, true, 400},
		{"noncompute", "host-1", "Ubuntu", "firefox", false, true, 400},
		{"wrong os", "host-1", "Windows 11", "firefox", true, true, 409},
		{"unknown os", "host-1", "Unknown", "firefox", true, true, 409},
		{"inactive", "host-1", "Ubuntu", "firefox", true, false, 409},
		{"injection", "host-1", "Ubuntu", "a;id", true, true, 409},
		{"protected", "host-1", "Ubuntu", "wazuh-agent", true, true, 403},
		{"disabled provider", "host-1", "Ubuntu", "firefox", true, true, 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mock, router := softwareHandlerHarness(t, "it_team", nil)
			mock.ExpectBegin()
			if tc.name == "missing asset" || tc.name == "db error" {
				err := sql.ErrNoRows
				if tc.name == "db error" {
					err = errors.New("private credential")
				}
				mock.ExpectQuery(`FROM assets a .*user_entity_access.*FOR SHARE OF a`).WithArgs(adminTestAsset, adminTestEntity, adminTestUser).WillReturnError(err)
			} else {
				expectSoftwareAsset(mock, "it_team", tc.target, tc.os, tc.compute)
				expectManagementPrevious(mock)
				if tc.compute && saltstack.ValidExactMinion(tc.target) {
					q := mock.ExpectQuery(`FROM application_catalog WHERE id=\$1::uuid AND entity_id=\$2::uuid FOR SHARE`).WithArgs(softwareTestApplication, adminTestEntity)
					if tc.name == "missing catalog" {
						q.WillReturnError(sql.ErrNoRows)
					} else {
						q.WillReturnRows(sqlmock.NewRows([]string{"id", "entity", "name", "description", "os", "package", "active", "updated_at"}).AddRow(softwareTestApplication, adminTestEntity, "Example", "", "linux", tc.pkg, tc.active, time.Now()))
					}
				}
			}
			mock.ExpectRollback()
			rec := softwareServe(router, "POST", managementTestPath, managementTestSoftwareBody)
			assertRouteResult(t, mock, rec, tc.want, "management preflight")
			if strings.Contains(rec.Body.String(), "private") {
				t.Fatal("leaked SQL error")
			}
		})
	}
	for _, action := range []string{"stop", "disable"} {
		mock, router := softwareHandlerHarness(t, "it_team", nil)
		mock.ExpectBegin()
		expectSoftwareAsset(mock, "it_team", "host-1", "Ubuntu", true)
		expectManagementPrevious(mock)
		mock.ExpectRollback()
		body := strings.Replace(strings.Replace(managementTestServiceBody, "example", "sshd@instance.service", 1), "start", action, 1)
		assertRouteResult(t, mock, softwareServe(router, "POST", managementTestPath, body), 403, "protected service")
	}
}

func TestEndpointManagementReplayAndConflict(t *testing.T) {
	for _, kind := range []string{"service", "software"} {
		for _, scenario := range []string{"succeeded", "failed", "unknown", "actor", "asset", "entity", "kind", "action", "application", "service"} {
			t.Run(kind+scenario, func(t *testing.T) {
				mock, router := softwareHandlerHarness(t, "it_team", nil)
				mock.ExpectBegin()
				expectSoftwareAsset(mock, "it_team", "", "Unknown", true)
				r := managementRecord(kind, "unknown", "dispatch_unconfirmed")
				want := 409
				switch scenario {
				case "succeeded", "failed":
					r.Status, want = scenario, 200
				case "unknown":
					want = 202
				case "actor":
					r.ActorID = adminTestOther
				case "asset":
					r.AssetID = adminTestOther
				case "entity":
					r.EntityID = adminTestOther
				case "kind":
					r.Kind = "different"
				case "action":
					r.Action = "different"
				case "application":
					r.ApplicationID = adminTestOther
				case "service":
					r.ServiceName = "different"
				}
				expectManagementPrevious(mock, r)
				mock.ExpectRollback()
				body := managementTestServiceBody
				if kind == "software" {
					body = managementTestSoftwareBody
				}
				rec := softwareServe(router, "POST", managementTestPath, body)
				assertRouteResult(t, mock, rec, want, "replay without provider/catalog lookup")
			})
		}
	}
}

func TestEndpointManagementReservationAndPersistence(t *testing.T) {
	for _, kind := range []string{"service", "software"} {
		for _, scenario := range []string{"success", "failed", "unknown", "insert failure", "history failure", "audit failure", "commit failure", "concurrent loser", "concurrent conflict", "finish begin", "finish update", "finish audit", "finish commit"} {
			t.Run(kind+scenario, func(t *testing.T) {
				calls := 0
				var mock sqlmock.Sqlmock
				remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					var payload struct {
						Function string `json:"fun"`
					}
					_ = json.NewDecoder(r.Body).Decode(&payload)
					// The first remote call must only occur after reservation and both
					// event writes committed. Subsequent expected SQL is finalization.
					value := `true`
					if payload.Function == "service.get_all" {
						value = `["example"]`
					} else if scenario == "failed" {
						value = `false`
					} else if scenario == "unknown" {
						value = `null`
					} else if kind == "software" {
						value = `{"firefox":{"old":"1","new":""}}`
					}
					_, _ = fmt.Fprintf(w, `{"return":[{"host-1":%s}]}`, value)
				}))
				defer remote.Close()
				var router http.Handler
				mock, router = softwareHandlerHarness(t, "it_team", saltstack.NewClient(remote.URL, "fixture-token", "", "", "", "glob"))
				mock.ExpectBegin()
				expectSoftwareAsset(mock, "it_team", "host-1", "Ubuntu", true)
				expectManagementPrevious(mock)
				body, app, service, pkg, os := managementTestServiceBody, "", "example", "", ""
				if kind == "software" {
					body, app, service, pkg, os = managementTestSoftwareBody, softwareTestApplication, "", "firefox", "linux"
					mock.ExpectQuery(`FROM application_catalog WHERE id=\$1::uuid AND entity_id=\$2::uuid FOR SHARE`).WithArgs(app, adminTestEntity).WillReturnRows(softwareApplicationRows(true, "linux"))
				}
				r := managementRecord(kind, "unknown", "dispatch_unconfirmed")
				insert := mock.ExpectQuery(`INSERT INTO endpoint_management_requests .*ON CONFLICT \(request_id\) DO NOTHING RETURNING`).WithArgs(softwareTestRequest, adminTestAsset, adminTestEntity, adminTestUser, kind, r.Action, app, service, pkg, os, "host-1")
				want, wantCalls := 200, 3
				if kind == "software" {
					wantCalls = 1
				}
				status, code := "succeeded", "service_state_verified"
				if kind == "software" {
					code = "package_removed"
				}
				if scenario == "failed" {
					status, code = "failed", "provider_failed"
				}
				if scenario == "unknown" {
					status, code, want = "unknown", "unrecognized_response", 202
				}
				if kind == "service" && (scenario == "failed" || scenario == "unknown") {
					wantCalls = 2
				}
				switch scenario {
				case "insert failure":
					insert.WillReturnError(errors.New("secret insert"))
					mock.ExpectRollback()
					want, wantCalls = 500, 0
				case "concurrent loser", "concurrent conflict":
					insert.WillReturnRows(managementRows())
					if scenario == "concurrent conflict" {
						r.ActorID = adminTestOther
					}
					expectManagementPrevious(mock, r)
					mock.ExpectRollback()
					want, wantCalls = 202, 0
					if scenario == "concurrent conflict" {
						want = 409
					}
				default:
					insert.WillReturnRows(managementRows(r))
					if kind == "software" {
						expectApprovalConsumption(mock, "remove")
					}
					if scenario == "history failure" || scenario == "audit failure" {
						if scenario == "audit failure" {
							mock.ExpectExec(`INSERT INTO asset_history`).WillReturnResult(sqlmock.NewResult(0, 1))
						}
						table := "asset_history"
						if scenario == "audit failure" {
							table = "audit_log"
						}
						mock.ExpectExec(`INSERT INTO ` + table).WillReturnError(errors.New("secret audit"))
						mock.ExpectRollback()
						want, wantCalls = 500, 0
					} else {
						expectSoftwareEvents(mock, "endpoint_management_requested")
						if scenario == "commit failure" {
							mock.ExpectCommit().WillReturnError(errors.New("secret commit"))
							want, wantCalls = 202, 0
						} else {
							mock.ExpectCommit()
							if strings.HasPrefix(scenario, "finish ") {
								want = 202
							}
							if scenario == "finish begin" {
								mock.ExpectBegin().WillReturnError(errors.New("secret connection"))
							} else {
								mock.ExpectBegin()
								update := mock.ExpectQuery(`UPDATE endpoint_management_requests SET status=\$2, outcome_code=\$3.*AND status='unknown' RETURNING`).WithArgs(softwareTestRequest, status, code)
								if scenario == "finish update" {
									update.WillReturnError(errors.New("secret update"))
									mock.ExpectRollback()
								} else {
									update.WillReturnRows(managementRows(managementRecord(kind, status, code)))
									if scenario == "finish audit" {
										mock.ExpectExec(`INSERT INTO asset_history`).WillReturnResult(sqlmock.NewResult(0, 1))
										mock.ExpectExec(`INSERT INTO audit_log`).WillReturnError(errors.New("secret audit"))
										mock.ExpectRollback()
									} else {
										expectSoftwareEvents(mock, "endpoint_management_outcome")
										commit := mock.ExpectCommit()
										if scenario == "finish commit" {
											commit.WillReturnError(errors.New("secret commit"))
										}
									}
								}
							}
						}
					}
				}
				rec := softwareServe(router, "POST", managementTestPath, body)
				assertRouteResult(t, mock, rec, want, "durable management dispatch")
				if calls != wantCalls {
					t.Fatalf("calls=%d want=%d", calls, wantCalls)
				}
				if strings.Contains(rec.Body.String(), "secret") || strings.Contains(rec.Body.String(), "host-1") || strings.Contains(rec.Body.String(), "actorId") {
					t.Fatal("internal details leaked")
				}
				if want == 202 && !strings.Contains(rec.Body.String(), `"status":"unknown"`) {
					t.Fatal("unpersisted success")
				}
			})
		}
	}
}

func TestEndpointManagementReadContracts(t *testing.T) {
	for _, role := range []string{"super_admin", "admin", "it_team", "auditor"} {
		for _, services := range []bool{false, true} {
			for _, allowed := range []bool{false, true} {
				t.Run(fmt.Sprint(role, services, allowed), func(t *testing.T) {
					remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						_, _ = w.Write([]byte(`{"return":[{"host-1":["example"]}]}`))
					}))
					defer remote.Close()
					mock, router := softwareHandlerHarness(t, role, saltstack.NewClient(remote.URL, "fixture-token", "", "", "", "glob"))
					q := expectManagementReadAsset(mock, role, "host-1")
					want := 404
					if allowed {
						want = 200
						q.WillReturnRows(sqlmock.NewRows([]string{"entity", "target", "compute", "os"}).AddRow(adminTestEntity, "host-1", true, "Ubuntu"))
						if !services {
							mock.ExpectQuery(`FROM endpoint_management_requests WHERE asset_id=\$1::uuid AND entity_id=\$2::uuid AND request_id=\$3::uuid ORDER BY created_at DESC, request_id LIMIT 100`).WithArgs(adminTestAsset, adminTestEntity, softwareTestRequest).WillReturnRows(managementRows(managementRecord("service", "unknown", "dispatch_unconfirmed")))
						}
					} else {
						q.WillReturnError(sql.ErrNoRows)
					}
					path := managementTestPath + "?requestId=" + softwareTestRequest
					if services {
						path = "/api/assets/" + adminTestAsset + "/services"
					}
					rec := softwareServe(router, "GET", path, "")
					assertRouteResult(t, mock, rec, want, "scoped management read")
					if !allowed {
						return
					}
					var response struct {
						Items        []map[string]any `json:"items"`
						Status       string           `json:"status"`
						Capabilities struct {
							CanManage bool `json:"canManage"`
						} `json:"capabilities"`
					}
					if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
						t.Fatal(err)
					}
					if response.Capabilities.CanManage != (isAdminRole(role) || role == "it_team") || len(response.Items) != 1 {
						t.Fatal(rec.Body.String())
					}
					if services {
						item := response.Items[0]
						if len(item) != 3 || item["name"] != "example" || item["running"] != nil || item["enabled"] != nil || response.Status != "partial" {
							t.Fatal(rec.Body.String())
						}
					} else if len(response.Items[0]) != 9 {
						t.Fatal("incorrect action contract", rec.Body.String())
					}
					if strings.Contains(rec.Body.String(), "host-1") || strings.Contains(rec.Body.String(), "actorId") || strings.Contains(rec.Body.String(), "entityId") {
						t.Fatal("internal fields leaked")
					}
				})
			}
		}
	}
}

func TestEndpointManagementReadErrors(t *testing.T) {
	for _, query := range []string{"?requestId=", "?requestId=bad", "?requestId=" + softwareTestRequest + "&requestId=" + softwareTestRequest} {
		mock, router := softwareHandlerHarness(t, "auditor", nil)
		assertRouteResult(t, mock, softwareServe(router, "GET", managementTestPath+query, ""), 400, "invalid request filter")
	}
	for _, target := range []string{"", "*", "host-1"} {
		mock, router := softwareHandlerHarness(t, "it_team", nil)
		expectManagementReadAsset(mock, "it_team", target).WillReturnRows(sqlmock.NewRows([]string{"entity", "target", "compute", "os"}).AddRow(adminTestEntity, target, true, "Ubuntu"))
		rec := softwareServe(router, "GET", "/api/assets/"+adminTestAsset+"/services", "")
		assertRouteResult(t, mock, rec, 200, "unavailable services")
		if !strings.Contains(rec.Body.String(), `"items":[]`) || !strings.Contains(rec.Body.String(), `"status":"unavailable"`) {
			t.Fatal(rec.Body.String())
		}
	}
	for _, scenario := range []string{"query", "scan", "iteration"} {
		mock, router := softwareHandlerHarness(t, "auditor", nil)
		expectManagementReadAsset(mock, "auditor", "host-1").WillReturnRows(sqlmock.NewRows([]string{"entity", "target", "compute", "os"}).AddRow(adminTestEntity, "host-1", true, "Ubuntu"))
		q := mock.ExpectQuery(`FROM endpoint_management_requests WHERE asset_id=\$1::uuid AND entity_id=\$2::uuid ORDER BY`).WithArgs(adminTestAsset, adminTestEntity)
		switch scenario {
		case "query":
			q.WillReturnError(errors.New("secret connection"))
		case "scan":
			q.WillReturnRows(sqlmock.NewRows([]string{"bad"}).AddRow("secret"))
		case "iteration":
			q.WillReturnRows(managementRows(managementRecord("service", "unknown", "dispatch_unconfirmed")).RowError(0, errors.New("secret row")))
		}
		rec := softwareServe(router, "GET", managementTestPath, "")
		assertRouteResult(t, mock, rec, 500, "sanitized read failure")
		if strings.Contains(rec.Body.String(), "secret") {
			t.Fatal("leaked provider detail")
		}
	}
}

func TestEndpointManagementDelegatedAssetCatalogScope(t *testing.T) {
	for _, kind := range []string{"service", "software"} {
		t.Run(kind, func(t *testing.T) {
			mock, router := softwareHandlerHarness(t, "it_team", nil)
			mock.ExpectBegin()
			mock.ExpectQuery(`FROM assets a .*user_entity_access.*FOR SHARE OF a`).WithArgs(adminTestAsset, adminTestEntity, adminTestUser).
				WillReturnRows(sqlmock.NewRows([]string{"entity", "target", "compute", "os"}).AddRow(adminTestOther, "host-1", true, "Ubuntu"))
			expectManagementPrevious(mock)
			body, want := managementTestServiceBody, 503
			if kind == "software" {
				body, want = managementTestSoftwareBody, 404
				// An application in the actor's primary entity is NOT authority to
				// remove it on this device in a delegated entity.
				mock.ExpectQuery(`FROM application_catalog WHERE id=\$1::uuid AND entity_id=\$2::uuid FOR SHARE`).
					WithArgs(softwareTestApplication, adminTestOther).WillReturnError(sql.ErrNoRows)
			}
			mock.ExpectRollback()
			assertRouteResult(t, mock, softwareServe(router, "POST", managementTestPath, body), want, "device entity owns catalog authorization")
		})
	}
}

func TestEndpointManagementAuditCommittedBeforeRemote(t *testing.T) {
	for _, action := range []string{"start", "stop", "restart", "enable", "disable"} {
		t.Run(action, func(t *testing.T) {
			var mock sqlmock.Sqlmock
			calls := 0
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				calls++
				if calls != 1 {
					t.Error("invalid discovery must not dispatch or retry")
				}
				if err := mock.ExpectationsWereMet(); err != nil {
					t.Errorf("remote called before durable reservation and audit: %v", err)
				}
				// Register finalization only after proving all reservation writes
				// and the commit occurred before even read-only Salt discovery.
				result := managementRecord("service", "unknown", "service_validation_unavailable")
				result.Action = action
				mock.ExpectBegin()
				mock.ExpectQuery(`UPDATE endpoint_management_requests .*AND status='unknown' RETURNING`).
					WithArgs(softwareTestRequest, result.Status, result.OutcomeCode).WillReturnRows(managementRows(result))
				expectSoftwareEvents(mock, "endpoint_management_outcome")
				mock.ExpectCommit()
				_, _ = w.Write([]byte(`{"return":[{"host-1":null}]}`))
			}))
			defer remote.Close()
			var router http.Handler
			mock, router = softwareHandlerHarness(t, "it_team", saltstack.NewClient(remote.URL, "fixture-token", "", "", "", "glob"))
			mock.ExpectBegin()
			expectSoftwareAsset(mock, "it_team", "host-1", "Ubuntu", true)
			expectManagementPrevious(mock)
			record := managementRecord("service", "unknown", "dispatch_unconfirmed")
			record.Action = action
			mock.ExpectQuery(`INSERT INTO endpoint_management_requests`).
				WithArgs(softwareTestRequest, adminTestAsset, adminTestEntity, adminTestUser, "service", action, "", "example", "", "", "host-1").
				WillReturnRows(managementRows(record))
			expectSoftwareEvents(mock, "endpoint_management_requested")
			mock.ExpectCommit()
			body := strings.Replace(managementTestServiceBody, `"start"`, `"`+action+`"`, 1)
			rec := softwareServe(router, "POST", managementTestPath, body)
			assertRouteResult(t, mock, rec, 202, "unknown discovery is audited")
			if calls != 1 || !strings.Contains(rec.Body.String(), `"outcomeCode":"service_validation_unavailable"`) {
				t.Fatal(rec.Body.String())
			}
		})
	}
}
