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
	"itms/backend/internal/integrations/saltstack"
	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

type softwareInstallRecord struct {
	RequestID                string    `json:"requestId"`
	AssetID                  string    `json:"assetId"`
	ApplicationID            string    `json:"applicationId"`
	ApplicationName          string    `json:"applicationName"`
	PackageName              string    `json:"packageName"`
	OS                       string    `json:"os"`
	Status                   string    `json:"status"`
	OutcomeCode              string    `json:"outcomeCode"`
	CreatedAt                time.Time `json:"createdAt"`
	UpdatedAt                time.Time `json:"updatedAt"`
	InventoryRefreshRequired bool      `json:"inventoryRefreshRequired"`
	ActorID                  string    `json:"-"`
	EntityID                 string    `json:"-"`
}

const softwareInstallColumns = `request_id::text, asset_id::text, application_id::text, application_name, package_name, os, status, outcome_code, created_at, updated_at, actor_id::text, entity_id::text`

func scanSoftwareInstall(row softwareScanner) (r softwareInstallRecord, err error) {
	err = row.Scan(&r.RequestID, &r.AssetID, &r.ApplicationID, &r.ApplicationName, &r.PackageName, &r.OS, &r.Status, &r.OutcomeCode, &r.CreatedAt, &r.UpdatedAt, &r.ActorID, &r.EntityID)
	r.InventoryRefreshRequired = r.Status == "succeeded"
	return
}

// Fail closed on unknown OS, rather than treating every non-Windows OS as Linux.
func softwareOS(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	for _, prefix := range []string{"windows", "microsoft windows"} {
		if name == prefix || strings.HasPrefix(name, prefix+" ") {
			return "windows"
		}
	}
	for _, prefix := range []string{"macos", "mac os", "mac os x", "darwin"} {
		if name == prefix || strings.HasPrefix(name, prefix+" ") {
			return "macos"
		}
	}
	for _, prefix := range []string{"linux", "ubuntu", "debian", "rocky", "almalinux", "centos", "red hat enterprise linux", "rhel", "fedora", "arch linux", "opensuse", "suse linux enterprise", "linux mint", "oracle linux"} {
		if name == prefix || strings.HasPrefix(name, prefix+" ") || strings.HasPrefix(name, prefix+"/") {
			return "linux"
		}
	}
	return ""
}

// Both history and audit are committed with the reservation/outcome. The details
// contain only allowlisted IDs and outcome enums, never Salt output or credentials.
func softwareInstallEvent(ctx context.Context, tx *sql.Tx, r softwareInstallRecord, action string) error {
	detail, _ := json.Marshal(map[string]string{"requestId": r.RequestID, "applicationId": r.ApplicationID, "status": r.Status, "outcomeCode": r.OutcomeCode})
	if _, err := tx.ExecContext(ctx, `INSERT INTO asset_history (asset_id, actor_id, action, detail) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb)`, r.AssetID, r.ActorID, action, string(detail)); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO audit_log (actor_id, entity_id, action, target_type, target_id, detail, auth_method) VALUES ($1::uuid, $2::uuid, $3, 'asset', $4::uuid, $5::jsonb, 'authenticated')`, r.ActorID, r.EntityID, action, r.AssetID, string(detail))
	return err
}

func (server *apiServer) installSoftware(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	if !server.requireRoles(c, "super_admin", "it_team") {
		return
	}
	if !validManagementUUID(c.Param("id")) {
		adminCatalogError(c, adminInputError("invalid asset UUID"))
		return
	}
	input, err := decodeSoftwareInput(c.Request.Body, true)
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	assetID := strings.ToLower(c.Param("id"))
	requestID := input["requestId"].(string)
	applicationID := input["applicationId"].(string)
	actorID := middleware.CurrentClaims(c).UserID
	ctx, cancel := context.WithTimeout(c.Request.Context(), 8*time.Second)
	defer cancel()
	tx, err := server.db.BeginTx(ctx, nil)
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	defer tx.Rollback()
	// Lock the canonical asset and catalog until the dispatch snapshot is durable.
	// No hostname fallback, targeting expressions or client-supplied minion IDs.
	args := []any{assetID}
	scope := adminEntityPredicate(c, "a.entity_id", &args)
	var entityID, target, osName string
	var compute bool
	err = tx.QueryRowContext(ctx, `SELECT a.entity_id::text, COALESCE(a.salt_minion_id, ''), a.is_compute, COALESCE(d.os_name, '') FROM assets a LEFT JOIN asset_compute_details d ON d.asset_id=a.id WHERE a.id=$1::uuid AND `+scope+` FOR SHARE OF a`, args...).Scan(&entityID, &target, &compute, &osName)
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	// Replay works even after catalog deactivation or a disconnected provider.
	previous, err := scanSoftwareInstall(tx.QueryRowContext(ctx, `SELECT `+softwareInstallColumns+` FROM software_install_requests WHERE request_id=$1::uuid`, requestID))
	if err == nil {
		if previous.AssetID != assetID || previous.ApplicationID != applicationID || previous.ActorID != actorID || previous.EntityID != entityID {
			httpx.Error(c, http.StatusConflict, "requestId is already in use")
			return
		}
		respondSoftwareInstall(c, previous, true, false)
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		adminCatalogError(c, err)
		return
	}
	if !compute || !saltstack.ValidExactMinion(target) {
		adminCatalogError(c, adminInputError("asset has no eligible exact Salt target"))
		return
	}
	application, err := scanSoftwareApplication(tx.QueryRowContext(ctx, `SELECT `+softwareCatalogColumns+` FROM application_catalog WHERE id=$1::uuid AND entity_id=$2::uuid FOR SHARE`, applicationID, entityID))
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	if !application.Active || softwareOS(osName) != application.OS || !saltstack.ValidPackageIdentifier(application.PackageName) {
		httpx.Error(c, http.StatusConflict, "application is inactive or incompatible with this asset")
		return
	}
	if server.salt == nil || !server.salt.Enabled() {
		httpx.Error(c, http.StatusServiceUnavailable, "package installation unavailable")
		return
	}
	record, err := scanSoftwareInstall(tx.QueryRowContext(ctx, `INSERT INTO software_install_requests (request_id, asset_id, application_id, entity_id, actor_id, application_name, package_name, os) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8) ON CONFLICT (request_id) DO NOTHING RETURNING `+softwareInstallColumns,
		requestID, assetID, applicationID, entityID, actorID, application.Name, application.PackageName, application.OS))
	if errors.Is(err, sql.ErrNoRows) {
		// Concurrent request won. Never dispatch from the losing transaction.
		record, err = scanSoftwareInstall(tx.QueryRowContext(ctx, `SELECT `+softwareInstallColumns+` FROM software_install_requests WHERE request_id=$1::uuid`, requestID))
		if err != nil {
			adminCatalogError(c, err)
			return
		}
		if record.AssetID != assetID || record.ApplicationID != applicationID || record.ActorID != actorID || record.EntityID != entityID {
			httpx.Error(c, http.StatusConflict, "requestId is already in use")
			return
		}
		respondSoftwareInstall(c, record, true, false)
		return
	}
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	approvalID, _ := input["approvalId"].(string)
	if !requireSoftwareApproval(c, ctx, tx, assetID, entityID, applicationID, application.PackageName, "install", requestID, approvalID) {
		return
	}
	if err := softwareInstallEvent(ctx, tx, record, "software_install_requested"); err != nil {
		adminCatalogError(c, err)
		return
	}
	// Commit errors are ambiguous; do not dispatch or retry. A committed row, if
	// any, remains unknown and is recoverable through the status endpoint.
	if err := tx.Commit(); err != nil {
		respondSoftwareInstall(c, record, false, true)
		return
	}
	cancel()

	remoteCtx, remoteCancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer remoteCancel()
	status, code := "unknown", "response_unavailable"
	providerReady := true
	if application.OS == "macos" {
		ready, providerErr := server.salt.PackageProviderAvailable(remoteCtx, target)
		providerReady = ready && providerErr == nil
		if providerErr == nil && !ready {
			status, code = "failed", "provider_unavailable"
		}
	}
	if providerReady {
		status, code = server.salt.InstallPackage(remoteCtx, target, application.PackageName)
	}
	// Finish even if the caller disconnected, with a fresh bounded DB budget.
	finishCtx, finishCancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer finishCancel()
	result, err := server.finishSoftwareInstall(finishCtx, record, status, code)
	if err != nil {
		// Durable reservation is still unknown. Do not report an unpersisted
		// success or turn a recording failure into an invitation to reinstall.
		respondSoftwareInstall(c, record, false, true)
		return
	}
	respondSoftwareInstall(c, result, false, false)
}

func respondSoftwareInstall(c *gin.Context, result softwareInstallRecord, replayed, persistenceUnconfirmed bool) {
	responseStatus := http.StatusOK
	if result.Status == "unknown" {
		responseStatus = http.StatusAccepted
	}
	response := gin.H{"install": result, "replayed": replayed}
	if persistenceUnconfirmed {
		response["outcomePersistenceUnconfirmed"] = true
	}
	httpx.JSON(c, responseStatus, response)
}

func (server *apiServer) finishSoftwareInstall(ctx context.Context, record softwareInstallRecord, status, code string) (softwareInstallRecord, error) {
	tx, err := server.db.BeginTx(ctx, nil)
	if err != nil {
		return record, err
	}
	defer tx.Rollback()
	result, err := scanSoftwareInstall(tx.QueryRowContext(ctx, `UPDATE software_install_requests SET status=$2, outcome_code=$3, updated_at=NOW() WHERE request_id=$1::uuid AND status='unknown' RETURNING `+softwareInstallColumns, record.RequestID, status, code))
	if err != nil {
		return record, err
	}
	if err := softwareInstallEvent(ctx, tx, result, "software_install_outcome"); err != nil {
		return record, err
	}
	if err := tx.Commit(); err != nil {
		return record, err
	}
	return result, nil
}

func (server *apiServer) listSoftwareInstalls(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	if !server.requireRoles(c, "super_admin", "admin", "it_team", "auditor", "employee") {
		return
	}
	if !validManagementUUID(c.Param("id")) {
		adminCatalogError(c, adminInputError("invalid asset UUID"))
		return
	}
	requestID := c.Query("requestId")
	if values, exists := c.Request.URL.Query()["requestId"]; exists && (len(values) != 1 || !validManagementUUID(requestID)) {
		adminCatalogError(c, adminInputError("invalid request UUID"))
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 8*time.Second)
	defer cancel()
	asset, err := server.fetchAssetContext(ctx, c.Param("id"))
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	allowed, err := server.deviceDetailAllowed(ctx, c, asset)
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	if !allowed {
		adminCatalogError(c, sql.ErrNoRows)
		return
	}
	rows, err := server.db.QueryContext(ctx, `SELECT `+softwareInstallColumns+` FROM software_install_requests WHERE asset_id=$1::uuid AND entity_id=$2::uuid AND ($3='' OR request_id=NULLIF($3, '')::uuid) ORDER BY created_at DESC, request_id DESC LIMIT 50`, asset.ID, asset.EntityID, requestID)
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	defer rows.Close()
	items := []softwareInstallRecord{}
	for rows.Next() {
		item, err := scanSoftwareInstall(rows)
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
	httpx.JSON(c, http.StatusOK, gin.H{"items": items, "capabilities": softwarePermissions(c)})
}
