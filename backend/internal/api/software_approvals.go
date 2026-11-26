package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

type softwareApproval struct {
	ID            string    `json:"id"`
	TicketNumber  string    `json:"ticketNumber"`
	ApplicationID string    `json:"applicationId"`
	PackageName   string    `json:"packageName"`
	Action        string    `json:"action"`
	ApprovedAt    time.Time `json:"approvedAt"`
	RequestID     string    `json:"requestId"`
	Available     bool      `json:"available"`
}

func consumeSoftwareApproval(ctx context.Context, tx *sql.Tx, assetID, entityID, applicationID, packageName, action, requestID, approvalID string) error {
	var matchedID string
	err := tx.QueryRowContext(ctx, `SELECT approval.id::text FROM software_ticket_approvals approval
		JOIN requests ticket ON ticket.id=approval.ticket_id
		JOIN assets asset ON asset.id=approval.asset_id
		JOIN users requester ON requester.id=ticket.requester_id
		WHERE approval.asset_id=$1::uuid AND approval.entity_id=$2::uuid AND approval.application_id=$3::uuid
		AND approval.package_name=$4 AND approval.action=$5 AND approval.consumed_request_id IS NULL
		AND approval.id=NULLIF($6, '')::uuid
		AND ticket.status IN ('pending', 'in_progress', 'resolved', 'approved') AND lower(ticket.type) IN ('software', 'software access')
		AND ticket.requester_id=asset.assigned_to AND requester.entity_id=approval.entity_id
		FOR UPDATE OF approval FOR SHARE OF ticket, requester`, assetID, entityID, applicationID, packageName, action, approvalID).Scan(&matchedID)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE software_ticket_approvals SET consumed_request_id=$2::uuid, consumed_at=NOW() WHERE id=$1::uuid`, matchedID, requestID)
	return err
}

func requireSoftwareApproval(c *gin.Context, ctx context.Context, tx *sql.Tx, assetID, entityID, applicationID, packageName, action, requestID, approvalID string) bool {
	err := consumeSoftwareApproval(ctx, tx, assetID, entityID, applicationID, packageName, action, requestID, approvalID)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Error(c, http.StatusConflict, "An unused approved software ticket for this system, application and action is required.")
		return false
	}
	if err != nil {
		adminCatalogError(c, err)
		return false
	}
	return true
}

func (server *apiServer) listSoftwareApprovals(c *gin.Context) {
	if !server.endpointManagementReadAllowed(c) {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 8*time.Second)
	defer cancel()
	asset, err := loadEndpointManagementAsset(ctx, c, server.db, false)
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	rows, err := server.db.QueryContext(ctx, `SELECT approval.id::text, approval.ticket_number, approval.application_id::text,
		approval.package_name, approval.action, approval.approved_at, COALESCE(approval.consumed_request_id::text, ''),
		COALESCE((approval.consumed_request_id IS NULL AND ticket.status IN ('pending', 'in_progress', 'resolved', 'approved')
		AND lower(ticket.type) IN ('software', 'software access') AND ticket.requester_id=asset.assigned_to AND requester.entity_id=approval.entity_id
		AND catalog.active AND catalog.package_name=approval.package_name), FALSE)
		FROM software_ticket_approvals approval JOIN requests ticket ON ticket.id=approval.ticket_id
		JOIN assets asset ON asset.id=approval.asset_id JOIN users requester ON requester.id=ticket.requester_id
		JOIN application_catalog catalog ON catalog.id=approval.application_id
		WHERE approval.asset_id=$1::uuid AND approval.entity_id=$2::uuid
		ORDER BY approval.approved_at DESC LIMIT 100`, strings.ToLower(c.Param("id")), asset.EntityID)
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	defer rows.Close()
	items := []softwareApproval{}
	for rows.Next() {
		var item softwareApproval
		if err := rows.Scan(&item.ID, &item.TicketNumber, &item.ApplicationID, &item.PackageName, &item.Action, &item.ApprovedAt, &item.RequestID, &item.Available); err != nil {
			adminCatalogError(c, err)
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		adminCatalogError(c, err)
		return
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items, "canApprove": isAdminRole(middleware.CurrentClaims(c).Role)})
}

func (server *apiServer) approveSoftwareTicket(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	if !server.requireRoles(c, "super_admin") {
		return
	}
	if !validManagementUUID(c.Param("id")) {
		adminCatalogError(c, adminInputError("invalid asset UUID"))
		return
	}
	var input struct {
		TicketNumber  string `json:"ticketNumber"`
		ApplicationID string `json:"applicationId"`
		Action        string `json:"action"`
		Confirmed     bool   `json:"confirmed"`
	}
	decoder := json.NewDecoder(io.LimitReader(c.Request.Body, 4097))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || !input.Confirmed || !validManagementUUID(input.ApplicationID) || (input.Action != "install" && input.Action != "remove") || len(input.TicketNumber) > 100 || strings.TrimSpace(input.TicketNumber) == "" {
		adminCatalogError(c, adminInputError("ticketNumber, applicationId, action and confirmed:true are required"))
		return
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		adminCatalogError(c, adminInputError("invalid approval payload"))
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 8*time.Second)
	defer cancel()
	tx, err := server.db.BeginTx(ctx, nil)
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	defer tx.Rollback()
	asset, err := loadEndpointManagementAsset(ctx, c, tx, true)
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	application, err := scanSoftwareApplication(tx.QueryRowContext(ctx, `SELECT `+softwareCatalogColumns+` FROM application_catalog WHERE id=$1::uuid AND entity_id=$2::uuid FOR SHARE`, input.ApplicationID, asset.EntityID))
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	if !asset.Compute || !application.Active || application.OS != softwareOS(asset.OS) {
		httpx.Error(c, http.StatusConflict, "Application is not eligible for this system.")
		return
	}
	var ticketID string
	err = tx.QueryRowContext(ctx, `SELECT ticket.id::text FROM requests ticket JOIN users requester ON requester.id=ticket.requester_id
		JOIN assets asset ON asset.assigned_to=requester.id
		WHERE ticket.ticket_number=$1 AND asset.id=$2::uuid AND requester.entity_id=$3::uuid
		AND lower(ticket.type) IN ('software', 'software access') AND ticket.status IN ('pending', 'in_progress', 'resolved', 'approved') FOR SHARE OF ticket, requester`, strings.TrimSpace(input.TicketNumber), strings.ToLower(c.Param("id")), asset.EntityID).Scan(&ticketID)
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	var approvalID string
	err = tx.QueryRowContext(ctx, `INSERT INTO software_ticket_approvals (ticket_id, ticket_number, asset_id, entity_id, application_id, package_name, action, approved_by)
		VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8::uuid) ON CONFLICT DO NOTHING RETURNING id::text`, ticketID, strings.TrimSpace(input.TicketNumber), strings.ToLower(c.Param("id")), asset.EntityID, application.ID, application.PackageName, input.Action, middleware.CurrentClaims(c).UserID).Scan(&approvalID)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Error(c, http.StatusConflict, "This ticket was already approved, or an unused approval already exists. Refresh approvals.")
		return
	}
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	detail, _ := json.Marshal(gin.H{"approvalId": approvalID, "ticketId": ticketID, "ticketNumber": input.TicketNumber, "applicationId": application.ID, "action": input.Action})
	_, err = tx.ExecContext(ctx, `INSERT INTO audit_log (actor_id, entity_id, action, target_type, target_id, detail, auth_method) VALUES ($1::uuid, $2::uuid, 'software_ticket_approved', 'asset', $3::uuid, $4::jsonb, 'authenticated')`, middleware.CurrentClaims(c).UserID, asset.EntityID, strings.ToLower(c.Param("id")), string(detail))
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	if err := tx.Commit(); err != nil {
		adminCatalogError(c, err)
		return
	}
	httpx.Created(c, gin.H{"id": approvalID, "ticketNumber": input.TicketNumber})
}
