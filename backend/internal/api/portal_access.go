package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"
	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

var portalSections = []string{"devices", "patch", "security", "employee", "gatepass"}

type portalAccess struct {
	Role       string   `json:"role"`
	Sections   []string `json:"sections"`
	ReadOnly   bool     `json:"readOnly"`
	Customized bool     `json:"customized"`
}

const portalAccessSQL = `SELECT r.name, u.is_active, s.value FROM users u
	JOIN roles r ON r.id = u.role_id
	LEFT JOIN settings s ON s.key = 'portal_access:' || u.id::text
	WHERE u.id = $1::uuid`

func defaultPortalSections(role string) []string {
	switch role {
	case "super_admin", "admin", "it_team", "auditor":
		return append([]string{}, portalSections...)
	case "employee":
		return []string{"devices", "security", "employee"}
	default:
		return []string{}
	}
}

func normalizePortalSections(sections []string) ([]string, error) {
	selected := map[string]bool{}
	for _, section := range sections {
		known := false
		for _, candidate := range portalSections {
			if candidate == section {
				known = true
			}
		}
		if !known {
			return nil, fmt.Errorf("invalid portal section")
		}
		selected[section] = true
	}
	result := []string{}
	for _, section := range portalSections {
		if selected[section] {
			result = append(result, section)
		}
	}
	return result, nil
}

func (server *apiServer) loadPortalAccess(userID string) (portalAccess, error) {
	var role string
	var active bool
	var stored sql.NullString
	if err := server.db.QueryRow(portalAccessSQL, userID).Scan(&role, &active, &stored); err != nil {
		return portalAccess{}, err
	}
	if !active {
		return portalAccess{}, sql.ErrNoRows
	}
	access := portalAccess{Role: role, Sections: defaultPortalSections(role), ReadOnly: role == "auditor"}
	if stored.Valid && role != "super_admin" {
		var input struct {
			Sections *[]string `json:"sections"`
		}
		if err := json.Unmarshal([]byte(stored.String), &input); err != nil || input.Sections == nil {
			return portalAccess{}, fmt.Errorf("invalid portal access record")
		}
		sections, err := normalizePortalSections(*input.Sections)
		if err != nil {
			return portalAccess{}, err
		}
		access.Sections, access.Customized = sections, true
	}
	return access, nil
}

func (server *apiServer) getMyPortalAccess(c *gin.Context) {
	access, err := server.loadPortalAccess(middleware.CurrentClaims(c).UserID)
	if err != nil {
		httpx.Error(c, http.StatusForbidden, "Portal access unavailable")
		return
	}
	httpx.JSON(c, http.StatusOK, access)
}

func (server *apiServer) managePortalAccess(c *gin.Context) {
	claims := middleware.CurrentClaims(c)
	actor, err := server.loadPortalAccess(claims.UserID)
	if err != nil || actor.Role != "super_admin" {
		httpx.Error(c, http.StatusForbidden, "Super-admin permission required")
		return
	}
	var userID pgtype.UUID
	if err := userID.Scan(c.Param("id")); err != nil || !userID.Valid {
		httpx.Error(c, http.StatusBadRequest, "Invalid user ID")
		return
	}
	canonicalID, _ := userID.Value()
	targetID := canonicalID.(string)
	target, err := server.loadPortalAccess(targetID)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "User unavailable")
		return
	}
	if c.Request.Method == http.MethodGet {
		httpx.JSON(c, http.StatusOK, target)
		return
	}
	if target.Role == "super_admin" {
		httpx.Error(c, http.StatusBadRequest, "Super-admin sections cannot be restricted")
		return
	}
	var input struct {
		Sections    *[]string `json:"sections"`
		UseDefaults bool      `json:"useDefaults"`
	}
	if err := bindJSONWithLimit(c, &input, 4096); err != nil || (!input.UseDefaults && input.Sections == nil) {
		httpx.Error(c, http.StatusBadRequest, "Choose portal sections")
		return
	}
	key := "portal_access:" + targetID
	if input.UseDefaults {
		_, err = server.db.Exec(`DELETE FROM settings WHERE key = $1`, key)
		target.Sections, target.Customized = defaultPortalSections(target.Role), false
	} else {
		sections, validation := normalizePortalSections(*input.Sections)
		if validation != nil {
			httpx.Error(c, http.StatusBadRequest, "Invalid portal section")
			return
		}
		payload, _ := json.Marshal(gin.H{"sections": sections})
		_, err = server.db.Exec(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, key, string(payload))
		target.Sections, target.Customized = sections, true
	}
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "Portal access update failed")
		return
	}
	middleware.TagAudit(c, middleware.AuditMeta{Action: "portal_access_changed", TargetType: "user", TargetID: targetID, Detail: target})
	httpx.JSON(c, http.StatusOK, target)
}

func portalSectionForPath(path string) string {
	if strings.HasPrefix(path, "/ws/ssh/") {
		return "patch"
	}
	path = strings.TrimPrefix(path, "/api/")
	path = strings.TrimPrefix(path, "v1/")
	for _, prefix := range []string{"patch", "salt", "ssh", "terminal"} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return "patch"
		}
	}
	for _, prefix := range []string{"devices", "assets", "inventory", "inventory-sync", "items", "sub-items", "software", "me/assets"} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return "devices"
		}
	}
	for _, prefix := range []string{"security", "alerts", "me/alerts"} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return "security"
		}
	}
	for _, prefix := range []string{"users", "requests", "me/requests", "tickets", "tasks", "ticket-attachments", "ticket-categories", "reports/service-desk", "announcements", "docs", "vault"} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return "employee"
		}
	}
	if path == "gatepass" || strings.HasPrefix(path, "gatepass/") {
		return "gatepass"
	}
	return ""
}

func (server *apiServer) portalAccessGuard(c *gin.Context) {
	claims := middleware.CurrentClaims(c)
	if claims == nil {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	path := c.Request.URL.Path
	if c.FullPath() == "/api/me/portal-access" || c.FullPath() == "/api/users/:id/portal-access" {
		c.Next()
		return
	}
	if claims.Role == "auditor" && c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "Auditor portal is read-only"})
		return
	}
	if claims.Role == "super_admin" {
		c.Next()
		return
	}
	section := portalSectionForPath(path)
	if section == "" {
		c.Next()
		return
	}
	access, err := server.loadPortalAccess(claims.UserID)
	if err != nil {
		status := http.StatusServiceUnavailable
		if errors.Is(err, sql.ErrNoRows) {
			status = http.StatusForbidden
		}
		c.AbortWithStatusJSON(status, gin.H{"error": "Portal access unavailable"})
		return
	}
	if access.ReadOnly && ((c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead) || strings.HasPrefix(path, "/ws/")) {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "Auditor portal is read-only"})
		return
	}
	if section != "" && access.Role != "super_admin" {
		allowed := false
		for _, enabled := range access.Sections {
			if enabled == section {
				allowed = true
			}
		}
		if !allowed {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "This portal section is disabled"})
			return
		}
	}
	c.Next()
}
