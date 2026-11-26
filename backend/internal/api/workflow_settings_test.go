package api

import (
	"fmt"
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestNormalizeWorkflowSettingsDeduplicatesExactWorkflowRoutes(t *testing.T) {
	settings := normalizeWorkflowSettings(workflowSettings{
		RequestTypeRoutes: []workflowRoute{
			{Match: "  Hardware  Request ", AssigneeID: "owner-1"},
			{Match: "hardware request", AssigneeID: "owner-1"},
			{Match: "hardware request", AssigneeID: "owner-2"},
			{Match: "   ", AssigneeID: "owner-3"},
			{Match: "vpn", AssigneeID: "   "},
		},
	})

	if len(settings.RequestTypeRoutes) != 2 {
		t.Fatalf("request type route count = %d, want 2", len(settings.RequestTypeRoutes))
	}
	if settings.RequestTypeRoutes[0] != (workflowRoute{Match: "hardware request", AssigneeID: "owner-1"}) {
		t.Fatalf("first request type route = %+v, want normalized owner-1 route", settings.RequestTypeRoutes[0])
	}
	if settings.RequestTypeRoutes[1] != (workflowRoute{Match: "hardware request", AssigneeID: "owner-2"}) {
		t.Fatalf("second request type route = %+v, want distinct owner-2 route", settings.RequestTypeRoutes[1])
	}
}

func TestChatAssignmentRulesSupportOnlineIT(t *testing.T) {
	settings := normalizeWorkflowSettings(workflowSettings{ChatSubjectRoutes: []workflowRoute{
		{Match: " Software Installation ", OnlineIT: true},
		{Match: "software installation", OnlineIT: true},
		{Match: "laptop issue", AssigneeID: "rakshith-id"},
		{Match: "software issue", AssigneeID: "gani-id"},
	}})
	if len(settings.ChatSubjectRoutes) != 3 || !settings.ChatSubjectRoutes[0].OnlineIT {
		t.Fatalf("online rule lost or duplicated: %+v", settings.ChatSubjectRoutes)
	}
	if err := validateChatAssignmentRules(settings.ChatSubjectRoutes); err != nil {
		t.Fatal(err)
	}
	for _, route := range []workflowRoute{{Match: "software"}, {Match: "software", OnlineIT: true, AssigneeID: "person"}} {
		if validateChatAssignmentRules([]workflowRoute{route}) == nil {
			t.Fatalf("invalid assignment accepted: %+v", route)
		}
	}
}

func TestResolveOnlineChatAssignmentUsesPresenceAndEntityScope(t *testing.T) {
	for _, available := range []bool{true, false} {
		t.Run(fmt.Sprint(available), func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			expectWorkflowSettingsLookup(mock, `{"chatAutoRouteEnabled":true,"chatSubjectRoutes":[{"match":"software installation","onlineIT":true}],"chatFallbackAssigneeId":"offline-person"}`)
			rows := sqlmock.NewRows([]string{"id"})
			if available {
				rows.AddRow("online-person")
			}
			mock.ExpectQuery(`SELECT u.id FROM users u[\s\S]*chat_agent_presence[\s\S]*INTERVAL '90 seconds'[\s\S]*user_entity_access[\s\S]*COUNT\(\*\)[\s\S]*LIMIT 1`).WithArgs("entity-1", sqlmock.AnyArg()).WillReturnRows(rows)
			id, err := server.resolveChatRouting("Software Installation help", "entity-1", true)
			if err != nil {
				t.Fatal(err)
			}
			if available && id != "online-person" || !available && id != "" {
				t.Fatalf("unexpected assignment %q", id)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestChatRoutingDefaultsToOneScopedOnlineStaffMember(t *testing.T) {
	for _, available := range []bool{true, false} {
		t.Run(fmt.Sprint(available), func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			expectWorkflowSettingsLookup(mock, `{"chatAutoRouteEnabled":true,"chatMemberIds":["agent-1"]}`)
			rows := sqlmock.NewRows([]string{"id"})
			if available {
				rows.AddRow("agent-1")
			}
			mock.ExpectQuery(`SELECT u.id FROM users u[\s\S]*r.name IN \('it_team', 'super_admin', 'admin'\)[\s\S]*INTERVAL '90 seconds'[\s\S]*r.name = 'super_admin' OR u.entity_id[\s\S]*user_entity_access[\s\S]*cardinality[\s\S]*COUNT\(\*\)[\s\S]*LIMIT 1`).WithArgs("entity-1", sqlmock.AnyArg()).WillReturnRows(rows)
			id, err := server.resolveChatRouting("General support", "entity-1", true)
			if err != nil || available && id != "agent-1" || !available && id != "" {
				t.Fatalf("assignment = %q, error = %v", id, err)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestChatOnlineFallbackPreservesDisabledRoutingAndOtherChannels(t *testing.T) {
	for _, scenario := range []struct {
		name     string
		settings string
		support  bool
	}{
		{"disabled routing", `{"chatAutoRouteEnabled":false}`, true},
		{"non-support channel", `{"chatAutoRouteEnabled":true}`, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			expectWorkflowSettingsLookup(mock, scenario.settings)
			id, err := server.resolveChatRouting("General discussion", "entity-1", scenario.support)
			if err != nil || id != "" {
				t.Fatalf("assignment = %q, error = %v", id, err)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestConfiguredChatOwnerIDsReturnsConfiguredMembers(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()

	expectWorkflowSettingsLookup(mock, `{"chatMemberIds":["member-1","member-2"]}`)

	memberIDs, err := server.configuredChatOwnerIDs()
	if err != nil {
		t.Fatalf("configuredChatOwnerIDs error: %v", err)
	}
	if len(memberIDs) != 2 || memberIDs[0] != "member-1" || memberIDs[1] != "member-2" {
		t.Fatalf("configuredChatOwnerIDs = %+v, want configured member ids", memberIDs)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

func TestConfiguredChatOwnerIDsFallsBackToActivePrivilegedUsers(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()

	expectWorkflowSettingsLookup(mock, `{}`)
	mock.ExpectQuery(regexp.QuoteMeta(`
		SELECT u.id
		FROM users u
		JOIN roles r ON r.id = u.role_id
		WHERE u.is_active = TRUE AND r.name IN ('admin', 'super_admin', 'it_team')
		ORDER BY CASE WHEN r.name = 'it_team' THEN 0 ELSE 1 END, u.full_name ASC
	`)).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("it-owner-1").AddRow("super-admin-1"))

	memberIDs, err := server.configuredChatOwnerIDs()
	if err != nil {
		t.Fatalf("configuredChatOwnerIDs error: %v", err)
	}
	if len(memberIDs) != 2 || memberIDs[0] != "it-owner-1" || memberIDs[1] != "super-admin-1" {
		t.Fatalf("configuredChatOwnerIDs = %+v, want ordered privileged ids", memberIDs)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

func TestValidateTicketAssigneeRejectsIDOutsideConfiguredList(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()

	expectWorkflowSettingsLookup(mock, `{"ticketAssigneeIds":["owner-1"]}`)

	err := server.validateTicketAssignee("owner-2")
	if err == nil || !strings.Contains(err.Error(), "is not enabled in ticket settings") {
		t.Fatalf("validateTicketAssignee error = %v, want ticket-settings membership error", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

func TestValidateTicketAssigneeAllowsActiveUserWhenUnconfigured(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()

	expectWorkflowSettingsLookup(mock, `{}`)
	expectActiveWorkflowUserLookup(mock, "owner-1", "employee", true)

	err := server.validateTicketAssignee("owner-1")
	if err != nil {
		t.Fatalf("validateTicketAssignee error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

func TestValidateChatMemberAssigneeRejectsIDOutsideConfiguredList(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()

	expectWorkflowSettingsLookup(mock, `{"chatMemberIds":["member-1"]}`)

	err := server.validateChatMemberAssignee("member-2")
	if err == nil || !strings.Contains(err.Error(), "is not enabled in chat member settings") {
		t.Fatalf("validateChatMemberAssignee error = %v, want chat-member membership error", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

func TestValidateChatMemberAssigneeAllowsITMemberWhenUnconfigured(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()

	expectWorkflowSettingsLookup(mock, `{}`)
	expectActiveWorkflowUserLookup(mock, "member-1", "it_team", true)

	err := server.validateChatMemberAssignee("member-1")
	if err != nil {
		t.Fatalf("validateChatMemberAssignee error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

func TestValidateChatMemberAssigneeRejectsNonITMemberWhenUnconfigured(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()

	expectWorkflowSettingsLookup(mock, `{}`)
	expectActiveWorkflowUserLookup(mock, "member-1", "employee", true)

	err := server.validateChatMemberAssignee("member-1")
	if err == nil || !strings.Contains(err.Error(), "must be IT team or super admin") {
		t.Fatalf("validateChatMemberAssignee error = %v, want IT role restriction", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

func TestCreateSupportChannelForEmployeeUsesConfiguredChatOwners(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()

	claims := newTestClaims("employee", "employee-1", "entity-1")
	claims.Name = "Employee One"

	mock.ExpectBegin()
	expectWorkflowSettingsLookup(mock, `{"chatMemberIds":["owner-1","owner-2"]}`)
	mock.ExpectQuery(regexp.QuoteMeta(`
		INSERT INTO chat_channels (name, kind, created_by, primary_owner_id)
		VALUES ($1, 'support', $2::uuid, NULLIF($3, '')::uuid)
		RETURNING id
	`)).WithArgs("Support - Employee One", "employee-1", "owner-1").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("channel-1"))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO chat_members (channel_id, user_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`)).
		WithArgs("channel-1", "employee-1").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO chat_members (channel_id, user_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`)).
		WithArgs("channel-1", "owner-1").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO chat_members (channel_id, user_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`)).
		WithArgs("channel-1", "owner-2").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	err := server.createSupportChannelForEmployee(claims)
	if err != nil {
		t.Fatalf("createSupportChannelForEmployee error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

func TestCreateOperationsChannelUsesConfiguredChatOwners(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()

	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(`
		INSERT INTO chat_channels (name, kind, created_by, primary_owner_id)
		VALUES ('IT Operations', 'operations', $1::uuid, $1::uuid)
		RETURNING id
	`)).WithArgs("owner-1").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("channel-ops-1"))
	expectWorkflowSettingsLookup(mock, `{"chatMemberIds":["owner-1","owner-2"]}`)
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO chat_members (channel_id, user_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`)).
		WithArgs("channel-ops-1", "owner-1").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO chat_members (channel_id, user_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`)).
		WithArgs("channel-ops-1", "owner-2").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	err := server.createOperationsChannel("owner-1")
	if err != nil {
		t.Fatalf("createOperationsChannel error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

func TestCreateSupportChannelForEmployeeFallsBackToPrivilegedOwners(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()

	claims := newTestClaims("employee", "employee-1", "entity-1")
	claims.Name = "Employee One"

	mock.ExpectBegin()
	expectWorkflowSettingsLookup(mock, `{}`)
	mock.ExpectQuery(regexp.QuoteMeta(`
		SELECT u.id
		FROM users u
		JOIN roles r ON r.id = u.role_id
		WHERE u.is_active = TRUE AND r.name IN ('admin', 'super_admin', 'it_team')
		ORDER BY CASE WHEN r.name = 'it_team' THEN 0 ELSE 1 END, u.full_name ASC
	`)).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("it-owner-1").AddRow("super-admin-1"))
	mock.ExpectQuery(regexp.QuoteMeta(`
		INSERT INTO chat_channels (name, kind, created_by, primary_owner_id)
		VALUES ($1, 'support', $2::uuid, NULLIF($3, '')::uuid)
		RETURNING id
	`)).WithArgs("Support - Employee One", "employee-1", "it-owner-1").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("channel-fallback-1"))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO chat_members (channel_id, user_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`)).
		WithArgs("channel-fallback-1", "employee-1").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO chat_members (channel_id, user_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`)).
		WithArgs("channel-fallback-1", "it-owner-1").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO chat_members (channel_id, user_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`)).
		WithArgs("channel-fallback-1", "super-admin-1").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	err := server.createSupportChannelForEmployee(claims)
	if err != nil {
		t.Fatalf("createSupportChannelForEmployee error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}