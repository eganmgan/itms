package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestAddSupportParticipant(t *testing.T) {
	const chat = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const target = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	for _, tc := range []struct {
		name     string
		role     string
		member   bool
		status   string
		eligible bool
		want     int
	}{
		{"employee adds authorized user", "employee", true, "open", true, http.StatusOK},
		{"IT adds authorized user", "it_team", true, "open", true, http.StatusOK},
		{"nonmember forbidden", "employee", false, "open", true, http.StatusForbidden},
		{"closed rejected", "employee", true, "closed", true, http.StatusConflict},
		{"out of scope forbidden", "employee", true, "open", false, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mock, rec, router, req, cleanup := newRoleRouteRequest(t, tc.role, "user-1", "entity-1", http.MethodPost, "/api/chat/channels/"+chat+"/participants", `{"userId":"`+target+`"}`)
			defer cleanup()
			mock.ExpectBegin()
			mock.ExpectQuery(`SELECT c.kind, c.status`).WithArgs(chat, "user-1").WillReturnRows(sqlmock.NewRows([]string{"kind", "status", "member"}).AddRow("support", tc.status, tc.member))
			if tc.member && tc.status == "open" {
				mock.ExpectQuery(`SELECT EXISTS \(SELECT 1 FROM users u`).WithArgs(target, "user-1", tc.role, "entity-1").WillReturnRows(sqlmock.NewRows([]string{"eligible"}).AddRow(tc.eligible))
				if tc.eligible {
					mock.ExpectExec(`INSERT INTO chat_members`).WithArgs(chat, target).WillReturnResult(sqlmock.NewResult(0, 1))
					mock.ExpectCommit()
					expectAuditInsert(mock, "user-1", "entity-1", "chat_participant_added", "chat_channel", chat, `{"added":1,"userId":"`+target+`"}`)
				}
			}
			if tc.want != http.StatusOK {
				mock.ExpectRollback()
			}
			router.ServeHTTP(rec, req)
			assertRouteResult(t, mock, rec, tc.want, tc.name)
		})
	}
}

func TestListSupportParticipants(t *testing.T) {
	const chat = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	for _, allowed := range []bool{false, true} {
		mock, rec, router, req, cleanup := newRoleRouteRequest(t, "employee", "user-1", "entity-1", http.MethodGet, "/api/chat/channels/"+chat+"/participants?page=1", "")
		mock.ExpectQuery(`SELECT EXISTS\(SELECT 1 FROM chat_members`).WithArgs(chat, "user-1").WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(allowed))
		if allowed {
			mock.ExpectQuery(`SELECT u.id::text, u.full_name`).WithArgs(chat, "user-1", "employee", "entity-1", 0, "").WillReturnRows(sqlmock.NewRows([]string{"id", "name", "member"}).AddRow("person", "Person", false).AddRow("user-1", "Self", true))
		}

		router.ServeHTTP(rec, req)
		want := http.StatusForbidden
		if allowed {
			want = http.StatusOK
		}

		assertRouteResult(t, mock, rec, want, "participant list membership")
		if allowed {
			var body struct {
				Items []struct {
					FullName string `json:"fullName"`
					IsMember bool   `json:"isMember"`
				} `json:"items"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || len(body.Items) != 2 || body.Items[0].IsMember || !body.Items[1].IsMember {
				t.Fatalf("unexpected participants: %s (%v)", rec.Body.String(), err)
			}
		}
		cleanup()
	}
}

func TestSearchSupportParticipantsRequiresMembership(t *testing.T) {
	const chat = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	for _, allowed := range []bool{false, true} {
		mock, rec, router, req, cleanup := newRoleRouteRequest(t, "employee", "user-1", "entity-1", http.MethodGet, "/api/chat/channels/"+chat+"/participants?search=Al%25", "")
		mock.ExpectQuery(`SELECT EXISTS\(SELECT 1 FROM chat_members`).WithArgs(chat, "user-1").WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(allowed))
		if allowed {
			mock.ExpectQuery(`(?s)SELECT u.id::text, u.full_name.*u.is_active.*u.entity_id.*strpos\(lower\(u.full_name\), lower\(\$6\)\)`).
				WithArgs(chat, "user-1", "employee", "entity-1", 0, "Al%").
				WillReturnRows(sqlmock.NewRows([]string{"id", "name", "member"}))
		}
		router.ServeHTTP(rec, req)
		want := http.StatusForbidden
		if allowed {
			want = http.StatusOK
		}
		assertRouteResult(t, mock, rec, want, "search participant list membership")
		cleanup()
	}
}

func TestCreateSupportWithParticipants(t *testing.T) {
	const target = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	for _, eligible := range []bool{false, true} {
		mock, rec, router, req, cleanup := newRoleRouteRequest(t, "employee", "employee-1", "entity-1", http.MethodPost, "/api/chat/channels",
			`{"name":"General support","kind":"support","initialMessage":"Hello","supportParticipantIds":["`+target+`"]}`)
		expectWorkflowSettingsLookup(mock, `{"chatAutoCreateEnabled":true}`)
		expectWorkflowSettingsLookup(mock, `{"chatAutoRouteEnabled":false}`)
		mock.ExpectBegin()
		mock.ExpectQuery(`SELECT EXISTS \(SELECT 1 FROM users u`).WithArgs(target, "employee-1", "employee", "entity-1").WillReturnRows(sqlmock.NewRows([]string{"eligible"}).AddRow(eligible))
		if eligible {
			expectChatChannelCreate(mock, "General support", "support", "employee-1", "", "channel-1")
			expectChatMemberInsert(mock, "channel-1", "employee-1", 1)
			expectChatMemberInsert(mock, "channel-1", target, 1)
			expectChatInitialMessageInsert(mock, "channel-1", "employee-1", "Hello")
			mock.ExpectCommit()
			expectAuditInsert(mock, "employee-1", "entity-1", "chat_channel_created", "chat_channel", "channel-1", `{"initialMessage":"Hello","kind":"support","memberIds":null,"name":"General support","primaryOwnerId":null,"routedMemberId":"","supportParticipantIds":["`+target+`"]}`)
		} else {
			mock.ExpectRollback()
		}

		router.ServeHTTP(rec, req)
		want := http.StatusForbidden
		if eligible {
			want = http.StatusCreated
		}
		assertRouteResult(t, mock, rec, want, "create with participants")
		cleanup()
	}
}
