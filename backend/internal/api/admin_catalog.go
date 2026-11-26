package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/lib/pq"

	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

// Identifiers come only from these server-owned definitions, never request keys.
type adminCatalogField struct {
	key, column string
	limit       int
	required    bool
}

type adminCatalog struct {
	table, target string
	scoped        bool
	fields        []adminCatalogField
}

var adminSuppliers = adminCatalog{"suppliers", "admin_supplier", false, []adminCatalogField{
	{"name", "name", 150, true}, {"contactInfo", "contact_info", 4000, false},
}}
var adminScripts = adminCatalog{"admin_installation_scripts", "admin_installation_script", true, []adminCatalogField{
	{"entityId", "entity_id", 36, false}, {"name", "name", 150, true},
	{"type", "type", 10, true}, {"os", "os", 30, true},
	{"body", "body", 48000, true}, {"description", "description", 4000, false},
	{"category", "category", 20, false},
}}

func (server *apiServer) registerAdminCatalogRoutes(group *gin.RouterGroup) {
	for path, catalog := range map[string]adminCatalog{"/admin/suppliers": adminSuppliers, "/admin/scripts": adminScripts} {
		group.GET(path, server.readAdminCatalog(catalog, false))
		group.GET(path+"/:id", server.readAdminCatalog(catalog, true))
		group.POST(path, server.writeAdminCatalog(catalog, true))
		group.PATCH(path+"/:id", server.writeAdminCatalog(catalog, false))
	}
}

// Strict, bounded, sparse decoding: no folded/duplicate keys, coercions or trailing JSON.
func decodeAdminCatalog(reader io.Reader, catalog adminCatalog, create bool) (map[string]any, error) {
	body, err := io.ReadAll(io.LimitReader(reader, 262145))
	if err != nil || len(body) > 262144 || !utf8.Valid(body) {
		return nil, adminInputError("invalid or oversized UTF-8 payload")
	}
	d := json.NewDecoder(bytes.NewReader(body))
	if token, err := d.Token(); err != nil || token != json.Delim('{') {
		return nil, adminInputError("expected a JSON object")
	}
	values := map[string]any{}
	for d.More() {
		token, err := d.Token()
		if err != nil {
			return nil, adminInputError("invalid JSON")
		}
		key, _ := token.(string)
		var field *adminCatalogField
		for i := range catalog.fields {
			if catalog.fields[i].key == key {
				field = &catalog.fields[i]
				break
			}
		}
		if field == nil {
			return nil, adminInputError("unknown field")
		}
		if _, exists := values[key]; exists {
			return nil, adminInputError("duplicate field")
		}
		var value *string
		if err := d.Decode(&value); err != nil {
			return nil, adminInputError("fields must be strings or null")
		}
		if value == nil {
			if field.required || key == "category" {
				return nil, adminInputError(key + " is required")
			}
			values[key] = nil
			continue
		}
		text := *value
		if key != "body" {
			text = strings.TrimSpace(text)
		}
		if strings.ContainsRune(text, 0) || utf8.RuneCountInString(text) > field.limit || (field.required && strings.TrimSpace(text) == "") {
			return nil, adminInputError("invalid " + key)
		}
		switch key {
		case "category":
			if text != "application" && text != "service" {
				return nil, adminInputError("category must be application or service")
			}
		case "entityId":
			if !adminUUID.MatchString(text) {
				return nil, adminInputError("invalid entity UUID")
			}
			text = strings.ToLower(text)
		case "type":
			if text != "sh" {
				return nil, adminInputError("type must be sh")
			}
		case "os":
			if text != "default" && text != "Ubuntu" && text != "Debian" && text != "Rocky Linux" {
				return nil, adminInputError("unsupported platform")
			}
		}
		if text == "" {
			values[key] = nil
		} else {
			values[key] = text
		}
	}
	if _, err := d.Token(); err != nil {
		return nil, adminInputError("invalid JSON")
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, adminInputError("unexpected trailing JSON")
	}
	if create {
		for _, field := range catalog.fields {
			if field.required && values[field.key] == nil {
				return nil, adminInputError(field.key + " is required")
			}
		}
	}
	if len(values) == 0 {
		return nil, adminInputError("at least one field is required")
	}
	return values, nil
}

func adminCatalogError(c *gin.Context, err error) {
	var input adminInputError
	var pg *pq.Error
	switch {
	case errors.As(err, &input):
		httpx.Error(c, http.StatusBadRequest, input.Error())
	case errors.Is(err, sql.ErrNoRows):
		httpx.Error(c, http.StatusNotFound, "record not found")
	case errors.As(err, &pg) && (pg.Code == "23505" || pg.Code == "40001" || pg.Code == "40P01"):
		httpx.Error(c, http.StatusConflict, "record conflicts with an existing record or concurrent change")
	case errors.As(err, &pg) && pg.Code == "23503":
		httpx.Error(c, http.StatusBadRequest, "related record no longer exists")
	default:
		httpx.Error(c, http.StatusInternalServerError, "administration operation failed")
	}
}

func (catalog adminCatalog) selectSQL(detail bool) string {
	parts := []string{"'id', x.id", "'updatedAt', x.updated_at"}
	for _, field := range catalog.fields {
		// Lists never include script bodies. No credentials or internal fields are selected.
		if !detail && field.key == "body" {
			continue
		}
		parts = append(parts, "'"+field.key+"', x."+field.column)
	}
	return "SELECT json_build_object(" + strings.Join(parts, ", ") + ") FROM " + catalog.table + " x"
}

func (catalog adminCatalog) scope(c *gin.Context, args *[]any) string {
	if catalog.scoped {
		predicate := adminEntityPredicate(c, "x.entity_id", args)
		if predicate != "TRUE" {
			return "(x.entity_id IS NULL OR " + predicate + ")"
		}
		return predicate
	}
	return "TRUE"
}

func (catalog adminCatalog) load(c *gin.Context, db adminAssetQuerier, id string, lock bool) (map[string]any, error) {
	args := []any{id}
	query := catalog.selectSQL(true) + " WHERE x.id = $1::uuid AND " + catalog.scope(c, &args)
	if lock {
		query += " FOR UPDATE OF x"
	}
	var raw []byte
	if err := db.QueryRowContext(c.Request.Context(), query, args...).Scan(&raw); err != nil {
		return nil, err
	}
	var value map[string]any
	err := json.Unmarshal(raw, &value)
	return value, err
}

func (server *apiServer) readAdminCatalog(catalog adminCatalog, detail bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		if !server.requireRoles(c, "admin", "super_admin") {
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 8*time.Second)
		defer cancel()
		c.Request = c.Request.WithContext(ctx)
		if detail {
			if !adminUUID.MatchString(c.Param("id")) {
				adminCatalogError(c, adminInputError("invalid record UUID"))
				return
			}
			item, err := catalog.load(c, server.db, c.Param("id"), false)
			if err != nil {
				adminCatalogError(c, err)
				return
			}
			httpx.JSON(c, http.StatusOK, item)
			return
		}
		page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
		if err != nil || page < 1 || page > 1000000 {
			adminCatalogError(c, adminInputError("invalid page"))
			return
		}
		args := []any{}
		where := catalog.scope(c, &args)
		if entity := c.Query("entityId"); entity != "" {
			if !catalog.scoped || !adminUUID.MatchString(entity) {
				adminCatalogError(c, adminInputError("invalid entity filter"))
				return
			}
			entity = strings.ToLower(entity)
			allowed, err := adminAssetEntityAllowed(c, server.db, entity)
			if err != nil {
				adminCatalogError(c, err)
				return
			}
			if !allowed {
				httpx.Error(c, http.StatusForbidden, "entity is outside your scope")
				return
			}
			args = append(args, entity)
			where += fmt.Sprintf(" AND x.entity_id = $%d::uuid", len(args))
		}
		args = append(args, (page-1)*50)
		query := catalog.selectSQL(false) + " WHERE " + where + fmt.Sprintf(" ORDER BY x.name, x.id LIMIT 51 OFFSET $%d", len(args))
		rows, err := server.db.QueryContext(ctx, query, args...)
		if err != nil {
			adminCatalogError(c, err)
			return
		}
		defer rows.Close()
		items := []json.RawMessage{}
		for rows.Next() {
			var raw []byte
			if err := rows.Scan(&raw); err != nil {
				adminCatalogError(c, err)
				return
			}
			items = append(items, json.RawMessage(raw))
		}
		if err := rows.Err(); err != nil {
			adminCatalogError(c, err)
			return
		}
		hasMore := len(items) > 50
		if hasMore {
			items = items[:50]
		}
		httpx.JSON(c, http.StatusOK, gin.H{"items": items, "page": page, "hasMore": hasMore,
			"canWrite": catalog.scoped || isAdminRole(middleware.CurrentClaims(c).Role)})
	}
}

func (server *apiServer) writeAdminCatalog(catalog adminCatalog, create bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		if !server.requireRoles(c, "admin", "super_admin") {
			return
		}
		if !catalog.scoped && !server.requireRoles(c, "super_admin", "admin") {
			return
		}
		id := c.Param("id")
		if !create && !adminUUID.MatchString(id) {
			adminCatalogError(c, adminInputError("invalid record UUID"))
			return
		}
		input, err := decodeAdminCatalog(c.Request.Body, catalog, create)
		if err != nil {
			adminCatalogError(c, err)
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 8*time.Second)
		defer cancel()
		c.Request = c.Request.WithContext(ctx)
		tx, err := server.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
		if err != nil {
			adminCatalogError(c, err)
			return
		}
		defer tx.Rollback()
		values := map[string]any{}
		if !create {
			values, err = catalog.load(c, tx, id, true)
			if err != nil {
				adminCatalogError(c, err)
				return
			}
			if catalog.scoped && values["entityId"] == nil && !server.requireRoles(c, "super_admin", "admin") {
				return
			}
		}
		for key, value := range input {
			values[key] = value
		}
		entity := ""
		if catalog.scoped {
			entity, _ = values["entityId"].(string)
			if entity == "" && !server.requireRoles(c, "super_admin", "admin") {
				return
			}
		}
		if catalog.scoped && entity != "" {
			allowed, err := adminAssetEntityAllowed(c, tx, entity)
			if err != nil {
				adminCatalogError(c, err)
				return
			}
			if !allowed {
				httpx.Error(c, http.StatusForbidden, "entity is outside your scope")
				return
			}
			var active bool
			if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM entities WHERE id = $1::uuid AND is_active)", entity).Scan(&active); err != nil {
				adminCatalogError(c, err)
				return
			}
			if !active {
				adminCatalogError(c, adminInputError("entity is not active"))
				return
			}
		}
		args := []any{}
		if !create {
			args = append(args, id)
		}
		columns, placeholders, assignments, changed := []string{}, []string{}, []string{}, []string{}
		for _, field := range catalog.fields {
			value, exists := input[field.key]
			if !exists {
				continue
			}
			args = append(args, value)
			expr := fmt.Sprintf("$%d", len(args))
			if field.key == "entityId" {
				expr += "::uuid"
			}
			columns = append(columns, field.column)
			placeholders = append(placeholders, expr)
			assignments = append(assignments, field.column+" = "+expr)
			changed = append(changed, field.key)
		}
		if create {
			if catalog.scoped {
				args = append(args, middleware.CurrentClaims(c).UserID)
				columns = append(columns, "created_by")
				placeholders = append(placeholders, fmt.Sprintf("$%d::uuid", len(args)))
			}
			err = tx.QueryRowContext(ctx, "INSERT INTO "+catalog.table+" ("+strings.Join(columns, ", ")+") VALUES ("+strings.Join(placeholders, ", ")+") RETURNING id::text", args...).Scan(&id)
		} else {
			_, err = tx.ExecContext(ctx, "UPDATE "+catalog.table+" SET "+strings.Join(assignments, ", ")+", updated_at = NOW() WHERE id = $1::uuid", args...)
		}
		if err != nil {
			adminCatalogError(c, err)
			return
		}
		action := catalog.target + "_updated"
		if create {
			action = catalog.target + "_created"
		}
		// Transactional audit contains changed field names, never script/contact contents.
		detail, _ := json.Marshal(gin.H{"fields": changed})
		_, err = tx.ExecContext(ctx, `INSERT INTO audit_log (actor_id, entity_id, action, target_type, target_id, detail)
			VALUES ($1::uuid, NULLIF($2, '')::uuid, $3, $4, $5::uuid, $6::jsonb)`, middleware.CurrentClaims(c).UserID, entity, action, catalog.target, id, string(detail))
		if err != nil {
			adminCatalogError(c, err)
			return
		}
		result, err := catalog.load(c, tx, id, false)
		if err != nil {
			adminCatalogError(c, err)
			return
		}
		if err := tx.Commit(); err != nil {
			adminCatalogError(c, err)
			return
		}
		if create {
			httpx.Created(c, result)
		} else {
			httpx.JSON(c, http.StatusOK, result)
		}
	}
}
