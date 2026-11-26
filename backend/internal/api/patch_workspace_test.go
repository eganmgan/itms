package api

import (
	"database/sql"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"itms/backend/internal/integrations/saltstack"
)

func TestListPatchLogsFiltersScopedResults(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	claims := newTestClaims("it_team", "user-1", "entity-1")
	context, recorder := newTestContext(http.MethodGet, "/api/patch/logs?department=Engineering&status=success", claims)

	mock.ExpectQuery(`SELECT h\.id::text, a\.id::text, a\.asset_tag`).
		WithArgs("it_team", "entity-1", "user-1").
		WillReturnRows(sqlmock.NewRows([]string{"id", "asset_id", "asset_tag", "hostname", "department", "detail", "created_at"}).
			AddRow("log-1", "asset-1", "ZR-1001", "eng-ws-12", "Engineering", []byte(`{"status":"success"}`), time.Now()).
			AddRow("log-2", "asset-2", "ZBL-2001", "fin-ws-03", "Finance", []byte(`{"status":"failed"}`), time.Now()))

	server.listPatchLogs(context)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `"hostname":"eng-ws-12"`) || !strings.Contains(body, `"assetTag":"ZR-1001"`) || strings.Contains(body, "fin-ws-03") || !strings.Contains(body, `"total":1`) {
		t.Fatalf("unexpected response: %s", body)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestCreatePatchAutomationPersistsEntityScopedDraft(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	claims := newTestClaims("it_team", "user-1", "entity-1")
	context, recorder := newTestContext(http.MethodPost, "/api/patch/automations", claims)
	context.Request.Body = io.NopCloser(strings.NewReader(`{"name":"patch.custom","kind":"sls","content":"pkg.uptodate: []"}`))
	context.Request.Header.Set("Content-Type", "application/json")

	mock.ExpectQuery(`INSERT INTO patch_automations`).
		WithArgs("entity-1", "user-1", "patch.custom", "sls", "pkg.uptodate: []", "").
		WillReturnRows(sqlmock.NewRows([]string{"id", "created_at"}).AddRow("automation-1", time.Now()))

	server.createPatchAutomation(context)

	if recorder.Code != http.StatusCreated || !strings.Contains(recorder.Body.String(), `"name":"patch.custom"`) {
		t.Fatalf("unexpected response %d: %s", recorder.Code, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestGetPatchPoliciesReturnsDefaults(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	claims := newTestClaims("auditor", "user-1", "entity-1")
	context, recorder := newTestContext(http.MethodGet, "/api/patch/policies", claims)
	mock.ExpectQuery(`SELECT value, updated_at FROM settings`).WithArgs(workflowSettingsKey).WillReturnError(sql.ErrNoRows)

	server.getPatchPolicies(context)

	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"windowStart":"22:00"`) {
		t.Fatalf("unexpected response %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestRunPatchBatchRejectsUnknownTargetMode(t *testing.T) {
	server, _, cleanup := newTestServer(t)
	defer cleanup()
	claims := newTestClaims("it_team", "user-1", "entity-1")
	context, recorder := newTestContext(http.MethodPost, "/api/patch/batch", claims)
	context.Request.Body = io.NopCloser(strings.NewReader(`{"targetMode":"all"}`))
	context.Request.Header.Set("Content-Type", "application/json")

	server.runPatchBatch(context)

	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "targetMode") {
		t.Fatalf("unexpected response %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestRunPatchBatchRejectsUnsafeCommand(t *testing.T) {
	server, _, cleanup := newTestServer(t)
	defer cleanup()
	claims := newTestClaims("it_team", "user-1", "entity-1")
	context, recorder := newTestContext(http.MethodPost, "/api/patch/batch", claims)
	context.Request.Body = io.NopCloser(strings.NewReader(`{"targetMode":"system","systemId":"SYS-1","action":"custom-command","command":"curl https://example.com"}`))
	context.Request.Header.Set("Content-Type", "application/json")

	server.runPatchBatch(context)

	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "blocked") {
		t.Fatalf("unexpected response %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestRunPatchBatchExplainsPackageManagementBeforeTargetLookup(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	claims := newTestClaims("it_team", "user-1", "entity-1")
	context, recorder := newTestContext(http.MethodPost, "/api/patch/batch", claims)
	context.Request.Body = io.NopCloser(strings.NewReader(`{"targetMode":"system","systemId":"example-host","action":"custom-command","command":"apt update"}`))
	context.Request.Header.Set("Content-Type", "application/json")

	server.runPatchBatch(context)

	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "administrator-deployed Salt state") {
		t.Fatalf("unexpected response %d: %s", recorder.Code, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestRunPatchBatchPingUsesOneScopedProbe(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		body   string
		status string
	}{
		{"online", `{"return":[{"host-1":true,"host-2":true}]}`, "completed"},
		{"offline", `{"return":[{}]}`, "failed"},
		{"invalid response", `{"unexpected":true}`, "failed"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			var calls atomic.Int32
			peer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				calls.Add(1)
				_ = request.ParseForm()
				if request.Form.Get("fun") != "test.ping" || request.Form.Get("expr_form") != "list" || request.Form.Get("tgt_type") != "list" || request.Form.Get("timeout") != "1" || request.Form.Get("gather_job_timeout") != "1" || strings.Join(request.Form["tgt"], ",") != "host-1,host-2" {
					t.Errorf("unexpected scoped ping: %v", request.Form)
				}
				writer.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(writer, scenario.body)
			}))
			defer peer.Close()
			server.salt = saltstack.NewClient(peer.URL, "", "test", "test", "file", "glob")
			context, recorder := newTestContext(http.MethodPost, "/api/patch/batch", newTestClaims("super_admin", "user-1", "entity-1"))
			context.Request.Body = io.NopCloser(strings.NewReader(`{"targetMode":"departments","departments":["IT Team"],"action":"test.ping"}`))
			context.Request.Header.Set("Content-Type", "application/json")
			mock.ExpectQuery(`SELECT a.id::text, a.asset_tag`).WithArgs("super_admin", "entity-1", "user-1", "departments", "", `{"IT Team"}`).WillReturnRows(sqlmock.NewRows([]string{"id", "asset_tag"}).AddRow("asset-1", "TAG-1").AddRow("asset-2", "TAG-2"))
			expectAssetLookup(mock, "asset-1", "TAG-1", "Host 1", "host-1", "laptop", true, "entity-1", "host-1", "", "active", "good")
			expectAssetLookup(mock, "asset-2", "TAG-2", "Host 2", "host-2", "laptop", true, "entity-1", "host-2", "", "active", "good")
			for _, assetID := range []string{"asset-1", "asset-2"} {
				mock.ExpectQuery(`INSERT INTO asset_history`).WithArgs(assetID, "user-1", "patch_run", sqlmock.AnyArg()).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("history-" + assetID))
			}
			server.runPatchBatch(context)
			body := recorder.Body.String()
			if recorder.Code != http.StatusOK || calls.Load() != 1 || !strings.Contains(body, `"targetCount":2`) || !strings.Contains(body, `"target":"host-1"`) || !strings.Contains(body, `"target":"host-2"`) || strings.Count(body, `"status":"`+scenario.status+`"`) != 4 {
				t.Fatalf("unexpected batch response: code=%d calls=%d body=%s", recorder.Code, calls.Load(), body)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestRunPatchBatchUsesScopedAssignedDepartmentFallback(t *testing.T) {
	for _, queryFails := range []bool{false, true} {
		name := "no matching targets"
		if queryFails {
			name = "incomplete target response"
		}
		t.Run(name, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			context, recorder := newTestContext(http.MethodPost, "/api/patch/batch", newTestClaims("it_team", "user-1", "entity-1"))
			context.Request.Body = io.NopCloser(strings.NewReader(`{"targetMode":"departments","departments":["IT Team"],"action":"custom-state","state":"patch.baseline"}`))
			context.Request.Header.Set("Content-Type", "application/json")
			rows := sqlmock.NewRows([]string{"id", "asset_tag"})
			if queryFails {
				rows.AddRow("asset-1", "TAG-1").AddRow("asset-2", "TAG-2").RowError(1, io.ErrUnexpectedEOF)
			}
			mock.ExpectQuery(regexp.QuoteMeta(`
				SELECT a.id::text, a.asset_tag
				FROM assets a
				LEFT JOIN users u ON u.id = a.assigned_to
				LEFT JOIN departments ad ON ad.id = a.dept_id
				LEFT JOIN departments ud ON ud.id = u.dept_id
				WHERE a.is_compute = TRUE
				  AND ($1 = 'super_admin' OR a.entity_id = $2::uuid OR EXISTS (SELECT 1 FROM user_entity_access uea WHERE uea.user_id = $3::uuid AND uea.entity_id = a.entity_id))
				  AND (($4 = 'system' AND (a.hostname = $5 OR a.salt_minion_id = $5 OR a.asset_tag = $5)) OR ($4 = 'departments' AND COALESCE(ad.name, ud.name, '') = ANY($6::text[])))
				ORDER BY a.hostname
			`)).WithArgs("it_team", "entity-1", "user-1", "departments", "", `{"IT Team"}`).WillReturnRows(rows)
			server.runPatchBatch(context)
			wantStatus := http.StatusNotFound
			wantMessage := "no patch targets matched"
			if queryFails {
				wantStatus = http.StatusInternalServerError
				wantMessage = "patch targets unavailable"
			}
			if recorder.Code != wantStatus || !strings.Contains(recorder.Body.String(), wantMessage) {
				t.Fatalf("unexpected response %d: %s", recorder.Code, recorder.Body.String())
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
