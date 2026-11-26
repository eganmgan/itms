package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

var securitySources = []string{"wazuh", "openscap", "clamav", "cve"}

func (server *apiServer) securityRecords(c *gin.Context) ([]alertsDashboardRecord, bool) {
	claims := middleware.CurrentClaims(c)
	if claims == nil {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized")
		return nil, false
	}
	records, err := server.loadAlertsDashboardRecords(claims, claims.Role == "employee", claims.UserID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "security data unavailable")
		return nil, false
	}
	return records, true
}

func (server *apiServer) listSecurityIntegrations(c *gin.Context) {
	records, ok := server.securityRecords(c)
	if !ok {
		return
	}
	counts := make(map[string]int, len(securitySources))
	for _, record := range records {
		counts[record.Source]++
	}
	items := make([]gin.H, 0, len(securitySources))
	for _, source := range securitySources {
		configured := source != "wazuh" || (server.wazuh != nil && server.wazuh.Enabled())
		items = append(items, gin.H{
			"source": source, "label": alertsDashboardModuleLabel(source),
			"configured": configured, "eventCount": counts[source],
		})
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items, "total": len(items)})
}

func (server *apiServer) listSecurityReports(c *gin.Context) {
	records, ok := server.securityRecords(c)
	if !ok {
		return
	}
	generatedAt := time.Now().UTC()
	items := make([]gin.H, 0, len(securitySources))
	for _, source := range securitySources {
		sourceRecords := filterAlertsDashboardRecordsBySource(records, source)
		openCount := 0
		criticalCount := 0
		resolvedCount := 0
		for _, record := range sourceRecords {
			if record.Resolved {
				resolvedCount++
			} else {
				openCount++
			}
			if strings.EqualFold(record.Severity, "critical") {
				criticalCount++
			}
		}
		items = append(items, gin.H{
			"id": source + "-current", "source": source, "label": alertsDashboardModuleLabel(source),
			"total": len(sourceRecords), "open": openCount, "critical": criticalCount,
			"resolved": resolvedCount, "generatedAt": generatedAt,
		})
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items, "total": len(items), "generatedAt": generatedAt})
}

type securityAutomationInput struct {
	Name        string `json:"name"`
	Source      string `json:"source"`
	Kind        string `json:"kind"`
	Content     string `json:"content"`
	Description string `json:"description"`
}

func (server *apiServer) listSecurityAutomations(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team", "auditor") {
		return
	}
	claims := middleware.CurrentClaims(c)
	rows, err := server.db.Query(`SELECT id::text, name, source, kind, content, description, created_at, updated_at FROM security_automations WHERE entity_id = $1::uuid ORDER BY name`, claims.EntityID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "security automations unavailable")
		return
	}
	defer rows.Close()
	items := make([]gin.H, 0)
	for rows.Next() {
		var id, name, source, kind, content, description string
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&id, &name, &source, &kind, &content, &description, &createdAt, &updatedAt); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "security automations unavailable")
			return
		}
		items = append(items, gin.H{"id": id, "name": name, "source": source, "kind": kind, "content": content, "description": description, "createdAt": createdAt, "updatedAt": updatedAt})
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items, "total": len(items)})
}

func (server *apiServer) createSecurityAutomation(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team") {
		return
	}
	var input securityAutomationInput
	if err := bindJSONWithLimit(c, &input, 256<<10); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid security automation payload")
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Source = normalizeAlertsDashboardSource(input.Source)
	input.Kind = strings.ToLower(strings.TrimSpace(input.Kind))
	input.Content = strings.TrimSpace(input.Content)
	if input.Name == "" || input.Content == "" || (input.Kind != "sls" && input.Kind != "sh") {
		httpx.Error(c, http.StatusBadRequest, "automation requires a name, sls or sh kind, and content")
		return
	}
	claims := middleware.CurrentClaims(c)
	var id string
	var createdAt time.Time
	err := server.db.QueryRow(`INSERT INTO security_automations (entity_id, created_by, name, source, kind, content, description) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7) RETURNING id::text, created_at`, claims.EntityID, claims.UserID, input.Name, input.Source, input.Kind, input.Content, strings.TrimSpace(input.Description)).Scan(&id, &createdAt)
	if err != nil {
		httpx.Error(c, http.StatusConflict, "security automation name already exists")
		return
	}
	middleware.TagAudit(c, middleware.AuditMeta{Action: "security_automation_created", TargetType: "security_automation", TargetID: id, Detail: gin.H{"name": input.Name, "source": input.Source, "kind": input.Kind}})
	httpx.JSON(c, http.StatusCreated, gin.H{"id": id, "name": input.Name, "source": input.Source, "kind": input.Kind, "content": input.Content, "description": strings.TrimSpace(input.Description), "createdAt": createdAt})
}

func (server *apiServer) deleteSecurityAutomation(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team") {
		return
	}
	claims := middleware.CurrentClaims(c)
	result, err := server.db.Exec(`DELETE FROM security_automations WHERE id = $1::uuid AND entity_id = $2::uuid`, c.Param("id"), claims.EntityID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "security automation could not be deleted")
		return
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		httpx.Error(c, http.StatusNotFound, "security automation not found")
		return
	}
	middleware.TagAudit(c, middleware.AuditMeta{Action: "security_automation_deleted", TargetType: "security_automation", TargetID: c.Param("id")})
	httpx.JSON(c, http.StatusOK, gin.H{"ok": true})
}
