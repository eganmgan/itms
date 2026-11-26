package api

import (
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"itms/backend/internal/platform/authn"
)

func TestLocalAIChatWorkspaceGuidance(t *testing.T) {
	server := &apiServer{}
	for _, test := range []struct {
		message string
		page    string
		want    string
	}{
		{"How do I remove apps from this device?", "Devices", "unused approval ticket"},
		{"Approve an application ticket", "Devices", "super_admin"},
		{"Why only six installed apps?", "Devices", "not the full package inventory"},
		{"How many apps are on my device?", "Devices", "cannot see this device's app list"},
		{"Why is the latest app version unavailable?", "Apps", "not that the app is up to date"},
		{"Restart a service on my device", "Devices", "recorded-only services remain disabled"},
		{"Explain this screen", "Devices / Apps", "Catalog & approvals"},
		{"What can I do here?", "Services", "Chat does not execute service actions"},
		{"Review a security alert", "Apps", "Open Security"},
		{"How do I install an agent?", "Devices", "Install Agent"},
		{"Review a ticket", "Apps", "Employee Requests"},
		{"What are appointments?", "Overview", "I can guide you"},
	} {
		t.Run(test.message, func(t *testing.T) {
			reply := server.localAIChatReply(test.message, test.page, &authn.Claims{Role: "employee"})
			if !strings.Contains(reply, test.want) {
				t.Fatalf("reply %q does not contain %q", reply, test.want)
			}
		})
	}
}

func TestRouterAIChatRoutesRequireAuthentication(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
		for _, invalidToken := range []bool{false, true} {
			name := method + "/anonymous"
			if invalidToken {
				name = method + "/invalid-token"
			}
			t.Run(name, func(t *testing.T) {
				mock, recorder, router, request, cleanup := newAnonymousRouteRequest(t, method, "/api/chat/ai/messages")
				defer cleanup()
				if invalidToken {
					request.Header.Set("Authorization", "Bearer invalid-token")
				}
				router.ServeHTTP(recorder, request)
				assertRouteResult(t, mock, recorder, http.StatusUnauthorized, "AI authentication")
			})
		}
	}
}

func TestRouterListAIChatMessagesScopesHistoryToUserAndEntity(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "employee", "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", http.MethodGet, "/api/chat/ai/messages", "")
	defer cleanup()

	now := time.Date(2026, time.August, 9, 8, 30, 0, 0, time.UTC)
	mock.ExpectQuery(regexp.QuoteMeta(`
		SELECT id::text, role, body, created_at
		FROM (
			SELECT id, role, body, created_at
			FROM ai_chat_messages
			WHERE user_id = $1::uuid
			  AND ($2 = '' OR entity_id = $2::uuid)
			ORDER BY created_at DESC
			LIMIT $3
		) recent
		ORDER BY created_at ASC
	`)).WithArgs("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", aiChatMessageLimit).
		WillReturnRows(sqlmock.NewRows([]string{"id", "role", "body", "created_at"}).AddRow("33333333-3333-3333-3333-333333333333", "assistant", "How can I help?", now))

	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusOK, "list AI chat messages")
}

func TestRouterCreateAIChatMessagePersistsUserAndAssistantMessages(t *testing.T) {
	userID := "11111111-1111-1111-1111-111111111111"
	entityID := "22222222-2222-2222-2222-222222222222"
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "employee", userID, entityID, http.MethodPost, "/api/chat/ai/messages", `{"message":"How do I install an agent?","context":"Devices"}`)
	defer cleanup()

	now := time.Date(2026, time.August, 9, 8, 30, 0, 0, time.UTC)
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(`
		INSERT INTO ai_chat_messages (entity_id, user_id, role, body)
		VALUES (NULLIF($1, '')::uuid, $2::uuid, 'user', $3)
		RETURNING id::text, role, body, created_at
	`)).WithArgs(entityID, userID, "How do I install an agent?").
		WillReturnRows(sqlmock.NewRows([]string{"id", "role", "body", "created_at"}).AddRow("33333333-3333-3333-3333-333333333333", "user", "How do I install an agent?", now))
	mock.ExpectQuery(regexp.QuoteMeta(`
		INSERT INTO ai_chat_messages (entity_id, user_id, role, body)
		VALUES (NULLIF($1, '')::uuid, $2::uuid, 'assistant', $3)
		RETURNING id::text, role, body, created_at
	`)).WithArgs(entityID, userID, sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"id", "role", "body", "created_at"}).AddRow("44444444-4444-4444-4444-444444444444", "assistant", "Use Devices to install the agent.", now))
	mock.ExpectCommit()

	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusCreated, "create AI chat message")
}

func TestRouterCreateAIChatMessageRejectsBlankInput(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "employee", "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", http.MethodPost, "/api/chat/ai/messages", `{"message":"   "}`)
	defer cleanup()

	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusBadRequest, "reject blank AI chat message")
}

func TestRouterClearAIChatMessagesScopesDelete(t *testing.T) {
	userID := "11111111-1111-1111-1111-111111111111"
	entityID := "22222222-2222-2222-2222-222222222222"
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "employee", userID, entityID, http.MethodDelete, "/api/chat/ai/messages", "")
	defer cleanup()

	mock.ExpectExec(regexp.QuoteMeta(`
		DELETE FROM ai_chat_messages
		WHERE user_id = $1::uuid
		  AND ($2 = '' OR entity_id = $2::uuid)
	`)).WithArgs(userID, entityID).WillReturnResult(sqlmock.NewResult(0, 2))

	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusNoContent, "clear AI chat messages")
}
