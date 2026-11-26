package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"itms/backend/internal/integrations/saltstack"
	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

type installationScript struct {
	ID          string `json:"id"`
	EntityID    string `json:"entityId"`
	Name        string `json:"name"`
	Category    string `json:"category"`
	Type        string `json:"type"`
	OS          string `json:"os"`
	Description string `json:"description"`
	Body        string `json:"body,omitempty"`
	Hash        string `json:"hash"`
}

const installationScriptColumns = `id::text, COALESCE(entity_id::text, ''), name, category, type, os, COALESCE(description, ''), body`

func scanInstallationScript(row softwareScanner) (script installationScript, err error) {
	err = row.Scan(&script.ID, &script.EntityID, &script.Name, &script.Category, &script.Type, &script.OS, &script.Description, &script.Body)
	encoded, _ := json.Marshal(script)
	hash := sha256.Sum256(encoded)
	script.Hash = hex.EncodeToString(hash[:])
	return
}

func installationPlatform(os string) string {
	os = strings.ToLower(strings.TrimSpace(os))
	for _, platform := range []string{"Ubuntu", "Debian", "Rocky Linux"} {
		prefix := strings.ToLower(platform)
		if os == prefix || strings.HasPrefix(os, prefix+" ") {
			return platform
		}
	}
	return "default"
}

func installationCompatible(script installationScript, asset endpointManagementAsset) bool {
	return asset.Compute && saltstack.ValidExactMinion(asset.Target) && softwareOS(asset.OS) == "linux" &&
		(script.OS == "default" || script.OS == installationPlatform(asset.OS)) &&
		script.Type == "sh" && (script.EntityID == "" || script.EntityID == asset.EntityID)
}

type installationRun struct {
	RequestID   string    `json:"requestId"`
	AssetID     string    `json:"assetId"`
	ScriptID    string    `json:"scriptId"`
	ScriptHash  string    `json:"scriptHash"`
	ScriptName  string    `json:"scriptName"`
	Category    string    `json:"category"`
	Status      string    `json:"status"`
	OutcomeCode string    `json:"outcomeCode"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
	ActorID     string    `json:"-"`
	EntityID    string    `json:"-"`
}

const installationRunColumns = `request_id::text, asset_id::text, script_id::text, script_hash, script_name, category, status, outcome_code, created_at, updated_at, actor_id::text, entity_id::text`

func scanInstallationRun(row softwareScanner) (record installationRun, err error) {
	err = row.Scan(&record.RequestID, &record.AssetID, &record.ScriptID, &record.ScriptHash, &record.ScriptName, &record.Category, &record.Status, &record.OutcomeCode, &record.CreatedAt, &record.UpdatedAt, &record.ActorID, &record.EntityID)
	return
}

func decodeInstallationRun(reader io.Reader) (map[string]string, error) {
	invalid := adminInputError("requestId, scriptId, scriptHash and confirmed:true are required")
	body, err := io.ReadAll(io.LimitReader(reader, 4097))
	if err != nil || len(body) > 4096 || !utf8.Valid(body) {
		return nil, invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, invalid
	}
	values := map[string]string{}
	seen := map[string]bool{}
	confirmed := false
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] {
			return nil, invalid
		}
		seen[key] = true
		if key == "confirmed" {
			if decoder.Decode(&confirmed) != nil || !confirmed {
				return nil, invalid
			}
			continue
		}
		if key != "requestId" && key != "scriptId" && key != "scriptHash" {
			return nil, invalid
		}
		var value *string
		if decoder.Decode(&value) != nil || value == nil {
			return nil, invalid
		}
		values[key] = *value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, invalid
	}
	if _, err := decoder.Token(); err != io.EOF || !confirmed || !validManagementUUID(values["requestId"]) || !validManagementUUID(values["scriptId"]) {
		return nil, invalid
	}
	hash, err := hex.DecodeString(values["scriptHash"])
	if err != nil || len(hash) != sha256.Size || values["scriptHash"] != strings.ToLower(values["scriptHash"]) {
		return nil, invalid
	}
	values["requestId"], values["scriptId"] = strings.ToLower(values["requestId"]), strings.ToLower(values["scriptId"])
	return values, nil
}

func (server *apiServer) registerInstallationScriptRoutes(group *gin.RouterGroup) {
	group.GET("/assets/:id/installation-scripts", server.listInstallationScripts)
	group.GET("/assets/:id/installation-scripts/:scriptId", server.reviewInstallationScript)
	group.GET("/assets/:id/script-runs", server.listInstallationRuns)
	group.POST("/assets/:id/script-runs", server.applyInstallationScript)
}

func scriptCapabilities(c *gin.Context) gin.H {
	return gin.H{"canApply": isAdminRole(middleware.CurrentClaims(c).Role)}
}

func (server *apiServer) listInstallationScripts(c *gin.Context) {
	if !server.endpointManagementReadAllowed(c) {
		return
	}
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil || page < 1 || page > 1000000 {
		adminCatalogError(c, adminInputError("invalid page"))
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 8*time.Second)
	defer cancel()
	asset, err := loadEndpointManagementAsset(ctx, c, server.db, false)
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	items := []installationScript{}
	if asset.Compute && saltstack.ValidExactMinion(asset.Target) && softwareOS(asset.OS) == "linux" {
		rows, err := server.db.QueryContext(ctx, `SELECT `+installationScriptColumns+` FROM admin_installation_scripts WHERE (entity_id=$1::uuid OR entity_id IS NULL) AND type='sh' AND os IN ('default', $2) ORDER BY name, id LIMIT 51 OFFSET $3`, asset.EntityID, installationPlatform(asset.OS), (page-1)*50)
		if err != nil {
			adminCatalogError(c, err)
			return
		}
		defer rows.Close()
		for rows.Next() {
			script, err := scanInstallationScript(rows)
			if err != nil {
				adminCatalogError(c, err)
				return
			}
			script.Body = ""
			items = append(items, script)
		}
		if err := rows.Err(); err != nil {
			adminCatalogError(c, err)
			return
		}
	}
	hasMore := len(items) > 50
	if hasMore {
		items = items[:50]
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items, "page": page, "hasMore": hasMore, "capabilities": scriptCapabilities(c)})
}

func (server *apiServer) reviewInstallationScript(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	if !server.requireRoles(c, "super_admin") {
		return
	}
	if !validManagementUUID(c.Param("id")) || !validManagementUUID(c.Param("scriptId")) {
		adminCatalogError(c, adminInputError("invalid UUID"))
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 8*time.Second)
	defer cancel()
	asset, err := loadEndpointManagementAsset(ctx, c, server.db, false)
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	script, err := scanInstallationScript(server.db.QueryRowContext(ctx, `SELECT `+installationScriptColumns+` FROM admin_installation_scripts WHERE id=$1::uuid AND (entity_id=$2::uuid OR entity_id IS NULL)`, c.Param("scriptId"), asset.EntityID))
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	if !installationCompatible(script, asset) {
		httpx.Error(c, 409, "script is incompatible with this device")
		return
	}
	httpx.JSON(c, http.StatusOK, script)
}

func installationRunEvent(ctx context.Context, tx *sql.Tx, record installationRun, action string) error {
	detail, _ := json.Marshal(map[string]string{"requestId": record.RequestID, "scriptId": record.ScriptID, "scriptHash": record.ScriptHash, "category": record.Category, "status": record.Status, "outcomeCode": record.OutcomeCode})
	if _, err := tx.ExecContext(ctx, `INSERT INTO asset_history (asset_id, actor_id, action, detail) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb)`, record.AssetID, record.ActorID, action, string(detail)); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO audit_log (actor_id, entity_id, action, target_type, target_id, detail, auth_method) VALUES ($1::uuid, $2::uuid, $3, 'asset', $4::uuid, $5::jsonb, 'authenticated')`, record.ActorID, record.EntityID, action, record.AssetID, string(detail))
	return err
}

func respondInstallationRun(c *gin.Context, record installationRun, uncertain bool) {
	status := http.StatusOK
	if record.Status == "unknown" {
		status = http.StatusAccepted
	}
	httpx.JSON(c, status, gin.H{"run": record, "outcomePersistenceUnconfirmed": uncertain})
}

func (server *apiServer) applyInstallationScript(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	if !server.requireRoles(c, "super_admin") {
		return
	}
	if !validManagementUUID(c.Param("id")) {
		adminCatalogError(c, adminInputError("invalid asset UUID"))
		return
	}
	input, err := decodeInstallationRun(c.Request.Body)
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	assetID, actorID := strings.ToLower(c.Param("id")), middleware.CurrentClaims(c).UserID
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
	replay := func(record installationRun) {
		if record.AssetID != assetID || record.EntityID != asset.EntityID || record.ActorID != actorID || record.ScriptID != input["scriptId"] || record.ScriptHash != input["scriptHash"] {
			httpx.Error(c, 409, "requestId is already in use")
			return
		}
		respondInstallationRun(c, record, false)
	}
	previous, err := scanInstallationRun(tx.QueryRowContext(ctx, `SELECT `+installationRunColumns+` FROM installation_script_runs WHERE request_id=$1::uuid`, input["requestId"]))
	if err == nil {
		replay(previous)
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		adminCatalogError(c, err)
		return
	}
	script, err := scanInstallationScript(tx.QueryRowContext(ctx, `SELECT `+installationScriptColumns+` FROM admin_installation_scripts WHERE id=$1::uuid AND (entity_id=$2::uuid OR entity_id IS NULL) FOR SHARE`, input["scriptId"], asset.EntityID))
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	if !installationCompatible(script, asset) || script.Hash != input["scriptHash"] {
		httpx.Error(c, 409, "script changed or is incompatible; review it again")
		return
	}
	if !server.salt.Enabled() {
		httpx.Error(c, 503, "script execution unavailable")
		return
	}
	record, err := scanInstallationRun(tx.QueryRowContext(ctx, `INSERT INTO installation_script_runs (request_id, asset_id, script_id, script_hash, script_name, category, actor_id, entity_id) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, $8::uuid) ON CONFLICT (request_id) DO NOTHING RETURNING `+installationRunColumns, input["requestId"], assetID, script.ID, script.Hash, script.Name, script.Category, actorID, asset.EntityID))
	if errors.Is(err, sql.ErrNoRows) {
		record, err = scanInstallationRun(tx.QueryRowContext(ctx, `SELECT `+installationRunColumns+` FROM installation_script_runs WHERE request_id=$1::uuid`, input["requestId"]))
		if err != nil {
			adminCatalogError(c, err)
			return
		}
		replay(record)
		return
	}
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	if err := installationRunEvent(ctx, tx, record, "installation_script_requested"); err != nil {
		adminCatalogError(c, err)
		return
	}
	if err := tx.Commit(); err != nil {
		respondInstallationRun(c, record, true)
		return
	}
	cancel()
	remoteCtx, remoteCancel := context.WithTimeout(context.Background(), 610*time.Second)
	defer remoteCancel()
	status, code := server.salt.ApplyInstallationScript(remoteCtx, asset.Target, script.Type, script.Body)
	finishCtx, finishCancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer finishCancel()
	result, err := server.finishInstallationRun(finishCtx, record, status, code)
	if err != nil {
		respondInstallationRun(c, record, true)
		return
	}
	respondInstallationRun(c, result, false)
}

func (server *apiServer) finishInstallationRun(ctx context.Context, record installationRun, status, code string) (installationRun, error) {
	tx, err := server.db.BeginTx(ctx, nil)
	if err != nil {
		return record, err
	}
	defer tx.Rollback()
	result, err := scanInstallationRun(tx.QueryRowContext(ctx, `UPDATE installation_script_runs SET status=$2, outcome_code=$3, updated_at=NOW() WHERE request_id=$1::uuid AND status='unknown' RETURNING `+installationRunColumns, record.RequestID, status, code))
	if err != nil {
		return record, err
	}
	if err := installationRunEvent(ctx, tx, result, "installation_script_outcome"); err != nil {
		return record, err
	}
	if err := tx.Commit(); err != nil {
		return record, err
	}
	return result, nil
}

func (server *apiServer) listInstallationRuns(c *gin.Context) {
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
	rows, err := server.db.QueryContext(ctx, `SELECT `+installationRunColumns+` FROM installation_script_runs WHERE asset_id=$1::uuid AND entity_id=$2::uuid AND ($3='' OR request_id=NULLIF($3, '')::uuid) ORDER BY created_at DESC, request_id LIMIT 50`, strings.ToLower(c.Param("id")), asset.EntityID, strings.ToLower(requestID))
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	defer rows.Close()
	items := []installationRun{}
	for rows.Next() {
		record, err := scanInstallationRun(rows)
		if err != nil {
			adminCatalogError(c, err)
			return
		}
		items = append(items, record)
	}
	if err := rows.Err(); err != nil {
		adminCatalogError(c, err)
		return
	}
	httpx.JSON(c, 200, gin.H{"items": items, "capabilities": scriptCapabilities(c)})
}
