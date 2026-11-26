package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"itms/backend/internal/integrations/saltstack"
)

func expectApprovalConsumption(mock sqlmock.Sqlmock, action string) {
	mock.ExpectQuery(`SELECT approval.id::text FROM software_ticket_approvals approval`).WithArgs(adminTestAsset, adminTestEntity, softwareTestApplication, "firefox", action, adminTestOther).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(adminTestOther))
	mock.ExpectExec(`UPDATE software_ticket_approvals SET consumed_request_id`).WithArgs(adminTestOther, softwareTestRequest).WillReturnResult(sqlmock.NewResult(0, 1))
}

func TestSoftwareApprovalRoutes(t *testing.T) {
	for _, role := range []string{"employee", "auditor", "Admin", "it_team"} {
		t.Run(role+" cannot approve", func(t *testing.T) {
			mock, router := softwareHandlerHarness(t, role, nil)
			rec := softwareServe(router, "POST", "/api/assets/"+adminTestAsset+"/software-approvals", `{}`)
			assertRouteResult(t, mock, rec, 403, "ticket approval role")
		})
	}
	for _, validTicket := range []bool{true, false} {
		t.Run(map[bool]string{true: "eligible ticket", false: "wrong scope or type or rejected"}[validTicket], func(t *testing.T) {
			mock, router := softwareHandlerHarness(t, "admin", nil)
			mock.ExpectBegin()
			expectSoftwareAsset(mock, "admin", "host-1", "Ubuntu", true)
			mock.ExpectQuery(`FROM application_catalog WHERE id=\$1::uuid AND entity_id=\$2::uuid FOR SHARE`).WithArgs(softwareTestApplication, adminTestEntity).WillReturnRows(softwareApplicationRows(true, "linux"))
			lookup := mock.ExpectQuery(`(?s)SELECT ticket.id::text.*asset.assigned_to=requester.id.*requester.entity_id=\$3::uuid.*lower\(ticket.type\) IN.*ticket.status IN.*FOR SHARE OF ticket, requester`).WithArgs("TKT-123", adminTestAsset, adminTestEntity)
			want := 404
			if validTicket {
				lookup.WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(softwareTestRequest))
				mock.ExpectQuery(`INSERT INTO software_ticket_approvals`).WithArgs(softwareTestRequest, "TKT-123", adminTestAsset, adminTestEntity, softwareTestApplication, "firefox", "install", adminTestUser).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(adminTestOther))
				mock.ExpectExec(`INSERT INTO audit_log`).WithArgs(adminTestUser, adminTestEntity, adminTestAsset, sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
				mock.ExpectCommit()
				want = 201
			} else {
				lookup.WillReturnRows(sqlmock.NewRows([]string{"id"}))
				mock.ExpectRollback()
			}
			rec := softwareServe(router, "POST", "/api/assets/"+adminTestAsset+"/software-approvals", `{"ticketNumber":"TKT-123","applicationId":"`+softwareTestApplication+`","action":"install","confirmed":true}`)
			assertRouteResult(t, mock, rec, want, "scoped ticket approval")
		})
	}
}

func TestSoftwareDispatchRequiresApproval(t *testing.T) {
	for _, action := range []string{"install", "remove"} {
		for _, approvalID := range []string{adminTestOther, ""} {
			t.Run(action+approvalID, func(t *testing.T) {
				calls := 0
				remote := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls++ }))
				defer remote.Close()
				mock, router := softwareHandlerHarness(t, "it_team", saltstack.NewClient(remote.URL, "fixture", "", "", "", "glob"))
				mock.ExpectBegin()
				expectSoftwareAsset(mock, "it_team", "host-1", "Ubuntu", true)
				path, body := "/software-install", softwareTestBody
				if action == "install" {
					expectSoftwarePrevious(mock, softwareEmptyRequests())
				} else {
					expectManagementPrevious(mock)
					path, body = "/management-actions", managementTestSoftwareBody
				}
				mock.ExpectQuery(`FROM application_catalog WHERE id=\$1::uuid AND entity_id=\$2::uuid FOR SHARE`).WithArgs(softwareTestApplication, adminTestEntity).WillReturnRows(softwareApplicationRows(true, "linux"))
				if action == "install" {
					mock.ExpectQuery(`INSERT INTO software_install_requests`).WillReturnRows(softwareRequestRows("unknown", "dispatch_unconfirmed", adminTestUser, adminTestAsset, softwareTestApplication))
				} else {
					mock.ExpectQuery(`INSERT INTO endpoint_management_requests`).WillReturnRows(managementRows(managementRecord("software", "unknown", "dispatch_unconfirmed")))
				}
				mock.ExpectQuery(`SELECT approval.id::text FROM software_ticket_approvals approval`).WithArgs(adminTestAsset, adminTestEntity, softwareTestApplication, "firefox", action, approvalID).WillReturnRows(sqlmock.NewRows([]string{"id"}))
				mock.ExpectRollback()
				if approvalID == "" {
					body = strings.Replace(body, `,"approvalId":"`+adminTestOther+`"`, "", 1)
				}
				rec := softwareServe(router, "POST", "/api/assets/"+adminTestAsset+path, body)
				assertRouteResult(t, mock, rec, 409, "approval must precede dispatch")
				if calls != 0 {
					t.Fatal("unapproved package action dispatched")
				}
			})
		}
	}
}

func TestSoftwareApprovalConsumption(t *testing.T) {
	for _, action := range []string{"install", "remove"} {
		for _, available := range []bool{true, false} {
			t.Run(action+map[bool]string{true: " approved", false: " missing"}[available], func(t *testing.T) {
				db, mock, err := sqlmock.New()
				if err != nil {
					t.Fatal(err)
				}
				defer db.Close()
				mock.ExpectBegin()
				tx, err := db.Begin()
				if err != nil {
					t.Fatal(err)
				}
				if available {
					expectApprovalConsumption(mock, action)
				} else {
					mock.ExpectQuery(`(?s)SELECT approval.id::text.*ticket.status IN.*lower\(ticket.type\) IN.*ticket.requester_id=asset.assigned_to.*FOR UPDATE OF approval FOR SHARE OF ticket, requester`).WithArgs(adminTestAsset, adminTestEntity, softwareTestApplication, "firefox", action, adminTestOther).WillReturnRows(sqlmock.NewRows([]string{"id"}))
				}
				err = consumeSoftwareApproval(context.Background(), tx, adminTestAsset, adminTestEntity, softwareTestApplication, "firefox", action, softwareTestRequest, adminTestOther)
				if available && err != nil || !available && !errors.Is(err, sql.ErrNoRows) {
					t.Fatalf("unexpected approval result: %v", err)
				}
				mock.ExpectRollback()
				_ = tx.Rollback()
				if err := mock.ExpectationsWereMet(); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}
