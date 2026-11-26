package api

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"itms/backend/internal/integrations/saltstack"
)

const installationPath = "/api/assets/" + adminTestAsset + "/script-runs"

func installationFixture(t *testing.T) installationScript {
	t.Helper()
	script := installationScript{ID: softwareTestApplication, EntityID: adminTestEntity, Name: "Example service", Category: "service", Type: "sh", OS: "Ubuntu", Body: "echo reviewed"}
	encoded, _ := json.Marshal(script)
	hash := sha256.Sum256(encoded)
	script.Hash = hex.EncodeToString(hash[:])
	return script
}

func installationRunRows(records ...installationRun) *sqlmock.Rows {
	rows := sqlmock.NewRows(strings.Split(installationRunColumns, ", "))
	for _, record := range records {
		rows.AddRow(record.RequestID, record.AssetID, record.ScriptID, record.ScriptHash, record.ScriptName, record.Category, record.Status, record.OutcomeCode, record.CreatedAt, record.UpdatedAt, record.ActorID, record.EntityID)
	}
	return rows
}

func installationFixtureRows(script installationScript) *sqlmock.Rows {
	return sqlmock.NewRows([]string{"id", "entity", "name", "category", "type", "os", "description", "body"}).AddRow(script.ID, script.EntityID, script.Name, script.Category, script.Type, script.OS, script.Description, script.Body)
}

func installationBody(script installationScript) string {
	return fmt.Sprintf(`{"requestId":%q,"scriptId":%q,"scriptHash":%q,"confirmed":true}`, softwareTestRequest, script.ID, script.Hash)
}

func TestInstallationRunRolesAndInput(t *testing.T) {
	for _, role := range []string{"", "employee", "admin", "auditor", "it_team", "super_admin", "SUPER_ADMIN"} {
		mock, recorder, router, request, cleanup := adminRoute(t, role, "POST", installationPath, `{}`)
		want := 403
		if role == "" {
			want = 401
		}
		if isAdminRole(role) {
			want = 400
		}
		router.ServeHTTP(recorder, request)
		assertRouteResult(t, mock, recorder, want, "script execution roles")
		cleanup()
	}
	script := installationFixture(t)
	body := installationBody(script)
	if _, err := decodeInstallationRun(strings.NewReader(body)); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{`{}`, body + `{}`, strings.Replace(body, `"confirmed":true`, `"confirmed":true,"confirmed":true`, 1), strings.Replace(body, `"confirmed":true`, `"confirmed":false`, 1), strings.Replace(body, `"confirmed":true`, `"confirmed":"true"`, 1), strings.Replace(body, `"confirmed":true`, `"confirmed":true,"body":"evil"`, 1), strings.Replace(body, script.Hash, "bad", 1), strings.Replace(body, softwareTestRequest, "00000000-0000-0000-0000-000000000000", 1)} {
		if _, err := decodeInstallationRun(strings.NewReader(invalid)); err == nil {
			t.Fatalf("accepted %s", invalid)
		}
	}
}

func TestInstallationCompatibility(t *testing.T) {
	script := installationFixture(t)
	for _, scenario := range []struct {
		os, target, entity string
		compute, valid     bool
	}{
		{"Ubuntu 24.04", "host-1", adminTestEntity, true, true},
		{"Windows 11", "host-1", adminTestEntity, true, false},
		{"Debian 12", "host-1", adminTestEntity, true, false},
		{"Unknown", "host-1", adminTestEntity, true, false},
		{"Ubuntu", "*", adminTestEntity, true, false},
		{"Ubuntu", "host-1", "other", true, false},
		{"Ubuntu", "host-1", adminTestEntity, false, false},
	} {
		if installationCompatible(script, endpointManagementAsset{EntityID: scenario.entity, Target: scenario.target, Compute: scenario.compute, OS: scenario.os}) != scenario.valid {
			t.Fatalf("scenario %+v", scenario)
		}
	}
	script.EntityID = ""
	asset := endpointManagementAsset{EntityID: adminTestOther, Target: "host-1", Compute: true, OS: "Ubuntu"}
	if !installationCompatible(script, asset) {
		t.Fatal("shared shell script should be compatible")
	}
	script.Type = "sls"
	if installationCompatible(script, asset) {
		t.Fatal("non-shell scripts must not execute")
	}
}

func TestInstallationScriptReadScope(t *testing.T) {
	script := installationFixture(t)
	mock, router := softwareHandlerHarness(t, "it_team", nil)
	expectManagementReadAsset(mock, "it_team", "host-1").WillReturnRows(sqlmock.NewRows([]string{"entity", "target", "compute", "os"}).AddRow(adminTestEntity, "host-1", true, "Ubuntu 24.04"))
	mock.ExpectQuery(`FROM admin_installation_scripts WHERE \(entity_id=\$1::uuid OR entity_id IS NULL\) AND type='sh' AND os IN`).WithArgs(adminTestEntity, "Ubuntu", 0).WillReturnRows(installationFixtureRows(script))
	recorder := softwareServe(router, "GET", "/api/assets/"+adminTestAsset+"/installation-scripts?page=1", "")
	assertRouteResult(t, mock, recorder, 200, "scoped script list")
	var result struct {
		Items        []installationScript `json:"items"`
		Capabilities struct {
			CanApply bool `json:"canApply"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || result.Items[0].Hash != script.Hash || result.Items[0].Body != "" || result.Capabilities.CanApply {
		t.Fatalf("unexpected list: %s", recorder.Body.String())
	}
	assertRouteResult(t, mock, softwareServe(router, "GET", "/api/assets/"+adminTestAsset+"/installation-scripts/"+script.ID, ""), 403, "script body restricted")
	for _, query := range []string{"?requestId=bad", "?requestId=", "?requestId=" + softwareTestRequest + "&requestId=" + softwareTestRequest} {
		assertRouteResult(t, mock, softwareServe(router, "GET", installationPath+query, ""), 400, "strict status filter")
	}
	expectManagementReadAsset(mock, "it_team", "host-1").WillReturnRows(sqlmock.NewRows([]string{"entity", "target", "compute", "os"}).AddRow(adminTestEntity, "host-1", true, "Ubuntu"))
	mock.ExpectQuery("FROM installation_script_runs WHERE asset_id=.*entity_id=.*request_id").WithArgs(adminTestAsset, adminTestEntity, softwareTestRequest).WillReturnRows(installationRunRows())
	assertRouteResult(t, mock, softwareServe(router, "GET", installationPath+"?requestId="+softwareTestRequest, ""), 200, "scoped exact status lookup")
}

func TestInstallationRunDurability(t *testing.T) {
	for _, scenario := range []string{"success", "replay", "conflict", "stale", "missing", "audit failure", "commit failure", "finish failure", "concurrent"} {
		t.Run(scenario, func(t *testing.T) {
			calls := 0
			provider := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				calls++
				fmt.Fprint(writer, `{"return":[{"host-1":{"retcode":0}}]}`)
			}))
			defer provider.Close()
			mock, router := softwareHandlerHarness(t, "super_admin", saltstack.NewClient(provider.URL, "token", "", "", "", "glob"))
			script := installationFixture(t)
			record := installationRun{RequestID: softwareTestRequest, AssetID: adminTestAsset, ScriptID: script.ID, ScriptHash: script.Hash, ScriptName: script.Name, Category: script.Category, Status: "unknown", OutcomeCode: "dispatch_unconfirmed", CreatedAt: time.Now(), UpdatedAt: time.Now(), ActorID: adminTestUser, EntityID: adminTestEntity}
			mock.ExpectBegin()
			expectSoftwareAsset(mock, "super_admin", "host-1", "Ubuntu 24.04", true)
			previous := mock.ExpectQuery("FROM installation_script_runs WHERE request_id").WithArgs(softwareTestRequest)
			want, dispatches := 202, 0
			if scenario == "replay" || scenario == "conflict" {
				if scenario == "conflict" {
					record.ActorID = "other"
					want = 409
				}
				previous.WillReturnRows(installationRunRows(record))
				mock.ExpectRollback()
			} else {
				previous.WillReturnRows(installationRunRows())
				query := mock.ExpectQuery("FROM admin_installation_scripts WHERE id=.*entity_id=.*FOR SHARE").WithArgs(script.ID, adminTestEntity)
				if scenario == "missing" {
					query.WillReturnError(sql.ErrNoRows)
					want = 404
					mock.ExpectRollback()
				} else {
					loaded := script
					if scenario == "stale" {
						loaded.Body = "echo changed"
					}
					query.WillReturnRows(installationFixtureRows(loaded))
					if scenario == "stale" {
						want = 409
						mock.ExpectRollback()
					} else {
						insert := mock.ExpectQuery("INSERT INTO installation_script_runs").WithArgs(softwareTestRequest, adminTestAsset, script.ID, script.Hash, script.Name, script.Category, adminTestUser, adminTestEntity)
						if scenario == "concurrent" {
							insert.WillReturnRows(installationRunRows())
							mock.ExpectQuery("FROM installation_script_runs WHERE request_id").WithArgs(softwareTestRequest).WillReturnRows(installationRunRows(record))
							mock.ExpectRollback()
						} else {
							insert.WillReturnRows(installationRunRows(record))
							event := mock.ExpectExec("INSERT INTO asset_history")
							if scenario == "audit failure" {
								event.WillReturnError(errors.New("private"))
								mock.ExpectRollback()
								want = 500
							} else {
								event.WillReturnResult(sqlmock.NewResult(0, 1))
								mock.ExpectExec("INSERT INTO audit_log").WillReturnResult(sqlmock.NewResult(0, 1))
								if scenario == "commit failure" {
									mock.ExpectCommit().WillReturnError(errors.New("private"))
								} else {
									mock.ExpectCommit()
									dispatches = 1
									mock.ExpectBegin()
									update := mock.ExpectQuery("UPDATE installation_script_runs").WithArgs(softwareTestRequest, "succeeded", "script_exited_zero")
									if scenario == "finish failure" {
										update.WillReturnError(errors.New("private"))
										mock.ExpectRollback()
									} else {
										record.Status, record.OutcomeCode = "succeeded", "script_exited_zero"
										update.WillReturnRows(installationRunRows(record))
										mock.ExpectExec("INSERT INTO asset_history").WillReturnResult(sqlmock.NewResult(0, 1))
										mock.ExpectExec("INSERT INTO audit_log").WillReturnResult(sqlmock.NewResult(0, 1))
										mock.ExpectCommit()
										want = 200
									}
								}
							}
						}
					}
				}
			}
			recorder := softwareServe(router, "POST", installationPath, installationBody(script))
			assertRouteResult(t, mock, recorder, want, scenario)
			if calls != dispatches {
				t.Fatalf("dispatch count %d, want %d", calls, dispatches)
			}
			if strings.Contains(recorder.Body.String(), "private") || strings.Contains(recorder.Body.String(), "echo reviewed") {
				t.Fatal("private script detail exposed")
			}
		})
	}
}
