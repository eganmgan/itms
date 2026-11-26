package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
)

func TestWatchdogDatabaseFailure(t *testing.T) {
	database, mock, err := sqlmock.New(sqlmock.MonitorPingsOption(true))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	mock.ExpectPing().WillReturnError(errors.New("private database credential"))
	server := &apiServer{db: database}
	report := server.collectWatchdog(context.Background())
	raw, _ := json.Marshal(report)
	if report.Status != "error" || strings.Contains(string(raw), "private database credential") {
		t.Fatalf("unexpected report: %s", raw)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestWatchdogRecordedFailures(t *testing.T) {
	database, mock, err := sqlmock.New(sqlmock.MonitorPingsOption(true))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	mock.ExpectPing()
	mock.ExpectQuery("SELECT COUNT.*FROM assets").WillReturnRows(sqlmock.NewRows([]string{"total", "stale", "unknown", "unlinked"}).AddRow(3, 1, 1, 0))
	mock.ExpectQuery("SELECT al.source.*LIMIT 100").WillReturnRows(sqlmock.NewRows([]string{"source", "device", "tag", "count"}).AddRow("terminal", adminTestAsset, "SPARE", 2))
	server := &apiServer{db: database}
	server.config.SaltAPIBaseURL = "http://private.example"
	server.config.SaltAPIToken = "never-expose-this"
	report := server.collectWatchdog(context.Background())
	raw, _ := json.Marshal(report)
	if report.Status != "warning" || strings.Contains(string(raw), "never-expose") || strings.Contains(string(raw), "private.example") {
		t.Fatalf("unexpected report: %s", raw)
	}
	checks := make(map[string]watchdogCheck)
	for _, check := range report.Checks {
		checks[check.ID] = check
	}
	if checks["salt"].Status != "unknown" || checks["alert-1"].Name != "SSH" || checks["alert-1"].Href != "/devices/"+adminTestAsset+"/alerts" {
		t.Fatalf("incorrect evidence: %s", raw)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestWatchdogRoleBoundary(t *testing.T) {
	for _, role := range []string{"", "employee", "auditor", "it_team", "admin", "SUPER_ADMIN", "super_admin"} {
		t.Run(role, func(t *testing.T) {
			mock, recorder, router, request, cleanup := adminRoute(t, role, "GET", "/api/admin/watchdog", "")
			defer cleanup()
			status := http.StatusForbidden
			if role == "" {
				status = http.StatusUnauthorized
			} else if role == "admin" || role == "super_admin" {
				status = http.StatusOK
				mock.ExpectQuery("SELECT COUNT.*FROM assets").WillReturnRows(sqlmock.NewRows([]string{"total", "stale", "unknown", "unlinked"}).AddRow(0, 0, 0, 0))
				mock.ExpectQuery("SELECT al.source.*LIMIT 100").WillReturnRows(sqlmock.NewRows([]string{"source", "device", "tag", "count"}))
			}
			router.ServeHTTP(recorder, request)
			assertRouteResult(t, mock, recorder, status, "watchdog authorization")
			if (role == "admin" || role == "super_admin") && recorder.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("watchdog report must not be cached by the browser")
			}
		})
	}
}

func TestWatchdogLifecycleAndStaleness(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	watchdog := &Watchdog{}
	collected := make(chan struct{}, 2)
	finished := make(chan struct{})
	go func() {
		watchdog.run(ctx, time.Millisecond, func(context.Context) watchdogReport {
			select {
			case collected <- struct{}{}:
			default:
			}
			return watchdogReport{CheckedAt: time.Now(), Status: "ok", Checks: []watchdogCheck{}}
		})
		close(finished)
	}()
	for range 2 {
		select {
		case <-collected:
		case <-time.After(time.Second):
			t.Fatal("watchdog did not collect periodically")
		}
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("watchdog did not stop")
	}
	watchdog.report.CheckedAt = time.Now().Add(-3 * time.Minute)
	if report := watchdog.snapshot(); report.Status != "error" || len(report.Checks) != 1 {
		t.Fatal("stale monitoring must not appear healthy")
	}
	if len(watchdog.report.Checks) != 0 {
		t.Fatal("snapshot mutated the stored report")
	}
}

func TestWatchdogHTTPFailuresAreBoundedAndSanitized(t *testing.T) {
	watchdog := &Watchdog{report: watchdogReport{CheckedAt: time.Now(), Status: "ok", Checks: []watchdogCheck{}}}
	router := gin.New()
	router.Use(watchdog.recordHTTP)
	router.GET("/api/assets/:id", func(ctx *gin.Context) { ctx.String(502, "private upstream credential") })
	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/assets/private-device?token=secret", nil))
	report := watchdog.snapshot()
	raw, _ := json.Marshal(report)
	if report.Status != "error" || len(report.Checks) != 1 || !strings.Contains(string(raw), "/api/assets/:id") || strings.Contains(string(raw), "private") || strings.Contains(string(raw), "secret") {
		t.Fatalf("unsafe HTTP report: %s", raw)
	}
	for index := range 60 {
		path := fmt.Sprintf("/api/failure-%d", index)
		router.GET(path, func(ctx *gin.Context) { ctx.Status(500) })
		router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", path, nil))
	}
	if len(watchdog.failures) != 50 {
		t.Fatal("HTTP error memory must be bounded")
	}
}
