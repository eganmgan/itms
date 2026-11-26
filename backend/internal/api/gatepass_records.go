package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"itms/backend/internal/platform/authn"
	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

// Only canonical, active, authorized records are offered. No hostname, email,
// branch-name matching, supplier-name guessing, or requester-company fallback.
const gatepassRecordsSQL = `
	WITH allowed AS (
		SELECT e.id, e.full_name, e.short_code FROM entities e WHERE e.is_active AND
		($1 IN ('admin', 'super_admin') OR e.id = NULLIF($2, '')::uuid OR EXISTS (
			SELECT 1 FROM user_entity_access x WHERE x.user_id = $3::uuid AND x.entity_id = e.id
		))
	)
	SELECT 'entity', id::text, full_name, id::text, '', short_code, '', '', '', '' FROM allowed
	UNION ALL
	SELECT 'branch', l.id::text, l.full_name, l.entity_id::text, '', l.location_code, '', '', '', ''
	FROM locations l JOIN allowed e ON e.id = l.entity_id WHERE l.is_active
	UNION ALL
	SELECT 'asset', a.id::text, a.name, a.entity_id::text, COALESCE(a.location_id::text, ''),
		a.asset_tag, COALESCE(a.serial_number, ''), COALESCE(d.name, ''), '', COALESCE(assigned.id::text, '')
	FROM assets a JOIN allowed e ON e.id = a.entity_id
	LEFT JOIN departments d ON d.id = a.dept_id AND d.entity_id = a.entity_id
	LEFT JOIN users assigned ON assigned.id = a.assigned_to AND assigned.is_active
		AND EXISTS (SELECT 1 FROM allowed scope WHERE scope.id = assigned.entity_id)
	UNION ALL
	SELECT 'recipient', u.id::text, u.full_name, u.entity_id::text, COALESCE(u.location_id::text, ''),
		u.emp_id, '', '', r.name, ''
	FROM users u JOIN allowed e ON e.id = u.entity_id JOIN roles r ON r.id = u.role_id WHERE u.is_active
	ORDER BY 1, 3, 2
`

type gatepassRecordOption struct {
	Kind           string `json:"kind"`
	ID             string `json:"id"`
	Name           string `json:"name"`
	EntityID       string `json:"entityId"`
	LocationID     string `json:"locationId"`
	Reference      string `json:"reference"`
	Serial         string `json:"serial"`
	Department     string `json:"department"`
	Role           string `json:"role"`
	AssignedUserID string `json:"assignedUserId,omitempty"`
}

type gatepassRecordQuerier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func readGatepassRecords(ctx context.Context, db gatepassRecordQuerier, claims *authn.Claims) ([]gatepassRecordOption, error) {
	rows, err := db.QueryContext(ctx, gatepassRecordsSQL, claims.Role, claims.EntityID, claims.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]gatepassRecordOption, 0)
	for rows.Next() {
		var item gatepassRecordOption
		if err := rows.Scan(&item.Kind, &item.ID, &item.Name, &item.EntityID, &item.LocationID, &item.Reference, &item.Serial, &item.Department, &item.Role, &item.AssignedUserID); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (server *apiServer) gatepassRecordOptions(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team") {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 8*time.Second)
	defer cancel()
	c.Header("Cache-Control", "no-store")
	items, err := readGatepassRecords(ctx, server.db, middleware.CurrentClaims(c))
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "gatepass records unavailable")
		return
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items})
}

type gatepassRecordInput struct {
	AssetID           string `json:"assetId"`
	OriginBranchID    string `json:"originBranchId"`
	RecipientBranchID string `json:"recipientBranchId"`
	RecipientID       string `json:"recipientId"`
	ReceiverEntityID  string `json:"receiverEntityId"`
	ApproverID        string `json:"approverId"`
	Purpose           string `json:"purpose"`
	IssueDate         string `json:"issueDate"`
	ReturnDate        string `json:"returnDate"`
	ContactNumber     string `json:"contactNumber"`
}

type gatepassCompanySnapshot struct {
	EntityID string `json:"entityId"`
	Name     string `json:"name"`
	Source   string `json:"source"`
	Code     string `json:"code,omitempty"`
}

func companyReferenceCode(code string) (string, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	if code == "ZTEC" {
		code = "ZTECH"
	}
	if len(code) == 0 || len(code) > 10 {
		return "", errors.New("company code is missing or invalid")
	}
	for _, character := range code {
		if (character < 'A' || character > 'Z') && (character < '0' || character > '9') {
			return "", errors.New("company code must contain only letters and numbers")
		}
	}
	return code, nil
}

type gatepassRecordSnapshot struct {
	Version     int                     `json:"version"`
	Sender      gatepassCompanySnapshot `json:"sender"`
	Receiver    gatepassCompanySnapshot `json:"receiver"`
	Asset       gatepassRecordOption    `json:"asset"`
	Origin      gatepassRecordOption    `json:"origin"`
	Destination gatepassRecordOption    `json:"destination"`
	Recipient   gatepassRecordOption    `json:"recipient"`
	Approver    gatepassRecordOption    `json:"approver"`
	ReturnDate  string                  `json:"returnDate"`
}

func resolveGatepassRecords(input gatepassRecordInput, items []gatepassRecordOption) (gatepassRecordSnapshot, error) {
	var snapshot gatepassRecordSnapshot
	lookup := func(kind, id string) (gatepassRecordOption, error) {
		for _, item := range items {
			if item.Kind == kind && item.ID == id && strings.TrimSpace(item.Name) != "" {
				return item, nil
			}
		}
		return gatepassRecordOption{}, errors.New("select an authorized saved " + kind + " record")
	}
	asset, err := lookup("asset", input.AssetID)
	if err != nil {
		return snapshot, err
	}
	sender, err := lookup("entity", asset.EntityID)
	if err != nil {
		return snapshot, err
	}
	originID := input.OriginBranchID
	if originID == "" {
		originID = asset.LocationID
	}
	origin, err := lookup("branch", originID)
	if err != nil || origin.EntityID != sender.ID {
		return snapshot, errors.New("select an authorized origin branch belonging to the asset company")
	}
	var recipient, destination gatepassRecordOption
	receiverID, source := input.ReceiverEntityID, "explicit_entity"
	if input.RecipientID != "" {
		recipient, err = lookup("recipient", input.RecipientID)
		if err != nil {
			return snapshot, err
		}
		if receiverID != "" && receiverID != recipient.EntityID {
			return snapshot, errors.New("receiver company conflicts with recipient record")
		}
		receiverID, source = recipient.EntityID, "recipient.entity_id"
	}
	if input.RecipientBranchID != "" {
		destination, err = lookup("branch", input.RecipientBranchID)
		if err != nil {
			return snapshot, err
		}
		if receiverID != "" && receiverID != destination.EntityID {
			return snapshot, errors.New("receiver company conflicts with destination branch")
		}
		receiverID = destination.EntityID
		if input.RecipientID == "" {
			source = "locations.entity_id"
		}
	}
	receiver, err := lookup("entity", receiverID)
	if err != nil {
		return snapshot, errors.New("receiver company unknown: select an authorized recipient, destination branch or company")
	}
	approver, err := lookup("recipient", input.ApproverID)
	if err != nil || (!isAdminRole(approver.Role) && approver.Role != "it_team") {
		return snapshot, errors.New("select an authorized IT approver record")
	}
	senderCode, err := companyReferenceCode(sender.Reference)
	if err != nil {
		return snapshot, err
	}
	return gatepassRecordSnapshot{
		Version: 1, Sender: gatepassCompanySnapshot{EntityID: sender.ID, Name: sender.Name, Source: "assets.entity_id", Code: senderCode},
		Receiver: gatepassCompanySnapshot{EntityID: receiver.ID, Name: receiver.Name, Source: source},
		Asset:    asset, Origin: origin, Destination: destination, Recipient: recipient, Approver: approver, ReturnDate: input.ReturnDate,
	}, nil
}

func (server *apiServer) createGatepassFromRecords(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team") {
		return
	}
	var input gatepassRecordInput
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10)
	if err := c.ShouldBindJSON(&input); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid gatepass payload")
		return
	}
	input.Purpose = strings.TrimSpace(input.Purpose)
	if input.Purpose == "" || len(input.Purpose) > 4000 || len(input.ContactNumber) > 50 {
		httpx.Error(c, http.StatusBadRequest, "purpose is required (maximum 4000 bytes); contact maximum 50 bytes")
		return
	}
	issue, err := time.Parse("2006-01-02", input.IssueDate)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "valid issueDate is required")
		return
	}
	if input.ReturnDate != "" {
		day, err := time.Parse("2006-01-02", input.ReturnDate)
		if err != nil || day.Before(issue) {
			httpx.Error(c, http.StatusBadRequest, "returnDate must be on or after issueDate")
			return
		}
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 8*time.Second)
	defer cancel()
	tx, err := server.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "gatepass records unavailable")
		return
	}
	defer tx.Rollback()
	claims := middleware.CurrentClaims(c)
	items, err := readGatepassRecords(ctx, tx, claims)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "gatepass records unavailable")
		return
	}
	snapshot, err := resolveGatepassRecords(input, items)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "gatepass snapshot unavailable")
		return
	}
	var id, number string
	err = tx.QueryRowContext(ctx, `
		INSERT INTO gatepasses (requester_id, gatepass_number, asset_ref, asset_description, purpose,
			origin_branch, recipient_branch, issue_date, employee_name, employee_code, department_name,
			approver_name_text, contact_number, status, record_snapshot)
		VALUES ($1::uuid, $14 || '-GP-' || to_char($2::date, 'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
			$3, $4, $5, $6, $7, $2::date, $8, $9, $10, $11, $12, 'pending', $13::jsonb)
		RETURNING id::text, gatepass_number
	`, claims.UserID, input.IssueDate, snapshot.Asset.Reference, snapshot.Asset.Name, input.Purpose,
		snapshot.Origin.Name, snapshot.Destination.Name, snapshot.Recipient.Name, snapshot.Recipient.Reference,
		snapshot.Asset.Department, snapshot.Approver.Name, strings.TrimSpace(input.ContactNumber), string(raw), snapshot.Sender.Code).Scan(&id, &number)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "gatepass could not be saved")
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "gatepass save outcome unknown; check list before retrying")
		return
	}
	middleware.TagAudit(c, middleware.AuditMeta{Action: "gatepass_created", TargetType: "gatepass", TargetID: id, Detail: input})
	httpx.Created(c, gin.H{"id": id, "gatepassNumber": number, "recordSnapshot": snapshot})
}
