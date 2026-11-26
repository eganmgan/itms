package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestOnlineChatAgentsUseEntityAndAssignmentScope(t *testing.T) {
	for _, role := range []string{"employee", "it_team", "super_admin", "admin"} {
		t.Run(role, func(t *testing.T) {
			mock, recorder, router, request, cleanup := newRoleRouteRequest(t, role, "user-1", "entity-1", http.MethodGet, "/api/chat/presence/agents", "")
			defer cleanup()
			expectWorkflowSettingsLookup(mock, `{"chatMemberIds":["agent-1"]}`)
			mock.ExpectQuery(`SELECT u.id, u.full_name FROM users u[\s\S]*u.is_active = TRUE AND r.name = 'it_team'[\s\S]*last_seen_at > NOW\(\) - INTERVAL '90 seconds'[\s\S]*user_entity_access[\s\S]*cardinality`).
				WithArgs("entity-1", `{"agent-1"}`).
				WillReturnRows(sqlmock.NewRows([]string{"id", "full_name"}).AddRow("agent-1", "Agent One"))
			router.ServeHTTP(recorder, request)
			assertRouteResult(t, mock, recorder, http.StatusOK, "online agents")
			var response struct {
				Items []struct {
					ID       string `json:"id"`
					FullName string `json:"fullName"`
				} `json:"items"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if len(response.Items) != 1 || response.Items[0].ID != "agent-1" || response.Items[0].FullName != "Agent One" {
				t.Fatalf("unexpected agents: %+v", response.Items)
			}
		})
	}
}

func TestOnlineChatAgentsReturnEmptyList(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "employee", "user-1", "entity-1", http.MethodGet, "/api/chat/presence/agents", "")
	defer cleanup()
	expectWorkflowSettingsLookup(mock, `{}`)
	mock.ExpectQuery(`SELECT u.id, u.full_name FROM users u`).WithArgs("entity-1", "{}").
		WillReturnRows(sqlmock.NewRows([]string{"id", "full_name"}))
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusOK, "empty online agents")
	if recorder.Body.String() != `{"items":[]}` {
		t.Fatalf("unexpected empty response: %s", recorder.Body.String())
	}
}

func TestOnlineChatAgentsRejectUnscopedAndUnauthorizedUsers(t *testing.T) {
	for _, tc := range []struct{ role, entity string }{{"employee", ""}, {"it_team", ""}, {"auditor", "entity-1"}} {
		t.Run(tc.role, func(t *testing.T) {
			mock, recorder, router, request, cleanup := newRoleRouteRequest(t, tc.role, "user-1", tc.entity, http.MethodGet, "/api/chat/presence/agents", "")
			defer cleanup()
			router.ServeHTTP(recorder, request)
			assertRouteResult(t, mock, recorder, http.StatusForbidden, "online agents scope")
		})
	}
}

func TestOnlineChatAgentsReportDatabaseFailure(t *testing.T) {
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "employee", "user-1", "entity-1", http.MethodGet, "/api/chat/presence/agents", "")
	defer cleanup()
	expectWorkflowSettingsLookup(mock, `{}`)
	mock.ExpectQuery(`SELECT u.id, u.full_name FROM users u`).WithArgs("entity-1", sqlmock.AnyArg()).WillReturnError(errors.New("database unavailable"))
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusInternalServerError, "online agents failure")
}
