package api

import (
	"database/sql/driver"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"

	"itms/backend/internal/integrations/saltstack"
)

type capturedPatchReport struct{ payload string }

func (capture *capturedPatchReport) Match(value driver.Value) bool {
	payload, ok := value.(string)
	if ok {
		capture.payload = payload
	}
	return ok
}

func TestPatchReportOutputPersistence(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	claims := newTestClaims("super_admin", "user-1", "entity-1")
	c, recorder := newTestContext(http.MethodPost, "/api/patch/reports", claims)
	c.Request.Header.Set("Content-Type", "application/json")
	c.Request.Body = io.NopCloser(strings.NewReader(`{"scopeLabel":"Recorded run","requestedAt":"2026-09-16T00:00:00Z","completedAt":"2026-09-16T00:01:00Z","rows":[{"deviceId":"asset-1","status":"Completed","assetTag":"TAG-1","command":"uptime","output":"exact\noutput\n","stdout":"","stderr":"","retcode":0,"exitCode":0,"result":{"stdout":"real output\n","retcode":0,"future":{"pid":9007199254740993}},"rawResult":{"agent":true},"updatedItems":["openssl"],"packageChanges":[{"name":"openssl","fromVersion":"1","toVersion":"2"}]}]}`))
	expectAssetLookup(mock, "asset-1", "TAG-1", "Test", "host", "laptop", true, "entity-1", "", "", "active", "good")
	capture := &capturedPatchReport{}
	mock.ExpectQuery(`INSERT INTO patch_run_reports`).WithArgs("user-1", "Recorded run", sqlmock.AnyArg(), sqlmock.AnyArg(), 1, 0, 1, `["entity-1"]`, capture).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("report-1"))
	server.createPatchRunReport(c)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", recorder.Code, recorder.Body.String())
	}
	var stored patchRunReportInput
	if err := json.Unmarshal([]byte(capture.payload), &stored); err != nil {
		t.Fatal(err)
	}
	row := stored.Rows[0]
	if row.Output == nil || *row.Output != "exact\noutput\n" || row.Stdout == nil || *row.Stdout != "" || row.Stderr == nil || row.Retcode == nil || *row.Retcode != 0 || row.ExitCode == nil || *row.ExitCode != 0 {
		t.Fatalf("lost output or zero/empty values: %+v", row)
	}
	if !strings.Contains(string(row.Result), "9007199254740993") || string(row.RawResult) != `{"agent":true}` || len(row.PackageChanges) != 1 || row.PackageChanges[0].ToVersion != "2" {
		t.Fatal("lost raw result or package changes")
	}
	mock.ExpectQuery(`SELECT report, entity_ids FROM patch_run_reports`).WithArgs("report-1").WillReturnRows(sqlmock.NewRows([]string{"report", "entity_ids"}).AddRow(capture.payload, `["entity-1"]`))
	get, response := newTestContext(http.MethodGet, "/api/patch/reports/report-1", claims)
	get.Params = append(get.Params, gin.Param{Key: "id", Value: "report-1"})
	server.getPatchRunReport(get)
	if response.Code != http.StatusOK {
		t.Fatalf("read: %d %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "9007199254740993") {
		t.Fatal("GET rounded raw numeric result")
	}
	var restored patchRunReportInput
	if err := json.Unmarshal(response.Body.Bytes(), &restored); err != nil {
		t.Fatal(err)
	}
	// Compare decoded rows so JSONB/map key ordering is irrelevant.
	var want, got any
	_ = json.Unmarshal([]byte(capture.payload), &want)
	_ = json.Unmarshal(response.Body.Bytes(), &got)
	if !reflect.DeepEqual(want.(map[string]any)["rows"], got.(map[string]any)["rows"]) {
		t.Fatal("GET lost execution fields")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPatchReportOutcomeCountsAndLimits(t *testing.T) {
	input := patchRunReportInput{SuccessCount: 99, FailedCount: 99}
	for _, status := range []string{"SUCCESS", " completed ", "up_to_date", "error", "failed", "running", "queued", "pending", "skipped", "cancelled", "unexpected", ""} {
		input.Rows = append(input.Rows, patchRunReportRowInput{Status: status})
	}
	if err := normalizePatchReport(&input); err != nil {
		t.Fatal(err)
	}
	if input.SuccessCount != 3 || input.FailedCount != 2 {
		t.Fatalf("counts: %+v", input)
	}
	for _, row := range input.Rows {
		if row.Stdout != nil || row.ExitCode != nil || len(row.Result) > 0 || len(row.UpdatedItems) > 0 {
			t.Fatal("invented execution data")
		}
	}
	input.Rows = []patchRunReportRowInput{{Status: "success", Result: json.RawMessage(`{"retcode":7,"stdout":"partial"}`)}}
	if err := normalizePatchReport(&input); err != nil || input.FailedCount != 1 {
		t.Fatalf("raw failure not counted: %v %+v", err, input)
	}
	large := strings.Repeat("x", patchReportRowLimit)
	input.Rows = []patchRunReportRowInput{{Stdout: &large}}
	if normalizePatchReport(&input) == nil {
		t.Fatal("accepted oversized row")
	}
	input.Rows = make([]patchRunReportRowInput, patchReportMaxRows+1)
	if normalizePatchReport(&input) == nil {
		t.Fatal("accepted too many rows")
	}
}

func TestPatchReportRejectsOversizedBodyBeforeDatabase(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	c, recorder := newTestContext(http.MethodPost, "/api/patch/reports", newTestClaims("super_admin", "user-1", "entity-1"))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Request.Body = io.NopCloser(strings.NewReader(`{"scopeLabel":"` + strings.Repeat("x", patchReportBodyLimit) + `"}`))
	server.createPatchRunReport(c)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", recorder.Code)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPatchExecutionStatusUsesRecordedResults(t *testing.T) {
	for _, test := range []struct{ input, want string }{
		{`{"result":{"retcode":0,"stdout":"real"}}`, "completed"},
		{`{"result":{"retcode":2,"stderr":"error"}}`, "failed"},
		{`{"status":"failed","result":{"retcode":0}}`, "failed"},
		{`{"status":"running"}`, "running"},
		{`{"result":{"stdout":"not proof of success"}}`, "queued"},
		{`{"result":{"return":[{"host":{"a":{"result":true},"b":{"result":null}}}]}}`, "pending"},
		{`{"result":{"return":[{"host":{"a":{"result":true},"b":{"result":false}}}]}}`, "failed"},
	} {
		var detail map[string]any
		_ = json.Unmarshal([]byte(test.input), &detail)
		if got := patchRunStatus(detail); got != test.want {
			t.Errorf("%s: got %s want %s", test.input, got, test.want)
		}
	}
}

func TestQueuePatchRunRecordsPreflightFailure(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	// Missing integration fails before any remote execution.
	server.salt = nil
	c, _ := newTestContext(http.MethodPost, "/patch/run", newTestClaims("super_admin", "user-1", "entity-1"))
	capture := &capturedPatchReport{}
	mock.ExpectQuery(`INSERT INTO asset_history`).WithArgs("asset-1", "user-1", "patch_run", capture).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("history-1"))
	_, err := server.queuePatchRun(c, dbAsset{ID: "asset-1", EntityID: "entity-1", SaltMinionID: "host", MaintenanceUntil: time.Now().Add(time.Hour).Format(time.RFC3339)}, "system-update", "", "")
	if err == nil {
		t.Fatal("expected integration error")
	}
	var detail map[string]any
	if err := json.Unmarshal([]byte(capture.payload), &detail); err != nil {
		t.Fatal(err)
	}
	if detail["status"] != "failed" || detail["error"] == nil || detail["result"] != nil {
		t.Fatalf("incorrect history: %v", detail)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestQueuePatchRunPingDoesNotExecuteCommandOrState(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	calls := 0
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		calls++
		if r.Form.Get("fun") != "test.ping" {
			t.Errorf("unexpected Salt function %q", r.Form.Get("fun"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"return":[{"host":true}]}`)
	}))
	defer peer.Close()
	server.salt = saltstack.NewClient(peer.URL, "", "test", "test", "file", "glob")
	context, _ := newTestContext(http.MethodPost, "/patch/run", newTestClaims("super_admin", "user-1", "entity-1"))
	mock.ExpectQuery(`INSERT INTO asset_history`).WithArgs("asset-1", "user-1", "patch_run", sqlmock.AnyArg()).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("history-1"))
	result, err := server.queuePatchRun(context, dbAsset{ID: "asset-1", EntityID: "entity-1", SaltMinionID: "host"}, "test.ping", "", "")
	if err != nil || result["status"] != "completed" || result["function"] != "test.ping" || calls != 1 {
		t.Fatalf("unexpected ping result: %v, error %v, calls %d", result, err, calls)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPatchBatchPingRejectsShellAndStateArguments(t *testing.T) {
	for _, field := range []string{"command", "state"} {
		server, mock, cleanup := newTestServer(t)
		context, recorder := newTestContext(http.MethodPost, "/patch/batch", newTestClaims("super_admin", "user-1", "entity-1"))
		context.Request.Header.Set("Content-Type", "application/json")
		context.Request.Body = io.NopCloser(strings.NewReader(`{"targetMode":"system","systemId":"host","action":"test.ping","` + field + `":"unexpected"}`))
		server.runPatchBatch(context)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("expected rejected ping arguments, got %d", recorder.Code)
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
		cleanup()
	}
}

func TestQueuePatchRunRecordsRawStateFailure(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		w.Header().Set("Content-Type", "application/json")
		if r.Form.Get("fun") == "test.ping" {
			_, _ = io.WriteString(w, `{"return":[{"host":true}]}`)
			return
		}
		_, _ = io.WriteString(w, `{"return":[{"host":{"pkg_|-update":{"result":false,"comment":"partial failure","changes":{"openssl":{"old":"1","new":"2"}},"stdout":"recorded output","stderr":"recorded error","retcode":7}}}]}`)
	}))
	defer peer.Close()
	server.salt = saltstack.NewClient(peer.URL, "", "test", "test", "file", "glob")
	c, _ := newTestContext(http.MethodPost, "/patch/run", newTestClaims("super_admin", "user-1", "entity-1"))
	capture := &capturedPatchReport{}
	mock.ExpectQuery(`INSERT INTO asset_history`).WithArgs("asset-1", "user-1", "patch_run", capture).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("history-1"))
	result, err := server.queuePatchRun(c, dbAsset{ID: "asset-1", EntityID: "entity-1", SaltMinionID: "host", MaintenanceUntil: time.Now().Add(time.Hour).Format(time.RFC3339)}, "custom-state", "patch.run", "")
	if err == nil || result["historyRecorded"] != true {
		t.Fatalf("expected recorded failure: %v %v", result, err)
	}
	for _, fragment := range []string{`"status":"failed"`, `"state":"patch.run"`, "recorded output", "recorded error", `"retcode":7`, `"old":"1"`, `"new":"2"`} {
		if !strings.Contains(capture.payload, fragment) {
			t.Fatalf("history lost %q: %s", fragment, capture.payload)
		}
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
