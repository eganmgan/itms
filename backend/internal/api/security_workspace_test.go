package api

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestNormalizeAlertsDashboardSourceSupportsCVEDetector(t *testing.T) {
	for _, source := range []string{"cve", "CVE"} {
		if got := normalizeAlertsDashboardSource(source); got != "cve" {
			t.Fatalf("normalizeAlertsDashboardSource(%q) = %q, want cve", source, got)
		}
	}
	if label := alertsDashboardModuleLabel("cve"); label != "CVE Detector" {
		t.Fatalf("alertsDashboardModuleLabel(cve) = %q, want CVE Detector", label)
	}
}

func TestCreateSecurityAutomationPersistsEntityScopedDraft(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	claims := newTestClaims("it_team", "user-1", "entity-1")
	context, recorder := newTestContext(http.MethodPost, "/api/security/automations", claims)
	context.Request.Body = io.NopCloser(strings.NewReader(`{"name":"cve-remediation","source":"cve","kind":"sh","content":"apt-get upgrade -y"}`))
	context.Request.Header.Set("Content-Type", "application/json")

	mock.ExpectQuery(`INSERT INTO security_automations`).
		WithArgs("entity-1", "user-1", "cve-remediation", "cve", "sh", "apt-get upgrade -y", "").
		WillReturnRows(sqlmock.NewRows([]string{"id", "created_at"}).AddRow("automation-1", time.Now()))

	server.createSecurityAutomation(context)

	if recorder.Code != http.StatusCreated || !strings.Contains(recorder.Body.String(), `"source":"cve"`) {
		t.Fatalf("unexpected response %d: %s", recorder.Code, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
