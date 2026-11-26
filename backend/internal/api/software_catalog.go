package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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

type softwareCapabilities struct {
	CanManageCatalog bool `json:"canManageCatalog"`
	CanInstall       bool `json:"canInstall"`
}

func softwarePermissions(c *gin.Context) softwareCapabilities {
	claims := middleware.CurrentClaims(c)
	if claims == nil {
		return softwareCapabilities{}
	}
	return softwareCapabilities{isAdminRole(claims.Role), isAdminRole(claims.Role) || claims.Role == "it_team"}
}

func (server *apiServer) registerSoftwareRoutes(group *gin.RouterGroup) {
	group.GET("/software/permissions", server.getSoftwarePermissions)
	group.GET("/software/vendor-versions", server.listVendorVersions)
	group.GET("/software/catalog", server.listSoftwareCatalog)
	group.POST("/software/catalog", server.writeSoftwareCatalog(true))
	group.PATCH("/software/catalog/:id", server.writeSoftwareCatalog(false))
	group.POST("/assets/:id/software-install", server.installSoftware)
	group.GET("/assets/:id/software-installs", server.listSoftwareInstalls)
	group.GET("/assets/:id/software-approvals", server.listSoftwareApprovals)
	group.POST("/assets/:id/software-approvals", server.approveSoftwareTicket)
	server.registerEndpointManagementRoutes(group)
	server.registerInstallationScriptRoutes(group)
}

func (server *apiServer) getSoftwarePermissions(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	if !server.requireRoles(c, "super_admin", "admin", "it_team", "auditor", "employee") {
		return
	}
	httpx.JSON(c, http.StatusOK, softwarePermissions(c))
}

// Exact JSON keys, no nulls/duplicates/coercion/trailing data; bounded UTF-8.
func decodeSoftwareInput(reader io.Reader, install bool) (map[string]any, error) {
	body, err := io.ReadAll(io.LimitReader(reader, 16385))
	if err != nil || len(body) > 16384 || !utf8.Valid(body) {
		return nil, adminInputError("invalid software payload")
	}
	d := json.NewDecoder(bytes.NewReader(body))
	if token, err := d.Token(); err != nil || token != json.Delim('{') {
		return nil, adminInputError("expected JSON object")
	}
	values := map[string]any{}
	for d.More() {
		token, err := d.Token()
		if err != nil {
			return nil, adminInputError("invalid JSON")
		}
		key, _ := token.(string)
		if _, found := values[key]; found {
			return nil, adminInputError("duplicate field")
		}
		valid := key == "entityId" || key == "name" || key == "description" || key == "os" || key == "packageName" || key == "active"
		if install {
			valid = key == "applicationId" || key == "confirmed" || key == "requestId" || key == "approvalId"
		}
		if !valid {
			return nil, adminInputError("unknown field")
		}
		var raw json.RawMessage
		if d.Decode(&raw) != nil || string(raw) == "null" {
			return nil, adminInputError("invalid field value")
		}
		if key == "active" || key == "confirmed" {
			var value bool
			if json.Unmarshal(raw, &value) != nil {
				return nil, adminInputError("expected boolean")
			}
			values[key] = value
			continue
		}
		var value string
		if json.Unmarshal(raw, &value) != nil || strings.ContainsRune(value, 0) {
			return nil, adminInputError("expected valid string")
		}
		limit := 4000
		switch key {
		case "entityId", "applicationId", "requestId", "approvalId":
			if !adminUUID.MatchString(value) || strings.EqualFold(value, "00000000-0000-0000-0000-000000000000") {
				return nil, adminInputError("invalid UUID")
			}
			value = strings.ToLower(value)
		case "name":
			value = strings.TrimSpace(value)
			limit = 150
			if value == "" {
				return nil, adminInputError("name is required")
			}
		case "os":
			if value != "linux" && value != "windows" && value != "macos" {
				return nil, adminInputError("unsupported os")
			}
		case "packageName":
			if !saltstack.ValidPackageIdentifier(value) {
				return nil, adminInputError("invalid packageName")
			}
		}
		if utf8.RuneCountInString(value) > limit {
			return nil, adminInputError("field too long")
		}
		values[key] = value
	}
	if _, err := d.Token(); err != nil {
		return nil, adminInputError("invalid JSON")
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, adminInputError("unexpected trailing JSON")
	}
	if len(values) == 0 {
		return nil, adminInputError("at least one field is required")
	}
	if install && (values["applicationId"] == nil || values["requestId"] == nil || values["confirmed"] != true) {
		return nil, adminInputError("applicationId, requestId and confirmed:true are required")
	}
	return values, nil
}

type softwareApplication struct {
	ID          string    `json:"id"`
	EntityID    string    `json:"entityId"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	OS          string    `json:"os"`
	PackageName string    `json:"packageName"`
	Active      bool      `json:"active"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

const softwareCatalogColumns = `id::text, entity_id::text, name, description, os, package_name, active, updated_at`

type softwareScanner interface{ Scan(...any) error }

func scanSoftwareApplication(row softwareScanner) (item softwareApplication, err error) {
	err = row.Scan(&item.ID, &item.EntityID, &item.Name, &item.Description, &item.OS, &item.PackageName, &item.Active, &item.UpdatedAt)
	return
}

func (server *apiServer) listSoftwareCatalog(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	if !server.requireRoles(c, "super_admin", "admin", "it_team", "auditor") {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 8*time.Second)
	defer cancel()
	args := []any{}
	where := adminEntityPredicate(c, "x.entity_id", &args)
	for _, filter := range []struct{ key, column string }{{"entityId", "entity_id"}, {"os", "os"}, {"active", "active"}} {
		if value := c.Query(filter.key); value != "" {
			if (filter.key == "entityId" && !adminUUID.MatchString(value)) || (filter.key == "os" && value != "linux" && value != "windows" && value != "macos") || (filter.key == "active" && value != "true" && value != "false") {
				adminCatalogError(c, adminInputError("invalid filter"))
				return
			}
			args = append(args, value)
			where += fmt.Sprintf(" AND x.%s = $%d", filter.column, len(args))
		}
	}
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil || page < 1 || page > 1000000 {
		adminCatalogError(c, adminInputError("invalid page"))
		return
	}
	args = append(args, (page-1)*50)
	rows, err := server.db.QueryContext(ctx, `SELECT `+softwareCatalogColumns+` FROM application_catalog x WHERE `+where+fmt.Sprintf(` ORDER BY name, id LIMIT 51 OFFSET $%d`, len(args)), args...)
	if err != nil {
		adminCatalogError(c, err)
		return
	}
	defer rows.Close()
	items := []softwareApplication{}
	for rows.Next() {
		item, err := scanSoftwareApplication(rows)
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
	more := len(items) > 50
	if more {
		items = items[:50]
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items, "capabilities": softwarePermissions(c), "page": page, "hasMore": more})
}

func (server *apiServer) writeSoftwareCatalog(create bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		if !server.requireRoles(c, "super_admin", "admin") {
			return
		}
		if !create && !adminUUID.MatchString(c.Param("id")) {
			adminCatalogError(c, adminInputError("invalid UUID"))
			return
		}
		input, err := decodeSoftwareInput(c.Request.Body, false)
		if err != nil {
			adminCatalogError(c, err)
			return
		}
		if !create && input["entityId"] != nil {
			adminCatalogError(c, adminInputError("entityId is immutable"))
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
		item := softwareApplication{Active: true}
		if !create {
			item, err = scanSoftwareApplication(tx.QueryRowContext(ctx, `SELECT `+softwareCatalogColumns+` FROM application_catalog WHERE id = $1::uuid FOR UPDATE`, c.Param("id")))
			if err != nil {
				adminCatalogError(c, err)
				return
			}
		}
		for key, value := range input {
			switch key {
			case "entityId":
				item.EntityID = value.(string)
			case "name":
				item.Name = value.(string)
			case "description":
				item.Description = value.(string)
			case "os":
				item.OS = value.(string)
			case "packageName":
				item.PackageName = value.(string)
			case "active":
				item.Active = value.(bool)
			}
		}
		if item.EntityID == "" || item.Name == "" || item.OS == "" || item.PackageName == "" {
			adminCatalogError(c, adminInputError("entityId, name, os and packageName are required"))
			return
		}
		if create {
			var exists bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM entities WHERE id = $1::uuid AND is_active)`, item.EntityID).Scan(&exists); err != nil {
				adminCatalogError(c, err)
				return
			}
			if !exists {
				adminCatalogError(c, adminInputError("entity is unavailable"))
				return
			}
			item, err = scanSoftwareApplication(tx.QueryRowContext(ctx, `INSERT INTO application_catalog (entity_id, name, description, os, package_name, active, created_by) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid) RETURNING `+softwareCatalogColumns,
				item.EntityID, item.Name, item.Description, item.OS, item.PackageName, item.Active, middleware.CurrentClaims(c).UserID))
		} else {
			item, err = scanSoftwareApplication(tx.QueryRowContext(ctx, `UPDATE application_catalog SET name=$2, description=$3, os=$4, package_name=$5, active=$6, updated_at=NOW() WHERE id=$1::uuid RETURNING `+softwareCatalogColumns,
				item.ID, item.Name, item.Description, item.OS, item.PackageName, item.Active))
		}
		if err != nil {
			adminCatalogError(c, err)
			return
		}
		if err := tx.Commit(); err != nil {
			adminCatalogError(c, err)
			return
		}
		middleware.TagAudit(c, middleware.AuditMeta{Action: "application_catalog_changed", TargetType: "application_catalog", TargetID: item.ID, EntityID: item.EntityID, Detail: item})
		status := http.StatusOK
		if create {
			status = http.StatusCreated
		}
		httpx.JSON(c, status, item)
	}
}
