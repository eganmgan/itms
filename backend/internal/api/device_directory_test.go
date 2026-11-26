package api

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"

	"itms/backend/internal/app"
	"itms/backend/internal/platform/authn"
)

func TestListDeviceDirectoryReturnsRealEmptyInventory(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	claims := newTestClaims("super_admin", "user-1", "entity-1")
	context, recorder := newTestContext(http.MethodGet, "/api/devices/directory", claims)

	mock.ExpectQuery(`SELECT u\.id::text, u\.full_name`).
		WithArgs("entity-1", "user-1").
		WillReturnRows(sqlmock.NewRows([]string{"id", "full_name", "email", "emp_id", "dept_id", "department", "location_id", "location", "asset_count", "new_count", "ungrouped_count", "flagged_count", "status", "primary_asset_id", "assets"}).
			AddRow("user-1", "IT Admin", "admin@example.com", "EMP-1", "dept-1", "IT", "location-1", "HQ", 1, 0, 0, 0, "online", "asset-1", []byte(`[{"id":"asset-1","name":"Admin Laptop","hostname":"it-admin-01","assetTag":"IT-001","category":"Laptop","status":"online"}]`)))
	mock.ExpectQuery(`SELECT g\.id::text, g\.name, COUNT\(a\.id\)::int`).
		WithArgs("entity-1", "user-1").
		WillReturnRows(sqlmock.NewRows([]string{"id", "name", "device_count"}).AddRow("dept-1", "IT", 0))
	mock.ExpectQuery(`SELECT g\.id::text, g\.full_name, COUNT\(a\.id\)::int`).
		WithArgs("entity-1", "user-1").
		WillReturnRows(sqlmock.NewRows([]string{"id", "name", "device_count"}).AddRow("location-1", "HQ", 0))
	mock.ExpectQuery(`SELECT COUNT\(\*\)::int,`).
		WithArgs("entity-1", "user-1").
		WillReturnRows(sqlmock.NewRows([]string{"all", "new", "ungrouped", "flagged"}).AddRow(0, 0, 0, 0))

	server.listDeviceDirectory(context)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	for _, expected := range []string{`"all":0`, `"fullName":"IT Admin"`, `"departmentName":"IT"`, `"branchName":"HQ"`, `"assets":[{"id":"asset-1"`, `"hostname":"it-admin-01"`} {
		if !strings.Contains(body, expected) {
			t.Fatalf("response missing %s: %s", expected, body)
		}
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestApplyDeviceDirectoryConnectivityUsesSaltForManagedAssets(t *testing.T) {
	users := []deviceDirectoryUser{
		{Status: "offline", Assets: []deviceDirectoryAsset{{ID: "asset-1", Status: "offline", SaltMinionID: "connected"}}},
		{Status: "online", Assets: []deviceDirectoryAsset{{ID: "asset-2", Status: "online", SaltMinionID: "not-responding"}}},
		{Status: "online", Assets: []deviceDirectoryAsset{{ID: "asset-3", Status: "online"}}},
		{Status: "online"},
	}

	applyDeviceDirectoryConnectivity(users, map[string]bool{"connected": true})

	if users[0].Status != "online" || users[0].Assets[0].Status != "online" {
		t.Fatalf("connected Salt asset should be online: %#v", users[0])
	}
	if users[1].Status != "offline" || users[1].Assets[0].Status != "offline" {
		t.Fatalf("non-responding Salt asset should be offline: %#v", users[1])
	}
	if users[2].Status != "online" || users[2].Assets[0].Status != "online" {
		t.Fatalf("unmanaged asset should retain inventory status: %#v", users[2])
	}
	if users[3].Status != "unassigned" {
		t.Fatalf("user without assets should be unassigned: %#v", users[3])
	}
	for _, user := range users {
		for _, asset := range user.Assets {
			if asset.SaltMinionID != "" {
				t.Fatalf("Salt minion ID should be cleared from responses: %#v", asset)
			}
		}
	}
}

func TestCreateDeviceInstallCommandUsesEnrollmentToken(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	server.config = app.Config{
		PublicServerURL:       "https://itms.example.com",
		InventoryIngestToken:  "must-never-be-returned",
		SSHTerminalPrivateKey: mustGenerateRouterTestPrivateKey(t),
	}
	server.auth = authn.NewManager("test-secret-with-sufficient-length-123", 0)
	expectUserByIDLookup(mock, "target-user", "EMP-9", "Ava O'Neil", "ava@example.com", "entity-1", "employee", true)
	claims := newTestClaims("it_team", "admin-user", "entity-1")
	context, recorder := newTestContext(http.MethodPost, "/api/devices/install-command", claims)
	context.Request.Body = io.NopCloser(strings.NewReader(`{"userId":"target-user","os":"linux"}`))
	context.Request.Header.Set("Content-Type", "application/json")

	server.createDeviceInstallCommand(context)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	for _, expected := range []string{"--enrollment-token", "install-itms-agent.sh", "--require-salt", "--authorized-key", "--install-cve-scanner", "systemctl start itms-openscap-scan.service", "--department-name"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("expected secure full-stack installer command containing %s: %s", expected, body)
		}
	}
	if strings.Contains(body, server.config.InventoryIngestToken) {
		t.Fatalf("response exposed inventory ingest token: %s", body)
	}
	if strings.Contains(body, "--prompt-token") {
		t.Fatalf("response still prompts for inventory token: %s", body)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestCreateDeviceInstallCommandSupportsFedoraAndMacOS(t *testing.T) {
	for _, testCase := range []struct {
		osName        string
		installerName string
	}{
		{osName: "fedora", installerName: "install-itms-agent.sh"},
		{osName: "macos", installerName: "install-itms-agent-macos.sh"},
	} {
		t.Run(testCase.osName, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			server.config = app.Config{
				PublicServerURL:       "https://itms.example.com",
				InventoryIngestToken:  "must-never-be-returned",
				SSHTerminalPrivateKey: mustGenerateRouterTestPrivateKey(t),
			}
			server.auth = authn.NewManager("test-secret-with-sufficient-length-123", 0)
			expectUserByIDLookup(mock, "target-user", "EMP-9", "Ava O'Neil", "ava@example.com", "entity-1", "employee", true)
			claims := newTestClaims("it_team", "admin-user", "entity-1")
			context, recorder := newTestContext(http.MethodPost, "/api/devices/install-command", claims)
			context.Request.Body = io.NopCloser(strings.NewReader(`{"userId":"target-user","os":"` + testCase.osName + `"}`))
			context.Request.Header.Set("Content-Type", "application/json")

			server.createDeviceInstallCommand(context)

			if recorder.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
			}
			body := recorder.Body.String()
			for _, expected := range []string{testCase.installerName, `"os":"` + testCase.osName + `"`, "--enrollment-token", "--authorized-key"} {
				if !strings.Contains(body, expected) {
					t.Fatalf("response missing %s: %s", expected, body)
				}
			}
			if strings.Contains(body, server.config.InventoryIngestToken) {
				t.Fatalf("response exposed inventory ingest token: %s", body)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestExchangeInventoryEnrollmentToken(t *testing.T) {
	server, _, cleanup := newTestServer(t)
	defer cleanup()
	server.config.InventoryIngestToken = "configured-ingest-token"
	server.auth = authn.NewManager("test-secret-with-sufficient-length-123", 0)

	enrollmentToken, err := server.auth.IssueEnrollmentToken("admin-user")
	if err != nil {
		t.Fatalf("IssueEnrollmentToken: %v", err)
	}
	context, recorder := newTestContext(http.MethodPost, "/api/inventory-sync/enroll", nil)
	context.Request.Header.Set("Authorization", "Bearer "+enrollmentToken)
	server.exchangeInventoryEnrollmentToken(context)

	if recorder.Code != http.StatusOK || recorder.Body.String() != server.config.InventoryIngestToken {
		t.Fatalf("unexpected exchange response: status=%d body=%q", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("expected no-store response, got %q", recorder.Header().Get("Cache-Control"))
	}

	accessToken, err := server.auth.IssueToken(authn.UserTokenInput{UserID: "admin-user", EmpID: "EMP-1"})
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	context, recorder = newTestContext(http.MethodPost, "/api/inventory-sync/enroll", nil)
	context.Request.Header.Set("Authorization", "Bearer "+accessToken)
	server.exchangeInventoryEnrollmentToken(context)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected access token rejection, got %d: %s", recorder.Code, recorder.Body.String())
	}
}
