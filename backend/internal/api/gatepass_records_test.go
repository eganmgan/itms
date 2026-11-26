package api

import (
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func gatepassFixtureRecords() []gatepassRecordOption {
	return []gatepassRecordOption{
		{Kind: "entity", ID: "sender", Name: "Saved Sender Ltd", EntityID: "sender", Reference: "ZBL"},
		{Kind: "entity", ID: "receiver", Name: "Saved Receiver Ltd", EntityID: "receiver", Reference: "ZTEC"},
		{Kind: "asset", ID: "asset", Name: "Saved Laptop", Reference: "AS-1", Serial: "SERIAL-1", EntityID: "sender", LocationID: "origin", Department: "Recorded IT", AssignedUserID: "person"},
		{Kind: "branch", ID: "origin", Name: "Same Branch Name", EntityID: "sender"},
		{Kind: "branch", ID: "destination", Name: "Same Branch Name", EntityID: "receiver"},
		{Kind: "recipient", ID: "person", Name: "Saved Person", Reference: "EMP1", EntityID: "receiver"},
		{Kind: "recipient", ID: "approver", Name: "Saved Approver", EntityID: "sender", Role: "it_team"},
	}
}

func gatepassFixtureInput() gatepassRecordInput {
	return gatepassRecordInput{AssetID: "asset", RecipientID: "person", RecipientBranchID: "destination", ApproverID: "approver", Purpose: "Repair", IssueDate: "2026-09-21"}
}

func TestGatepassRecordResolution(t *testing.T) {
	for _, test := range []struct {
		name      string
		edit      func(*gatepassRecordInput)
		wantError string
	}{
		{"asset and recipient companies", func(in *gatepassRecordInput) {}, ""},
		{"branch alone", func(in *gatepassRecordInput) { in.RecipientID = "" }, ""},
		{"explicit company for unknown mapping", func(in *gatepassRecordInput) {
			in.RecipientID = ""
			in.RecipientBranchID = ""
			in.ReceiverEntityID = "receiver"
		}, ""},
		{"no inferred receiver", func(in *gatepassRecordInput) { in.RecipientID = ""; in.RecipientBranchID = "" }, "receiver company unknown"},
		{"recipient branch conflict", func(in *gatepassRecordInput) { in.RecipientBranchID = "origin" }, "conflicts"},
		{"explicit company conflict", func(in *gatepassRecordInput) { in.ReceiverEntityID = "sender" }, "conflicts"},
		{"foreign asset", func(in *gatepassRecordInput) { in.AssetID = "unauthorized" }, "authorized saved asset"},
		{"foreign recipient", func(in *gatepassRecordInput) { in.RecipientID = "unauthorized" }, "authorized saved recipient"},
		{"sender branch conflict", func(in *gatepassRecordInput) { in.OriginBranchID = "destination" }, "origin branch"},
		{"approver role", func(in *gatepassRecordInput) { in.ApproverID = "person" }, "IT approver"},
	} {
		t.Run(test.name, func(t *testing.T) {
			input := gatepassFixtureInput()
			test.edit(&input)
			snapshot, err := resolveGatepassRecords(input, gatepassFixtureRecords())
			if test.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantError) {
					t.Fatalf("error = %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if snapshot.Sender.Name != "Saved Sender Ltd" || snapshot.Receiver.Name != "Saved Receiver Ltd" || snapshot.Asset.Serial != "SERIAL-1" {
				t.Fatalf("wrong snapshot: %+v", snapshot)
			}
		})
	}
}

func TestGatepassUnknownAssetLocationRequiresExplicitBranch(t *testing.T) {
	items := gatepassFixtureRecords()
	items[2].LocationID = "unavailable"
	input := gatepassFixtureInput()
	if _, err := resolveGatepassRecords(input, items); err == nil {
		t.Fatal("unknown location silently accepted")
	}
	input.OriginBranchID = "origin"
	if _, err := resolveGatepassRecords(input, items); err != nil {
		t.Fatal(err)
	}
}

func gatepassFixtureRows() *sqlmock.Rows {
	rows := sqlmock.NewRows([]string{"kind", "id", "name", "entity_id", "location_id", "reference", "serial", "department", "role", "assigned_user_id"})
	for _, item := range gatepassFixtureRecords() {
		rows.AddRow(item.Kind, item.ID, item.Name, item.EntityID, item.LocationID, item.Reference, item.Serial, item.Department, item.Role, item.AssignedUserID)
	}
	return rows
}

func TestGatepassCompanyCodes(t *testing.T) {
	for _, scenario := range []struct{ input, want string }{{"ZBL", "ZBL"}, {"ZTEC", "ZTECH"}, {"ztech", "ZTECH"}, {"", ""}, {"bad/code", ""}} {
		items := gatepassFixtureRecords()
		items[0].Reference = scenario.input
		snapshot, err := resolveGatepassRecords(gatepassFixtureInput(), items)
		if scenario.want == "" {
			if err == nil {
				t.Fatalf("accepted invalid code %q", scenario.input)
			}
		} else if err != nil || snapshot.Sender.Code != scenario.want {
			t.Fatalf("code %q: snapshot %+v, error %v", scenario.input, snapshot.Sender, err)
		}
	}
}

type gatepassSnapshotArgument struct{}

func (gatepassSnapshotArgument) Match(value driver.Value) bool {
	raw, ok := value.(string)
	if !ok {
		return false
	}
	var snapshot gatepassRecordSnapshot
	return json.Unmarshal([]byte(raw), &snapshot) == nil && snapshot.Version == 1 &&
		snapshot.Sender.Name == "Saved Sender Ltd" && snapshot.Receiver.Name == "Saved Receiver Ltd" &&
		snapshot.Asset.Serial == "SERIAL-1" && snapshot.Recipient.Name == "Saved Person"
}

func TestGatepassCreatePersistsAuthoritativeSnapshot(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	ctx, recorder := newTestContext(http.MethodPost, "/gatepass", newTestClaims("it_team", "user", "sender"))
	// Client-supplied names/snapshot are deliberately ignored, not persisted.
	ctx.Request.Body = io.NopCloser(strings.NewReader(`{"assetId":"asset","recipientId":"person","recipientBranchId":"destination","approverId":"approver","purpose":"Repair","issueDate":"2026-09-21","senderCompany":"Forged","assetDescription":"Forged","recordSnapshot":{"sender":{"name":"Forged"}}}`))
	ctx.Request.Header.Set("Content-Type", "application/json")
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(gatepassRecordsSQL)).WithArgs("it_team", "sender", "user").WillReturnRows(gatepassFixtureRows())
	mock.ExpectQuery(`INSERT INTO gatepasses[\s\S]*\$14 \|\| '-GP-'`).WithArgs("user", "2026-09-21", "AS-1", "Saved Laptop", "Repair", "Same Branch Name", "Same Branch Name", "Saved Person", "EMP1", "Recorded IT", "Saved Approver", "", gatepassSnapshotArgument{}, "ZBL").
		WillReturnRows(sqlmock.NewRows([]string{"id", "number"}).AddRow("pass", "ZBL-GP-TEST"))
	mock.ExpectCommit()
	server.createGatepassFromRecords(ctx)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "Forged") {
		t.Fatal("client name used")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestGatepassCreateRejectsUnresolvedWithoutWrite(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	ctx, recorder := newTestContext(http.MethodPost, "/gatepass", newTestClaims("super_admin", "user", ""))
	ctx.Request.Body = io.NopCloser(strings.NewReader(`{"assetId":"asset","approverId":"approver","purpose":"Repair","issueDate":"2026-09-21"}`))
	ctx.Request.Header.Set("Content-Type", "application/json")
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(gatepassRecordsSQL)).WithArgs("super_admin", "", "user").WillReturnRows(gatepassFixtureRows())
	mock.ExpectRollback()
	server.createGatepassFromRecords(ctx)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "receiver company unknown") {
		t.Fatalf("%d %s", recorder.Code, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestGatepassOptionsRoleAndScope(t *testing.T) {
	for _, role := range []string{"employee", "auditor", "admin", "it_team", "super_admin"} {
		t.Run(role, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			ctx, recorder := newTestContext(http.MethodGet, "/gatepass/options", newTestClaims(role, "user", "sender"))
			want := http.StatusForbidden
			if role == "it_team" || isAdminRole(role) {
				want = http.StatusOK
				mock.ExpectQuery(regexp.QuoteMeta(gatepassRecordsSQL)).WithArgs(role, "sender", "user").WillReturnRows(gatepassFixtureRows())
			}
			server.gatepassRecordOptions(ctx)
			if recorder.Code != want {
				t.Fatalf("status %d: %s", recorder.Code, recorder.Body.String())
			}
			if want == http.StatusOK && !strings.Contains(recorder.Body.String(), `"assignedUserId":"person"`) {
				t.Fatal("assigned recipient missing from options")
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, required := range []string{"e.is_active", "l.is_active", "u.is_active", "user_entity_access", "x.user_id = $3::uuid", "x.entity_id = e.id", "a.entity_id", "u.entity_id", "assigned.id = a.assigned_to AND assigned.is_active", "scope.id = assigned.entity_id"} {
		if !strings.Contains(gatepassRecordsSQL, required) {
			t.Errorf("missing SQL scope %s", required)
		}
	}
}

func TestGatepassOptionsFailureDoesNotExposeDatabaseError(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	ctx, recorder := newTestContext(http.MethodGet, "/gatepass/options", newTestClaims("it_team", "user", "sender"))
	mock.ExpectQuery(regexp.QuoteMeta(gatepassRecordsSQL)).WillReturnError(errors.New("private database detail"))
	server.gatepassRecordOptions(ctx)
	if recorder.Code != http.StatusInternalServerError || strings.Contains(recorder.Body.String(), "private") {
		t.Fatalf("%d %s", recorder.Code, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestGatepassListUsesHistoricalSnapshotWithoutMasterLookup(t *testing.T) {
	for _, historical := range []bool{true, false} {
		server, mock, cleanup := newTestServer(t)
		ctx, recorder := newTestContext(http.MethodGet, "/gatepass", newTestClaims("super_admin", "user", ""))
		raw := []byte(`{}`)
		if historical {
			snapshot, err := resolveGatepassRecords(gatepassFixtureInput(), gatepassFixtureRecords())
			if err != nil {
				t.Fatal(err)
			}
			snapshot.Sender.Name = "Historical Sender"
			raw, err = json.Marshal(snapshot)
			if err != nil {
				t.Fatal(err)
			}
		}
		columns := []string{"id", "number", "ref", "description", "purpose", "origin", "destination", "issue_date", "employee_name", "employee_code", "department", "contact", "status", "created_at", "issuer_name", "issuer_at", "receiver_name", "receiver_at", "security_name", "security_at", "approver", "requester", "file_name", "file_type", "file_at", "verification", "notes", "snapshot"}
		mock.ExpectQuery(`SELECT g.id,.*COALESCE\(g.record_snapshot, '\{\}'\).*FROM gatepasses g`).WillReturnRows(sqlmock.NewRows(columns).AddRow(
			"pass", "GP-1", "AS-1", "Saved Laptop", "Repair", "Origin", "Destination", "2026-09-21", "Person", "E1", "IT", "", "pending", time.Now(), "", "", "", "", "", "", "Approver", "Requester", "", "", "", "", "", raw,
		))
		server.listGatepasses(ctx)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%d %s", recorder.Code, recorder.Body.String())
		}
		var response []struct {
			Snapshot gatepassRecordSnapshot `json:"recordSnapshot"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil || len(response) != 1 {
			t.Fatalf("response: %s, error: %v", recorder.Body.String(), err)
		}
		if historical && response[0].Snapshot.Sender.Name != "Historical Sender" {
			t.Fatal("historical company not preserved")
		}
		if !historical && (response[0].Snapshot.Version != 0 || response[0].Snapshot.Sender.Name != "") {
			t.Fatal("legacy company invented")
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
		cleanup()
	}
}

func TestGatepassInvalidDatesRejectedBeforeDatabaseAccess(t *testing.T) {
	for _, dates := range []string{`"issueDate":""`, `"issueDate":"not-a-date"`, `"issueDate":"2026-09-21","returnDate":"2026-09-20"`} {
		server, mock, cleanup := newTestServer(t)
		ctx, recorder := newTestContext(http.MethodPost, "/gatepass", newTestClaims("it_team", "user", "sender"))
		ctx.Request.Body = io.NopCloser(strings.NewReader(`{"purpose":"Repair",` + dates + `}`))
		ctx.Request.Header.Set("Content-Type", "application/json")
		server.createGatepassFromRecords(ctx)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%d %s", recorder.Code, recorder.Body.String())
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
		cleanup()
	}
}
