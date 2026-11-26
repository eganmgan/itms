package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/lib/pq"

	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

func (server *apiServer) listPatchLogs(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team", "auditor") {
		return
	}
	claims := middleware.CurrentClaims(c)
	rows, err := server.db.Query(`
		SELECT h.id::text, a.id::text, a.asset_tag, COALESCE(a.hostname, a.asset_tag),
		       COALESCE(d.name, 'Unassigned'), h.detail, h.created_at
		FROM asset_history h
		JOIN assets a ON a.id = h.asset_id
		LEFT JOIN departments d ON d.id = a.dept_id
		WHERE h.action = 'patch_run'
		  AND ($1 = 'super_admin' OR a.entity_id = $2::uuid OR EXISTS (
		    SELECT 1 FROM user_entity_access uea
		    WHERE uea.user_id = $3::uuid AND uea.entity_id = a.entity_id
		  ))
		ORDER BY h.created_at DESC
		LIMIT 200
	`, claims.Role, claims.EntityID, claims.UserID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "patch logs unavailable")
		return
	}
	defer rows.Close()

	departmentFilter := strings.TrimSpace(strings.ToLower(c.Query("department")))
	statusFilter := strings.TrimSpace(strings.ToLower(c.Query("status")))
	items := make([]gin.H, 0)
	for rows.Next() {
		var id, assetID, assetTag, hostname, department string
		var detailRaw []byte
		var createdAt time.Time
		if err := rows.Scan(&id, &assetID, &assetTag, &hostname, &department, &detailRaw, &createdAt); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "patch logs unavailable")
			return
		}
		var detail map[string]any
		_ = json.Unmarshal(detailRaw, &detail)
		status := patchRunStatus(detail)
		if departmentFilter != "" && strings.ToLower(department) != departmentFilter {
			continue
		}
		if statusFilter != "" && status != statusFilter {
			continue
		}
		items = append(items, gin.H{"id": id, "assetId": assetID, "assetTag": assetTag, "hostname": hostname, "department": department, "status": status, "detail": detail, "createdAt": createdAt})
	}
	if err := rows.Err(); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "patch logs unavailable")
		return
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items, "total": len(items)})
}

func (server *apiServer) listPatchAlerts(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team", "auditor") {
		return
	}
	claims := middleware.CurrentClaims(c)
	rows, err := server.db.Query(`
		SELECT aa.id::text, a.id::text, a.asset_tag, COALESCE(a.hostname, a.asset_tag), COALESCE(d.name, 'Unassigned'),
		       aa.source, aa.severity, aa.title, COALESCE(aa.detail, ''), aa.is_resolved, aa.created_at
		FROM asset_alerts aa
		JOIN assets a ON a.id = aa.asset_id
		LEFT JOIN departments d ON d.id = a.dept_id
		WHERE aa.source IN ('patch', 'salt_patch', 'salt', 'patch_inventory')
		  AND ($1 = 'super_admin' OR a.entity_id = $2::uuid OR EXISTS (
		    SELECT 1 FROM user_entity_access uea WHERE uea.user_id = $3::uuid AND uea.entity_id = a.entity_id
		  ))
		ORDER BY aa.created_at DESC LIMIT 200
	`, claims.Role, claims.EntityID, claims.UserID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "patch alerts unavailable")
		return
	}
	defer rows.Close()
	items := make([]gin.H, 0)
	for rows.Next() {
		var id, assetID, assetTag, hostname, department, source, severity, title, detail string
		var resolved bool
		var createdAt time.Time
		if err := rows.Scan(&id, &assetID, &assetTag, &hostname, &department, &source, &severity, &title, &detail, &resolved, &createdAt); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "patch alerts unavailable")
			return
		}
		items = append(items, gin.H{"id": id, "assetId": assetID, "assetTag": assetTag, "hostname": hostname, "department": department, "source": source, "severity": severity, "title": title, "detail": detail, "resolved": resolved, "createdAt": createdAt})
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items, "total": len(items)})
}

func (server *apiServer) listPatchAudit(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team", "auditor") {
		return
	}
	claims := middleware.CurrentClaims(c)
	rows, err := server.db.Query(`
		SELECT al.id::text, COALESCE(u.full_name, ''), al.action, COALESCE(al.target_type, ''),
		       COALESCE(al.target_id::text, ''), al.detail, al.created_at
		FROM audit_log al
		LEFT JOIN users u ON u.id = al.actor_id
		WHERE (al.action LIKE 'patch_%' OR al.action IN ('terminal_session', 'patch_automation_created', 'patch_policy_changed'))
		  AND ($1 = 'super_admin' OR al.entity_id = $2::uuid)
		ORDER BY al.created_at DESC LIMIT 200
	`, claims.Role, claims.EntityID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "patch audit unavailable")
		return
	}
	defer rows.Close()
	items := make([]gin.H, 0)
	for rows.Next() {
		var id, actor, action, targetType, targetID string
		var detailRaw []byte
		var createdAt time.Time
		if err := rows.Scan(&id, &actor, &action, &targetType, &targetID, &detailRaw, &createdAt); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "patch audit unavailable")
			return
		}
		var detail any
		_ = json.Unmarshal(detailRaw, &detail)
		items = append(items, gin.H{"id": id, "actor": actor, "action": action, "targetType": targetType, "targetId": targetID, "detail": detail, "createdAt": createdAt})
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items, "total": len(items)})
}

type patchPolicyInput struct {
	WindowEnabled   bool                  `json:"windowEnabled"`
	WindowStart     string                `json:"windowStart"`
	WindowEnd       string                `json:"windowEnd"`
	AllowedRings    []string              `json:"allowedRings"`
	DepartmentRings []patchDepartmentRing `json:"departmentRings"`
}

func patchPolicyResponse(settings workflowSettings) gin.H {
	return gin.H{"windowEnabled": settings.PatchWindowEnabled, "windowStart": settings.PatchWindowStart, "windowEnd": settings.PatchWindowEnd, "allowedRings": settings.PatchAllowedRings, "departmentRings": settings.PatchDepartmentRings, "updatedAt": settings.UpdatedAt}
}

func (server *apiServer) getPatchPolicies(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team", "auditor") {
		return
	}
	settings, err := server.getWorkflowSettingsRecord()
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "patch policies unavailable")
		return
	}
	httpx.JSON(c, http.StatusOK, patchPolicyResponse(settings))
}

func (server *apiServer) updatePatchPolicies(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team") {
		return
	}
	var input patchPolicyInput
	if err := bindJSONWithLimit(c, &input, 64<<10); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid patch policy payload")
		return
	}
	settings, err := server.getWorkflowSettingsRecord()
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "patch policies unavailable")
		return
	}
	settings.PatchWindowEnabled = input.WindowEnabled
	settings.PatchWindowStart = input.WindowStart
	settings.PatchWindowEnd = input.WindowEnd
	settings.PatchAllowedRings = input.AllowedRings
	settings.PatchDepartmentRings = input.DepartmentRings
	settings = normalizeWorkflowSettings(settings)
	if err := validatePatchPolicySettings(settings); err != nil {
		httpx.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	settings, err = server.saveWorkflowSettings(settings)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "patch policies unavailable")
		return
	}
	middleware.TagAudit(c, middleware.AuditMeta{Action: "patch_policy_changed", TargetType: "settings", Detail: patchPolicyResponse(settings)})
	httpx.JSON(c, http.StatusOK, patchPolicyResponse(settings))
}

func (server *apiServer) evaluatePatchPolicyRoute(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team", "auditor") {
		return
	}
	var input struct {
		Department string `json:"department"`
	}
	if err := bindJSONWithLimit(c, &input, 16<<10); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid patch policy evaluation payload")
		return
	}
	settings, err := server.getWorkflowSettingsRecord()
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "patch policies unavailable")
		return
	}
	httpx.JSON(c, http.StatusOK, evaluatePatchPolicy(time.Now(), input.Department, settings))
}

type patchAutomationInput struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Content     string `json:"content"`
	Description string `json:"description"`
}

func (server *apiServer) listPatchAutomations(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team", "auditor") {
		return
	}
	claims := middleware.CurrentClaims(c)
	rows, err := server.db.Query(`SELECT id::text, name, kind, content, description, created_at, updated_at FROM patch_automations WHERE entity_id = $1::uuid ORDER BY name`, claims.EntityID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "patch automations unavailable")
		return
	}
	defer rows.Close()
	items := make([]gin.H, 0)
	for rows.Next() {
		var id, name, kind, content, description string
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&id, &name, &kind, &content, &description, &createdAt, &updatedAt); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "patch automations unavailable")
			return
		}
		items = append(items, gin.H{"id": id, "name": name, "kind": kind, "content": content, "description": description, "createdAt": createdAt, "updatedAt": updatedAt})
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items, "total": len(items)})
}

func (server *apiServer) createPatchAutomation(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team") {
		return
	}
	var input patchAutomationInput
	if err := bindJSONWithLimit(c, &input, 256<<10); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid patch automation payload")
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Kind = strings.ToLower(strings.TrimSpace(input.Kind))
	input.Content = strings.TrimSpace(input.Content)
	if input.Name == "" || input.Content == "" || (input.Kind != "sls" && input.Kind != "sh") {
		httpx.Error(c, http.StatusBadRequest, "automation requires a name, sls or sh kind, and content")
		return
	}
	claims := middleware.CurrentClaims(c)
	var id string
	var createdAt time.Time
	err := server.db.QueryRow(`INSERT INTO patch_automations (entity_id, created_by, name, kind, content, description) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6) RETURNING id::text, created_at`, claims.EntityID, claims.UserID, input.Name, input.Kind, input.Content, strings.TrimSpace(input.Description)).Scan(&id, &createdAt)
	if err != nil {
		httpx.Error(c, http.StatusConflict, "patch automation name already exists")
		return
	}
	middleware.TagAudit(c, middleware.AuditMeta{Action: "patch_automation_created", TargetType: "patch_automation", Detail: gin.H{"id": id, "name": input.Name, "kind": input.Kind}})
	httpx.JSON(c, http.StatusCreated, gin.H{"id": id, "name": input.Name, "kind": input.Kind, "content": input.Content, "description": strings.TrimSpace(input.Description), "createdAt": createdAt})
}

func (server *apiServer) deletePatchAutomation(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team") {
		return
	}
	claims := middleware.CurrentClaims(c)
	result, err := server.db.Exec(`DELETE FROM patch_automations WHERE id = $1::uuid AND entity_id = $2::uuid`, c.Param("id"), claims.EntityID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "patch automation could not be deleted")
		return
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		httpx.Error(c, http.StatusNotFound, "patch automation not found")
		return
	}
	httpx.JSON(c, http.StatusOK, gin.H{"ok": true})
}

type patchBatchInput struct {
	TargetMode  string   `json:"targetMode"`
	Departments []string `json:"departments"`
	SystemID    string   `json:"systemId"`
	Action      string   `json:"action"`
	State       string   `json:"state"`
	Command     string   `json:"command"`
}

func (server *apiServer) runPatchBatch(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team") {
		return
	}
	var input patchBatchInput
	if err := bindJSONWithLimit(c, &input, 64<<10); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid patch batch payload")
		return
	}
	claims := middleware.CurrentClaims(c)
	mode := strings.ToLower(strings.TrimSpace(input.TargetMode))
	if mode != "departments" && mode != "system" {
		httpx.Error(c, http.StatusBadRequest, "targetMode must be departments or system")
		return
	}
	action := strings.ToLower(strings.TrimSpace(input.Action))
	if action == "test.ping" && (strings.TrimSpace(input.Command) != "" || strings.TrimSpace(input.State) != "") {
		httpx.Error(c, http.StatusBadRequest, "test.ping does not accept a shell command or Salt state")
		return
	}
	if action == "custom-command" || action == "custom_command" || action == "command" {
		fields := strings.Fields(strings.ToLower(input.Command))
		if len(fields) > 0 && fields[0] == "sudo" {
			fields = fields[1:]
		}
		if len(fields) > 0 {
			switch fields[0] {
			case "apt", "apt-get", "dnf", "yum", "zypper", "pacman", "brew", "winget", "choco":
				httpx.Error(c, http.StatusBadRequest, "package commands are blocked; review an administrator-deployed Salt state for updates or use approved software installation")
				return
			}
		}
		if err := terminalFunctionPolicy("cmd.run", []string{input.Command}); err != nil {
			httpx.Error(c, http.StatusBadRequest, err.Error())
			return
		}
	}
	rows, err := server.db.Query(`
		SELECT a.id::text, a.asset_tag
		FROM assets a
		LEFT JOIN users u ON u.id = a.assigned_to
		LEFT JOIN departments ad ON ad.id = a.dept_id
		LEFT JOIN departments ud ON ud.id = u.dept_id
		WHERE a.is_compute = TRUE
		  AND ($1 = 'super_admin' OR a.entity_id = $2::uuid OR EXISTS (SELECT 1 FROM user_entity_access uea WHERE uea.user_id = $3::uuid AND uea.entity_id = a.entity_id))
		  AND (($4 = 'system' AND (a.hostname = $5 OR a.salt_minion_id = $5 OR a.asset_tag = $5)) OR ($4 = 'departments' AND COALESCE(ad.name, ud.name, '') = ANY($6::text[])))
		ORDER BY a.hostname
	`, claims.Role, claims.EntityID, claims.UserID, mode, strings.TrimSpace(input.SystemID), pq.Array(input.Departments))
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "patch targets unavailable")
		return
	}
	defer rows.Close()
	type patchTarget struct {
		assetID  string
		assetTag string
	}
	targets := make([]patchTarget, 0)
	for rows.Next() {
		var target patchTarget
		if err := rows.Scan(&target.assetID, &target.assetTag); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "patch targets unavailable")
			return
		}
		targets = append(targets, target)
	}
	if rows.Err() != nil {
		httpx.Error(c, http.StatusInternalServerError, "patch targets unavailable")
		return
	}
	rows.Close()
	if len(targets) == 0 {
		httpx.Error(c, http.StatusNotFound, "no patch targets matched the selected scope")
		return
	}
	results := make([]gin.H, 0, len(targets))
	pingAssets := make([]dbAsset, 0, len(targets))
	for _, target := range targets {
		asset, err := server.fetchAsset(target.assetID)
		if err != nil {
			results = append(results, gin.H{"assetId": target.assetID, "assetTag": target.assetTag, "status": "failed", "error": "asset unavailable"})
			continue
		}
		if action == "test.ping" {
			pingAssets = append(pingAssets, asset)
			continue
		}
		result, err := server.queuePatchRun(c, asset, input.Action, input.State, input.Command)
		if err != nil {
			results = append(results, gin.H{"assetId": target.assetID, "assetTag": target.assetTag, "status": "failed", "error": err.Error(), "result": result})
			continue
		}
		status := strings.TrimSpace(fmt.Sprint(result["status"]))
		if status == "" || status == "<nil>" {
			status = "queued"
		}
		results = append(results, gin.H{"assetId": target.assetID, "assetTag": target.assetTag, "status": status, "result": result})
	}
	if action == "test.ping" {
		results = append(results, server.probePatchBatch(c, pingAssets)...)
	}
	middleware.TagAudit(c, middleware.AuditMeta{Action: "patch_batch_run", TargetType: "patch_batch", Detail: gin.H{"targetMode": mode, "departments": input.Departments, "systemId": input.SystemID, "results": results}})
	httpx.JSON(c, http.StatusOK, gin.H{"targetMode": mode, "targetCount": len(targets), "results": results})
}

func (server *apiServer) probePatchBatch(c *gin.Context, assets []dbAsset) []gin.H {
	targets := make([]string, 0, len(assets))
	for _, asset := range assets {
		if target := strings.TrimSpace(asset.SaltMinionID); target != "" {
			targets = append(targets, target)
		}
	}
	connected := map[string]bool{}
	probeError := "saltstack integration is not configured"
	if server.salt != nil && server.salt.Enabled() {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
		var err error
		connected, err = server.salt.ConnectedTargets(ctx, targets)
		cancel()
		probeError = ""
		if err != nil {
			probeError = "salt connectivity check unavailable"
		}
	}
	results := make([]gin.H, 0, len(assets))
	for _, asset := range assets {
		target := strings.TrimSpace(asset.SaltMinionID)
		failure := probeError
		var online any
		if target == "" {
			failure = "salt minion is not linked for this asset"
		} else if failure == "" {
			online = connected[target]
			if !connected[target] {
				failure = "salt minion is not connected to the master for this asset"
			}
		}
		status := "completed"
		if failure != "" {
			status = "failed"
		}
		result := gin.H{"target": target, "action": "test.ping", "function": "test.ping", "integration": "saltstack", "component": "patch", "status": status, "result": gin.H{"connected": online}}
		item := gin.H{"assetId": asset.ID, "assetTag": asset.AssetTag, "status": status, "result": result}
		if failure != "" {
			result["error"] = failure
			item["error"] = failure
		}
		_, err := server.recordAssetHistory(asset.ID, middleware.CurrentClaims(c).UserID, "patch_run", result)
		result["historyRecorded"] = err == nil
		results = append(results, item)
	}
	return results
}
