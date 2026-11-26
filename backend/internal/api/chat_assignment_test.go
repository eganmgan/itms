package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestChatAssignmentSettingsPreserveOtherWorkflows(t *testing.T) {
	input := chatAssignmentSettings{Enabled: true, AllowNewChats: true, Routes: []workflowRoute{{Match: "Software Installation", OnlineIT: true}, {Match: "laptop issue", AssigneeID: "person-1"}}}
	payload, _ := json.Marshal(input)
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "super_admin", "user-1", "entity-1", http.MethodPut, "/api/settings/chat", string(payload))
	defer cleanup()
	updatedAt := time.Date(2026, time.September, 30, 12, 0, 0, 0, time.UTC)
	mock.ExpectQuery(`SELECT value, updated_at FROM settings WHERE key = \$1`).WithArgs(workflowSettingsKey).
		WillReturnRows(sqlmock.NewRows([]string{"value", "updated_at"}).AddRow(`{"requestAutoAssignEnabled":true,"patchWindowEnabled":true,"patchWindowStart":"21:00","patchWindowEnd":"05:00"}`, updatedAt))
	expectActiveWorkflowUserLookup(mock, "person-1", "it_team", true)
	expected := defaultWorkflowSettings()
	expected.UpdatedAt = updatedAt.Format(time.RFC3339)
	expected.RequestAutoAssignEnabled = true
	expected.PatchWindowEnabled = true
	expected.PatchWindowStart = "21:00"
	expected.PatchWindowEnd = "05:00"
	expected.ChatAutoRouteEnabled = true
	expected.ChatSubjectRoutes = normalizeWorkflowRoutes(input.Routes)
	saved, _ := json.Marshal(expected)
	mock.ExpectQuery(`INSERT INTO settings`).WithArgs(workflowSettingsKey, string(saved)).WillReturnRows(sqlmock.NewRows([]string{"updated_at"}).AddRow(time.Now()))
	audit, _ := json.Marshal(assignmentSettings(expected))
	expectAuditInsert(mock, "user-1", "entity-1", "settings_changed", "settings", workflowSettingsKey, string(audit))
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusOK, "chat settings save")
}

func TestChatClaimRequiresEligibleAgentAndOnlyUnassignedScopedChannel(t *testing.T) {
	for _, taken := range []bool{false, true} {
		mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "it_team", "agent-1", "entity-1", http.MethodPost, "/api/chat/channels/channel-1/claim", `{}`)
		expectWorkflowSettingsLookup(mock, `{}`)
		expectActiveWorkflowUserLookup(mock, "agent-1", "it_team", true)
		mock.ExpectBegin()
		query := mock.ExpectQuery(`UPDATE chat_channels[\s\S]*primary_owner_id IS NULL[\s\S]*user_entity_access[\s\S]*RETURNING channel.id`).WithArgs("channel-1", "agent-1", "it_team", "entity-1")
		want := http.StatusOK
		if taken {
			query.WillReturnError(sql.ErrNoRows)
			mock.ExpectRollback()
			want = http.StatusConflict
		} else {
			query.WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("channel-1"))
			mock.ExpectExec(`INSERT INTO chat_members`).WithArgs("channel-1", "agent-1").WillReturnResult(sqlmock.NewResult(1, 1))
			mock.ExpectCommit()
			expectAuditInsert(mock, "agent-1", "entity-1", "chat_owner_changed", "chat_channel", "channel-1", `{"primaryOwnerId":"agent-1"}`)
		}
		router.ServeHTTP(recorder, request)
		assertRouteResult(t, mock, recorder, want, "waiting chat claim")
		cleanup()
	}
}

func TestAdminSupportChatAccessPreservesMembershipAndCompanyScope(t *testing.T) {
	t.Run("presence", func(t *testing.T) {
		mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "admin", "agent-1", "entity-1", http.MethodPost, "/api/chat/presence", `{"available":true}`)
		defer cleanup()
		mock.ExpectExec(`INSERT INTO chat_agent_presence`).WithArgs("agent-1").WillReturnResult(sqlmock.NewResult(1, 1))
		router.ServeHTTP(recorder, request)
		assertRouteResult(t, mock, recorder, http.StatusOK, "admin presence")
	})
	t.Run("options", func(t *testing.T) {
		mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "admin", "agent-1", "entity-1", http.MethodGet, "/api/chat/support-options", "")
		defer cleanup()
		expectWorkflowSettingsLookup(mock, `{}`)
		router.ServeHTTP(recorder, request)
		assertRouteResult(t, mock, recorder, http.StatusOK, "admin support options")
	})
	t.Run("nonmember denied", func(t *testing.T) {
		mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "admin", "agent-1", "entity-1", http.MethodPost, "/api/chat/channels/channel-1/messages", `{"body":"hello"}`)
		defer cleanup()
		expectChatMembershipCheck(mock, "channel-1", "agent-1", false)
		router.ServeHTTP(recorder, request)
		assertRouteResult(t, mock, recorder, http.StatusForbidden, "admin membership restriction")
	})
	t.Run("scoped queue", func(t *testing.T) {
		mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "admin", "agent-1", "entity-1", http.MethodGet, "/api/chat/support-queue", "")
		defer cleanup()
		expectWorkflowSettingsLookup(mock, `{}`)
		expectActiveWorkflowUserLookup(mock, "agent-1", "admin", true)
		mock.ExpectQuery(`SELECT channel.id[\s\S]*\$1 = 'super_admin' OR creator.entity_id[\s\S]*user_entity_access`).WithArgs("admin", "entity-1", "agent-1").WillReturnRows(sqlmock.NewRows([]string{"id", "name", "requester"}))
		router.ServeHTTP(recorder, request)
		assertRouteResult(t, mock, recorder, http.StatusOK, "admin scoped queue")
	})
	t.Run("scoped claim", func(t *testing.T) {
		mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "admin", "agent-1", "entity-1", http.MethodPost, "/api/chat/channels/channel-1/claim", `{}`)
		defer cleanup()
		expectWorkflowSettingsLookup(mock, `{}`)
		expectActiveWorkflowUserLookup(mock, "agent-1", "admin", true)
		mock.ExpectBegin()
		mock.ExpectQuery(`UPDATE chat_channels[\s\S]*primary_owner_id IS NULL[\s\S]*\$3 = 'super_admin' OR creator.entity_id[\s\S]*user_entity_access`).WithArgs("channel-1", "agent-1", "admin", "entity-1").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("channel-1"))
		mock.ExpectExec(`INSERT INTO chat_members`).WithArgs("channel-1", "agent-1").WillReturnResult(sqlmock.NewResult(1, 1))
		mock.ExpectCommit()
		expectAuditInsert(mock, "agent-1", "entity-1", "chat_owner_changed", "chat_channel", "channel-1", `{"primaryOwnerId":"agent-1"}`)
		router.ServeHTTP(recorder, request)
		assertRouteResult(t, mock, recorder, http.StatusOK, "admin scoped claim")
	})
}

func TestChatAssignmentSettingsRejectNonAdmins(t *testing.T) {
	for _, role := range []string{"employee", "it_team", "auditor"} {
		for _, method := range []string{http.MethodGet, http.MethodPut} {
			mock, recorder, router, request, cleanup := newRoleRouteRequest(t, role, "user-1", "entity-1", method, "/api/settings/chat", `{}`)
			router.ServeHTTP(recorder, request)
			assertRouteResult(t, mock, recorder, http.StatusForbidden, "chat settings guard")
			cleanup()
		}
	}
}

func TestChatPresenceCannotBeSetByEmployees(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "employee", "user-1", "entity-1", http.MethodPost, "/api/chat/presence", `{"available":true}`)
	defer cleanup()
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusForbidden, "presence guard")
}

func TestChatPresenceUsesAuthenticatedIdentity(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "it_team", "user-1", "entity-1", http.MethodPost, "/api/chat/presence", `{"available":true,"userId":"someone-else"}`)
	defer cleanup()
	mock.ExpectExec(`INSERT INTO chat_agent_presence`).WithArgs("user-1").WillReturnResult(sqlmock.NewResult(1, 1))
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusOK, "presence identity")
}

func TestSupportMessageRequiresChannelMembership(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "employee", "user-1", "entity-1", http.MethodPost, "/api/chat/channels/channel-1/messages", `{"body":"hello"}`)
	defer cleanup()
	expectChatMembershipCheck(mock, "channel-1", "user-1", false)
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusForbidden, "message membership")
}

func TestSupportMessagePersistsAndRejectsClosedChannels(t *testing.T) {
	for _, closed := range []bool{false, true} {
		mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "employee", "user-1", "entity-1", http.MethodPost, "/api/chat/channels/channel-1/messages", `{"body":"hello"}`)
		expectChatMembershipCheck(mock, "channel-1", "user-1", true)
		query := mock.ExpectQuery(`WITH inserted AS`).WithArgs("channel-1", "user-1", "hello")
		want := http.StatusCreated
		if closed {
			query.WillReturnError(sql.ErrNoRows)
			want = http.StatusConflict
		} else {
			query.WillReturnRows(sqlmock.NewRows([]string{"id", "created_at", "name", "kind"}).AddRow("message-1", time.Now(), "Laptop issue", "support"))
		}
		router.ServeHTTP(recorder, request)
		assertRouteResult(t, mock, recorder, want, "message write")
		cleanup()
	}
}
