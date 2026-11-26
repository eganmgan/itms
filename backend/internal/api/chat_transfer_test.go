package api

import (
	"errors"
	"net/http"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestTransferSupportChat(t *testing.T) {
	const chat = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const owner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	for _, tc := range []struct {
		name     string
		member   bool
		status   string
		eligible bool
		want     int
	}{
		{"transfers to online agent", true, "open", true, http.StatusOK},
		{"rejects non-member", false, "open", true, http.StatusForbidden},
		{"rejects closed chat", true, "closed", true, http.StatusConflict},
		{"rejects offline agent", true, "open", false, http.StatusConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "it_team", "user-1", "entity-1", http.MethodPut, "/api/chat/channels/"+chat+"/transfer", `{"ownerId":"`+owner+`"}`)
			defer cleanup()
			expectWorkflowSettingsLookup(mock, `{}`)
			mock.ExpectBegin()
			mock.ExpectQuery(`SELECT c.status, c.kind, COALESCE`).WithArgs(chat, "user-1").
				WillReturnRows(sqlmock.NewRows([]string{"status", "kind", "entity", "member"}).AddRow(tc.status, "support", "entity-1", tc.member))
			if tc.member && tc.status == "open" {
				mock.ExpectQuery(`SELECT EXISTS`).WithArgs(owner, "entity-1").WillReturnRows(sqlmock.NewRows([]string{"eligible"}).AddRow(tc.eligible))
				if tc.eligible {
					mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO chat_members (channel_id, user_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`)).WithArgs(chat, owner).WillReturnResult(sqlmock.NewResult(0, 1))
					mock.ExpectExec(`UPDATE chat_channels SET primary_owner_id`).WithArgs(chat, owner).WillReturnResult(sqlmock.NewResult(0, 1))
					mock.ExpectCommit()
					expectAuditInsert(mock, "user-1", "entity-1", "chat_channel_owner_updated", "chat_channel", chat, `{"ownerId":"`+owner+`"}`)
				}

			}
			if tc.want != http.StatusOK {
				mock.ExpectRollback()
			}
			router.ServeHTTP(recorder, request)
			assertRouteResult(t, mock, recorder, tc.want, tc.name)
		})
	}
}

func TestTransferSupportChatRollsBackOnUpdateFailure(t *testing.T) {
	const chat = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const owner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "it_team", "user-1", "entity-1", http.MethodPut, "/api/chat/channels/"+chat+"/transfer", `{"ownerId":"`+owner+`"}`)
	defer cleanup()
	expectWorkflowSettingsLookup(mock, `{}`)
	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT c.status, c.kind, COALESCE`).WithArgs(chat, "user-1").
		WillReturnRows(sqlmock.NewRows([]string{"status", "kind", "entity", "member"}).AddRow("open", "support", "entity-1", true))
	mock.ExpectQuery(`SELECT EXISTS`).WithArgs(owner, "entity-1").WillReturnRows(sqlmock.NewRows([]string{"eligible"}).AddRow(true))
	mock.ExpectExec(`INSERT INTO chat_members`).WithArgs(chat, owner).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`UPDATE chat_channels SET primary_owner_id`).WithArgs(chat, owner).WillReturnError(errors.New("update failed"))
	mock.ExpectRollback()
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusInternalServerError, "failed update")
}

func TestTransferSupportChatRejectsEmployee(t *testing.T) {
	const chat = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const owner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "employee", "user-1", "entity-1", http.MethodPut, "/api/chat/channels/"+chat+"/transfer", `{"ownerId":"`+owner+`"}`)
	defer cleanup()
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusForbidden, "employee")
}

func TestTransferSupportChatRejectsUnconfiguredAgent(t *testing.T) {
	const chat = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const owner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	mock, recorder, router, request, cleanup := newRoleRouteRequest(t, "it_team", "user-1", "entity-1", http.MethodPut, "/api/chat/channels/"+chat+"/transfer", `{"ownerId":"`+owner+`"}`)
	defer cleanup()
	expectWorkflowSettingsLookup(mock, `{"chatMemberIds":["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]}`)
	router.ServeHTTP(recorder, request)
	assertRouteResult(t, mock, recorder, http.StatusConflict, "unconfigured agent")
}
