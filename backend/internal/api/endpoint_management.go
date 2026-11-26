package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"itms/backend/internal/integrations/saltstack"
	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

type endpointManagementInput struct {
	RequestID     string
	Kind          string
	Action        string
	ApplicationID string
	ServiceName   string
	ApprovalID    string
}

type endpointManagementRecord struct {
	RequestID     string    `json:"requestId"`
	AssetID       string    `json:"assetId"`
	Kind          string    `json:"kind"`
	Action        string    `json:"action"`
	ApplicationID string    `json:"applicationId,omitempty"`
	ServiceName   string    `json:"serviceName,omitempty"`
	Status        string    `json:"status"`
	OutcomeCode   string    `json:"outcomeCode"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
	ActorID       string    `json:"-"`
	EntityID      string    `json:"-"`
}

const endpointManagementColumns = `request_id::text, asset_id::text, kind, action, COALESCE(application_id::text, ''), COALESCE(service_name, ''), status, outcome_code, created_at, updated_at, actor_id::text, entity_id::text`

func scanEndpointManagement(row softwareScanner) (r endpointManagementRecord, err error) {
	err = row.Scan(&r.RequestID, &r.AssetID, &r.Kind, &r.Action, &r.ApplicationID, &r.ServiceName, &r.Status, &r.OutcomeCode, &r.CreatedAt, &r.UpdatedAt, &r.ActorID, &r.EntityID)
	return
}

func endpointManagementCapabilities(c *gin.Context) gin.H {
	return gin.H{"canManage": softwarePermissions(c).CanInstall}
}

func validManagementUUID(value string) bool {
	return adminUUID.MatchString(value) && value != "00000000-0000-0000-0000-000000000000"
}

// Token decoding rejects duplicate/case-folded keys, nulls, coercions, extra
// fields and trailing data, including irrelevant IDs for the other action kind.
func decodeEndpointManagement(reader io.Reader) (input endpointManagementInput, err error) {
	invalid := adminInputError("invalid management payload")
	body, err := io.ReadAll(io.LimitReader(reader, 4097))
	if err != nil || len(body) > 4096 || !utf8.Valid(body) {
		return input, invalid
	}
	d := json.NewDecoder(bytes.NewReader(body))
	if token, err := d.Token(); err != nil || token != json.Delim('{') {
		return input, invalid
	}
	values := map[string]string{}
	confirmed := false
	seen := map[string]bool{}
	for d.More() {
		token, err := d.Token()
		if err != nil {
			return input, invalid
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return input, invalid
		}
		seen[key] = true
		if key == "confirmed" {
			if d.Decode(&confirmed) != nil || !confirmed {
				return input, invalid
			}
			continue
		}
		switch key {
		case "requestId", "kind", "action", "applicationId", "serviceName", "approvalId":
		default:
			return input, invalid
		}
		var value *string
		if d.Decode(&value) != nil || value == nil {
			return input, invalid
		}
		values[key] = *value
	}
	if _, err := d.Token(); err != nil {
		return input, invalid
	}
	if _, err := d.Token(); err != io.EOF || !confirmed || !validManagementUUID(values["requestId"]) {
		return input, invalid
	}
	input = endpointManagementInput{strings.ToLower(values["requestId"]), values["kind"], values["action"], strings.ToLower(values["applicationId"]), values["serviceName"], strings.ToLower(values["approvalId"])}
	if seen["approvalId"] && !validManagementUUID(input.ApprovalID) {
		return input, invalid
	}
	switch input.Kind {
	case "software":
		if input.Action != "remove" || !validManagementUUID(input.ApplicationID) || seen["serviceName"] {
			return input, invalid
		}
	case "service":
		if !saltstack.ValidServiceAction(input.Action) || !saltstack.ValidServiceName(input.ServiceName) || seen["applicationId"] || seen["approvalId"] {
			return input, invalid
		}
	default:
		return input, invalid
	}
	return input, nil
}

func (server *apiServer) registerEndpointManagementRoutes(group *gin.RouterGroup) {
	group.GET("/assets/:id/services", server.listEndpointServices)
	group.GET("/assets/:id/management-actions", server.listEndpointManagement)
	group.POST("/assets/:id/management-actions", server.manageEndpoint)
}

type endpointManagementAsset struct {
	EntityID string
	Target   string
	Compute  bool
	OS       string
}

func loadEndpointManagementAsset(ctx context.Context, c *gin.Context, db adminAssetQuerier, lock bool) (asset endpointManagementAsset, err error) {
	args := []any{strings.ToLower(c.Param("id"))}
	scope := adminEntityPredicate(c, "a.entity_id", &args)
	query := `SELECT a.entity_id::text, COALESCE(a.salt_minion_id, ''), a.is_compute, COALESCE(d.os_name, '') FROM assets a LEFT JOIN asset_compute_details d ON d.asset_id=a.id WHERE a.id=$1::uuid AND ` + scope
	if lock {
		query += ` FOR SHARE OF a`
	}
	err = db.QueryRowContext(ctx, query, args...).Scan(&asset.EntityID, &asset.Target, &asset.Compute, &asset.OS)
	return
}

func (server *apiServer) endpointManagementReadAllowed(c *gin.Context) bool {
	c.Header("Cache-Control", "no-store")
	if !server.requireRoles(c, "super_admin", "admin", "it_team", "auditor") {
		return false
	}
	if !validManagementUUID(c.Param("id")) {
		adminCatalogError(c, adminInputError("invalid asset UUID"))
		return false
	}
	return true
}

func (server *apiServer) listEndpointServices(c *gin.Context) {
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
	cancel()
	items, status := []saltstack.ManagedService{}, "unavailable"
	if asset.Compute && saltstack.ValidExactMinion(asset.Target) && server.salt.Enabled() {
		remoteCtx, remoteCancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
		defer remoteCancel()
		items, status = server.salt.ListManagedServices(remoteCtx, asset.Target)
	}
	response := gin.H{"items": items, "status": status, "capabilities": endpointManagementCapabilities(c)}
	if status == "unavailable" {
		response["error"] = "service listing unavailable"
	} else if status == "partial" {
		response["error"] = "service states unavailable; names may be incomplete"
	}
	httpx.JSON(c, http.StatusOK, response)
}

func (server *apiServer) listEndpointManagement(c *gin.Context) {
	if !server.endpointManagementReadAllowed(c) {
		return
	}
	requestID := c.Query("requestId")
	if values, exists := c.Request.URL.Query()["requestId"]; exists && (len(values) != 1 || !validManagementUUID(requestID)) {
		adminCatalogError(c, adminInputError("invalid request UUID"))
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 8*time.Second)
	defer cancel()
	asset, err := loadEndpointManagementAsset(ctx, c, server.db, false)
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	args := []any{strings.ToLower(c.Param("id")), asset.EntityID}
	query := `SELECT ` + endpointManagementColumns + ` FROM endpoint_management_requests WHERE asset_id=$1::uuid AND entity_id=$2::uuid`
	if requestID != "" {
		args = append(args, strings.ToLower(requestID))
		query += ` AND request_id=$3::uuid`
	}
	query += ` ORDER BY created_at DESC, request_id LIMIT 100`
	rows, err := server.db.QueryContext(ctx, query, args...)
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	defer rows.Close()
	items := []endpointManagementRecord{}
	for rows.Next() {
		item, err := scanEndpointManagement(rows)
		if err != nil {
			adminCatalogError(c, err)
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		adminCatalogError(c, err)
		return
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items, "capabilities": endpointManagementCapabilities(c)})
}

func endpointManagementEvent(ctx context.Context, tx *sql.Tx, r endpointManagementRecord, event string) error {
	// Only validated IDs, names and enum outcomes; no provider output or secrets.
	detail, _ := json.Marshal(r)
	if _, err := tx.ExecContext(ctx, `INSERT INTO asset_history (asset_id, actor_id, action, detail) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb)`, r.AssetID, r.ActorID, event, string(detail)); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO audit_log (actor_id, entity_id, action, target_type, target_id, detail, auth_method) VALUES ($1::uuid, $2::uuid, $3, 'asset', $4::uuid, $5::jsonb, 'authenticated')`, r.ActorID, r.EntityID, event, r.AssetID, string(detail))
	return err
}

func respondEndpointManagement(c *gin.Context, record endpointManagementRecord) {
	status := http.StatusOK
	if record.Status == "unknown" {
		status = http.StatusAccepted
	}
	httpx.JSON(c, status, gin.H{"items": []endpointManagementRecord{record}, "capabilities": endpointManagementCapabilities(c)})
}

func replayEndpointManagement(c *gin.Context, record endpointManagementRecord, input endpointManagementInput, entityID string) {
	if record.RequestID != input.RequestID || record.AssetID != strings.ToLower(c.Param("id")) || record.EntityID != entityID || record.ActorID != middleware.CurrentClaims(c).UserID || record.Kind != input.Kind || record.Action != input.Action || record.ApplicationID != input.ApplicationID || record.ServiceName != input.ServiceName {
		httpx.Error(c, http.StatusConflict, "requestId is already in use")
		return
	}
	respondEndpointManagement(c, record)
}

func (server *apiServer) manageEndpoint(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	if !server.requireRoles(c, "super_admin", "it_team") {
		return
	}
	if !validManagementUUID(c.Param("id")) {
		adminCatalogError(c, adminInputError("invalid asset UUID"))
		return
	}
	input, err := decodeEndpointManagement(c.Request.Body)
	if err != nil {
		adminCatalogError(c, err)
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
	previous, err := scanEndpointManagement(tx.QueryRowContext(ctx, `SELECT `+endpointManagementColumns+` FROM endpoint_management_requests WHERE request_id=$1::uuid`, input.RequestID))
	if err == nil {
		replayEndpointManagement(c, previous, input, asset.EntityID)
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		adminCatalogError(c, err)
		return
	}
	if !asset.Compute || !saltstack.ValidExactMinion(asset.Target) {
		adminCatalogError(c, adminInputError("asset has no eligible exact Salt target"))
		return
	}
	var application softwareApplication
	if input.Kind == "software" {
		application, err = scanSoftwareApplication(tx.QueryRowContext(ctx, `SELECT `+softwareCatalogColumns+` FROM application_catalog WHERE id=$1::uuid AND entity_id=$2::uuid FOR SHARE`, input.ApplicationID, asset.EntityID))
		if err != nil {
			adminCatalogError(c, err)
			return
		}
		if !application.Active || softwareOS(asset.OS) != application.OS || !saltstack.ValidPackageIdentifier(application.PackageName) {
			httpx.Error(c, http.StatusConflict, "application is inactive or incompatible with this asset")
			return
		}
		if saltstack.ProtectedManagementName(application.PackageName) || saltstack.ProtectedManagementName(application.Name) {
			httpx.Error(c, http.StatusForbidden, "protected management component")
			return
		}
	} else if (input.Action == "stop" || input.Action == "disable") && saltstack.ProtectedManagementName(input.ServiceName) {
		httpx.Error(c, http.StatusForbidden, "protected management component")
		return
	}
	if !server.salt.Enabled() {
		httpx.Error(c, http.StatusServiceUnavailable, "endpoint management unavailable")
		return
	}
	record, err := scanEndpointManagement(tx.QueryRowContext(ctx, `INSERT INTO endpoint_management_requests (request_id, asset_id, entity_id, actor_id, kind, action, application_id, service_name, package_name, os, salt_target) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, NULLIF($7, '')::uuid, NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), $11) ON CONFLICT (request_id) DO NOTHING RETURNING `+endpointManagementColumns,
		input.RequestID, strings.ToLower(c.Param("id")), asset.EntityID, middleware.CurrentClaims(c).UserID, input.Kind, input.Action, input.ApplicationID, input.ServiceName, application.PackageName, application.OS, asset.Target))
	if errors.Is(err, sql.ErrNoRows) {
		// Concurrent loser: read the winning reservation, NEVER dispatch again.
		record, err = scanEndpointManagement(tx.QueryRowContext(ctx, `SELECT `+endpointManagementColumns+` FROM endpoint_management_requests WHERE request_id=$1::uuid`, input.RequestID))
		if err != nil {
			adminCatalogError(c, err)
			return
		}
		replayEndpointManagement(c, record, input, asset.EntityID)
		return
	}
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	if input.Kind == "software" && !requireSoftwareApproval(c, ctx, tx, record.AssetID, asset.EntityID, input.ApplicationID, application.PackageName, "remove", input.RequestID, input.ApprovalID) {
		return
	}
	if err := endpointManagementEvent(ctx, tx, record, "endpoint_management_requested"); err != nil {
		adminCatalogError(c, err)
		return
	}
	if err := tx.Commit(); err != nil {
		// Commit may have reached PostgreSQL. Keep the outcome unknown and do not
		// dispatch. The same UUID is the only safe way to query/replay this request.
		respondEndpointManagement(c, record)
		return
	}
	cancel()
	remoteCtx, remoteCancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer remoteCancel()
	var status, code string
	if input.Kind == "software" {
		status, code = server.salt.RemovePackage(remoteCtx, asset.Target, application.PackageName)
	} else {
		status, code = server.salt.ManageService(remoteCtx, asset.Target, input.ServiceName, input.Action)
	}
	finishCtx, finishCancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer finishCancel()
	result, err := server.finishEndpointManagement(finishCtx, record, status, code)
	if err != nil {
		// Never report an unpersisted success. The original reservation is unknown
		// unless a final ambiguous commit actually succeeded; GET resolves that.
		respondEndpointManagement(c, record)
		return
	}
	respondEndpointManagement(c, result)
}

func (server *apiServer) finishEndpointManagement(ctx context.Context, record endpointManagementRecord, status, code string) (endpointManagementRecord, error) {
	tx, err := server.db.BeginTx(ctx, nil)
	if err != nil {
		return record, err
	}
	defer tx.Rollback()
	result, err := scanEndpointManagement(tx.QueryRowContext(ctx, `UPDATE endpoint_management_requests SET status=$2, outcome_code=$3, updated_at=NOW() WHERE request_id=$1::uuid AND status='unknown' RETURNING `+endpointManagementColumns, record.RequestID, status, code))
	if err != nil {
		return record, err
	}
	if err := endpointManagementEvent(ctx, tx, result, "endpoint_management_outcome"); err != nil {
		return record, err
	}
	if err := tx.Commit(); err != nil {
		return record, err
	}
	return result, nil
}
