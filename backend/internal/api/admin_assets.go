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
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/lib/pq"

	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

// This allowlist is also the SQL identifier source. Never interpolate request keys.
type adminAssetField struct {
	key, column, cast string
	limit             int
	required, compute bool
}

var adminAssetFields = []adminAssetField{
	{"entityId", "entity_id", "uuid", 36, true, false},
	{"assetTag", "asset_tag", "text", 20, true, false},
	{"name", "name", "text", 150, true, false},
	{"category", "category", "text", 50, true, false},
	{"hostname", "hostname", "text", 100, false, false},
	{"manufacturer", "manufacturer", "text", 100, false, false},
	{"model", "model", "text", 100, false, false},
	{"serialNumber", "serial_number", "text", 100, false, false},
	{"locationId", "location_id", "uuid", 36, false, false},
	{"deptId", "dept_id", "uuid", 36, false, false},
	{"assignedUserId", "assigned_to", "uuid", 36, false, false},
	{"technicianInChargeId", "technician_in_charge_id", "uuid", 36, false, false},
	{"groupInChargeId", "group_in_charge_id", "uuid", 36, false, false},
	{"status", "status", "text", 30, true, false},
	{"purchaseDate", "purchase_date", "date", 10, false, false},
	{"supplierId", "supplier_id", "uuid", 36, false, false},
	{"cost", "cost", "numeric(12,2)", 13, false, false},
	{"warrantyStartDate", "warranty_start_date", "date", 10, false, false},
	{"warrantyDurationMonths", "warranty_duration_months", "integer", 0, false, false},
	{"updateSources", "update_sources", "text", 4000, false, false},
	{"osName", "os_name", "text", 255, false, true},
	{"architecture", "architecture", "text", 100, false, true},
	{"notes", "notes", "text", 10000, false, false},
}

var adminUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var adminCost = regexp.MustCompile(`^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$`)

type adminInputError string

func (err adminInputError) Error() string { return string(err) }

// Decode tokens, not a Go struct: encoding/json otherwise accepts case-folded keys
// and duplicate keys. Omitted keys and explicit null must remain distinguishable.
func decodeAdminAsset(r io.Reader, create bool) (map[string]any, error) {
	body, err := io.ReadAll(io.LimitReader(r, 65537))
	if err != nil || len(body) > 65536 {
		return nil, adminInputError("invalid or oversized payload")
	}
	if !utf8.Valid(body) {
		return nil, adminInputError("payload must be valid UTF-8")
	}
	d := json.NewDecoder(bytes.NewReader(body))
	start, err := d.Token()
	if err != nil || start != json.Delim('{') {
		return nil, adminInputError("expected a JSON object")
	}
	values := make(map[string]any)
	for d.More() {
		token, err := d.Token()
		if err != nil {
			return nil, adminInputError("invalid JSON")
		}
		key, ok := token.(string)
		if !ok {
			return nil, adminInputError("invalid field")
		}
		var field *adminAssetField
		for i := range adminAssetFields {
			if adminAssetFields[i].key == key {
				field = &adminAssetFields[i]
				break
			}
		}
		if field == nil {
			return nil, adminInputError("unknown field: " + key)
		}
		if _, exists := values[key]; exists {
			return nil, adminInputError("duplicate field: " + key)
		}
		var raw json.RawMessage
		if d.Decode(&raw) != nil {
			return nil, adminInputError("invalid JSON")
		}
		if bytes.Equal(raw, []byte("null")) {
			if field.required {
				return nil, adminInputError(key + " cannot be null")
			}
			values[key] = nil
			continue
		}
		if key == "warrantyDurationMonths" {
			var months int
			if json.Unmarshal(raw, &months) != nil || months < 0 || months > 1200 {
				return nil, adminInputError("warrantyDurationMonths must be an integer from 0 to 1200")
			}
			values[key] = months
			continue
		}
		var value string
		if json.Unmarshal(raw, &value) != nil {
			return nil, adminInputError(key + " must be a string or null")
		}
		value = strings.TrimSpace(value)
		if strings.ContainsRune(value, 0) || utf8.RuneCountInString(value) > field.limit || (field.required && value == "") {
			return nil, adminInputError("invalid " + key)
		}
		if value == "" && !field.required {
			values[key] = nil
			continue
		}
		switch field.cast {
		case "uuid":
			if !adminUUID.MatchString(value) {
				return nil, adminInputError("invalid " + key + " UUID")
			}
			value = strings.ToLower(value)
		case "date":
			date, err := time.Parse("2006-01-02", value)
			if err != nil || date.Year() < 1 || date.Year() > 9999 {
				return nil, adminInputError("invalid " + key + "; use YYYY-MM-DD (0001–9999)")
			}
		case "numeric(12,2)":
			if !adminCost.MatchString(value) {
				return nil, adminInputError("cost must be an exact nonnegative decimal string with at most 10 integer and 2 fractional digits")
			}
			parts := strings.Split(value, ".")
			if len(parts) == 1 {
				value += ".00"
			} else if len(parts[1]) == 1 {
				value += "0"
			}
		}
		if key == "hostname" && !hostnamePattern.MatchString(value) {
			return nil, adminInputError("hostname must be lowercase alphanumeric and hyphens")
		}
		values[key] = value
	}
	if _, err := d.Token(); err != nil {
		return nil, adminInputError("invalid JSON")
	}
	if _, err := d.Token(); err != io.EOF || d.InputOffset() > 65536 {
		return nil, adminInputError("unexpected trailing JSON or oversized payload")
	}
	if create {
		if _, exists := values["status"]; !exists {
			values["status"] = "in_use"
		}
		for _, field := range adminAssetFields {
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

func adminWarranty(values map[string]any) (any, error) {
	start, _ := values["warrantyStartDate"].(string)
	monthsValue := values["warrantyDurationMonths"]
	if start == "" || monthsValue == nil {
		return nil, nil
	}
	months := 0
	switch value := monthsValue.(type) {
	case int:
		months = value
	case json.Number:
		n, err := strconv.Atoi(string(value))
		if err != nil {
			return nil, adminInputError("invalid warranty duration")
		}
		months = n
	default:
		return nil, adminInputError("invalid warranty duration")
	}
	date, err := time.Parse("2006-01-02", start)
	if err != nil || months < 0 || months > 1200 {
		return nil, adminInputError("invalid warranty dates")
	}
	first := time.Date(date.Year(), date.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, months, 0)
	if first.Year() < 1 || first.Year() > 9999 {
		return nil, adminInputError("warrantyUntil exceeds year 9999")
	}
	day := date.Day()
	if last := first.AddDate(0, 1, -1).Day(); day > last {
		day = last
	}
	return first.AddDate(0, 0, day-1).Format("2006-01-02"), nil
}

func adminAssetSelect() string {
	parts := []string{"'id', a.id", "'isCompute', a.is_compute", "'warrantyUntil', to_char(a.warranty_until, 'YYYY-MM-DD')"}
	for _, field := range adminAssetFields {
		column := "a." + field.column
		if field.compute {
			column = "cd." + field.column
		}
		if field.cast == "date" {
			column = "to_char(" + column + ", 'YYYY-MM-DD')"
		} else if field.key == "cost" {
			column += "::text"
		}
		parts = append(parts, "'"+field.key+"', "+column)
	}
	return "SELECT json_build_object(" + strings.Join(parts, ", ") + ") FROM assets a LEFT JOIN asset_compute_details cd ON cd.asset_id = a.id"
}

type adminAssetQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func loadAdminAsset(ctx context.Context, db adminAssetQuerier, id string, lock bool) (map[string]any, error) {
	query := adminAssetSelect() + " WHERE a.id = $1::uuid AND a.is_compute = TRUE"
	if lock {
		query += " FOR UPDATE OF a"
	}
	var raw []byte
	if err := db.QueryRowContext(ctx, query, id).Scan(&raw); err != nil {
		return nil, err
	}
	var result map[string]any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	err := d.Decode(&result)
	return result, err
}

func adminAssetError(c *gin.Context, err error) {
	var input adminInputError
	var pg *pq.Error
	switch {
	case errors.As(err, &input):
		httpx.Error(c, http.StatusBadRequest, input.Error())
	case errors.Is(err, sql.ErrNoRows):
		httpx.Error(c, http.StatusNotFound, "computer not found")
	case errors.As(err, &pg) && (pg.Code == "23505" || pg.Code == "40001" || pg.Code == "40P01"):
		httpx.Error(c, http.StatusConflict, "computer conflicts with an existing record or concurrent change")
	case errors.As(err, &pg) && pg.Code == "23503":
		httpx.Error(c, http.StatusBadRequest, "related record no longer exists")
	default:
		httpx.Error(c, http.StatusInternalServerError, "computer operation failed")
	}
}

func (server *apiServer) createAdminAsset(c *gin.Context) { server.writeAdminAsset(c, true) }
func (server *apiServer) patchAdminAsset(c *gin.Context)  { server.writeAdminAsset(c, false) }

func (server *apiServer) writeAdminAsset(c *gin.Context, create bool) {
	if !server.requireRoles(c, "super_admin", "admin") {
		return
	}
	id := c.Param("id")
	if !create && !adminUUID.MatchString(id) {
		adminAssetError(c, adminInputError("invalid computer UUID"))
		return
	}
	input, err := decodeAdminAsset(c.Request.Body, create)
	if err != nil {
		adminAssetError(c, err)
		return
	}
	tx, err := server.db.BeginTx(c.Request.Context(), &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		adminAssetError(c, err)
		return
	}
	defer tx.Rollback()
	values := make(map[string]any)
	if !create {
		values, err = loadAdminAsset(c.Request.Context(), tx, id, true)
		if err != nil {
			adminAssetError(c, err)
			return
		}
		allowed, scopeErr := adminAssetEntityAllowed(c, tx, fmt.Sprint(values["entityId"]))
		if scopeErr != nil {
			adminAssetError(c, scopeErr)
			return
		}
		if !allowed {
			adminAssetError(c, sql.ErrNoRows)
			return
		}
	}
	for key, value := range input {
		values[key] = value
	}
	entityID, _ := values["entityId"].(string)
	allowed, scopeErr := adminAssetEntityAllowed(c, tx, entityID)
	if scopeErr != nil {
		adminAssetError(c, scopeErr)
		return
	}
	if !allowed {
		httpx.Error(c, http.StatusForbidden, "entity is outside your scope")
		return
	}
	if err := validateAdminAssetLinks(c.Request.Context(), tx, values); err != nil {
		adminAssetError(c, err)
		return
	}
	_, startChanged := input["warrantyStartDate"]
	_, durationChanged := input["warrantyDurationMonths"]
	if create || startChanged || durationChanged {
		values["warrantyUntil"], err = adminWarranty(values)
		if err != nil {
			adminAssetError(c, err)
			return
		}
	}
	columns, expressions, assignments := []string{}, []string{}, []string{}
	args := []any{}
	if !create {
		args = append(args, id)
	}
	for _, field := range adminAssetFields {
		if field.compute {
			continue
		}
		if _, exists := input[field.key]; !exists {
			continue
		}
		args = append(args, input[field.key])
		expr := fmt.Sprintf("$%d::%s", len(args), field.cast)
		columns = append(columns, field.column)
		expressions = append(expressions, expr)
		assignments = append(assignments, field.column+" = "+expr)
	}
	if create || startChanged || durationChanged {
		args = append(args, values["warrantyUntil"])
		expr := fmt.Sprintf("$%d::date", len(args))
		columns = append(columns, "warranty_until")
		expressions = append(expressions, expr)
		assignments = append(assignments, "warranty_until = "+expr)
	}
	if create {
		query := "INSERT INTO assets (" + strings.Join(columns, ", ") + ", is_compute, manually_managed) VALUES (" + strings.Join(expressions, ", ") + ", TRUE, TRUE) RETURNING id::text"
		err = tx.QueryRowContext(c.Request.Context(), query, args...).Scan(&id)
	} else {
		assignments = append(assignments, "is_compute = TRUE", "manually_managed = TRUE", "updated_at = NOW()")
		_, err = tx.ExecContext(c.Request.Context(), "UPDATE assets SET "+strings.Join(assignments, ", ")+" WHERE id = $1::uuid", args...)
	}
	if err != nil {
		adminAssetError(c, err)
		return
	}
	_, osChanged := input["osName"]
	_, archChanged := input["architecture"]
	if create || osChanged || archChanged {
		_, err = tx.ExecContext(c.Request.Context(), `INSERT INTO asset_compute_details (asset_id, os_name, architecture)
			VALUES ($1::uuid, $2::text, $3::text) ON CONFLICT (asset_id) DO UPDATE SET
			os_name = CASE WHEN $4 THEN EXCLUDED.os_name ELSE asset_compute_details.os_name END,
			architecture = CASE WHEN $5 THEN EXCLUDED.architecture ELSE asset_compute_details.architecture END,
			updated_at = NOW()`, id, input["osName"], input["architecture"], osChanged, archChanged)
		if err != nil {
			adminAssetError(c, err)
			return
		}
	}
	action := "asset_updated"
	if create {
		action = "asset_created"
	}
	detail, _ := json.Marshal(input)
	_, err = tx.ExecContext(c.Request.Context(), `INSERT INTO asset_history (asset_id, actor_id, action, detail)
		VALUES ($1::uuid, $2::uuid, $3, $4::jsonb)`, id, middleware.CurrentClaims(c).UserID, action, string(detail))
	if err != nil {
		adminAssetError(c, err)
		return
	}
	// Read before commit so a response/scan failure also rolls back the mutation.
	result, err := loadAdminAsset(c.Request.Context(), tx, id, false)
	if err != nil {
		adminAssetError(c, err)
		return
	}
	if err := tx.Commit(); err != nil {
		adminAssetError(c, err)
		return
	}
	if create {
		httpx.Created(c, result)
	} else {
		httpx.JSON(c, http.StatusOK, result)
	}
}

func adminAssetEntityAllowed(c *gin.Context, db adminAssetQuerier, entityID string) (bool, error) {
	claims := middleware.CurrentClaims(c)
	if claims == nil || entityID == "" {
		return false, nil
	}
	if isAdminRole(claims.Role) || claims.EntityID == entityID {
		return true, nil
	}
	var exists bool
	err := db.QueryRowContext(c.Request.Context(), `SELECT EXISTS(SELECT 1 FROM user_entity_access WHERE user_id = $1::uuid AND entity_id = $2::uuid)`, claims.UserID, entityID).Scan(&exists)
	return exists, err
}

func validateAdminAssetLinks(ctx context.Context, tx *sql.Tx, values map[string]any) error {
	entityID := values["entityId"]
	checks := []struct{ key, query string }{
		{"entityId", "SELECT EXISTS(SELECT 1 FROM entities WHERE id = $1::uuid AND is_active)"},
		{"locationId", "SELECT EXISTS(SELECT 1 FROM locations WHERE id = $1::uuid AND entity_id = $2::uuid AND is_active)"},
		{"deptId", "SELECT EXISTS(SELECT 1 FROM departments WHERE id = $1::uuid AND entity_id = $2::uuid)"},
		{"groupInChargeId", "SELECT EXISTS(SELECT 1 FROM departments WHERE id = $1::uuid AND entity_id = $2::uuid)"},
		{"assignedUserId", "SELECT EXISTS(SELECT 1 FROM users WHERE id = $1::uuid AND entity_id = $2::uuid AND is_active)"},
		{"technicianInChargeId", "SELECT EXISTS(SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1::uuid AND u.entity_id = $2::uuid AND u.is_active AND r.name IN ('super_admin', 'admin', 'it_team'))"},
		{"supplierId", "SELECT EXISTS(SELECT 1 FROM suppliers WHERE id = $1::uuid)"},
	}
	for _, check := range checks {
		value := values[check.key]
		if value == nil || value == "" {
			continue
		}
		args := []any{value}
		if strings.Contains(check.query, "$2") {
			args = append(args, entityID)
		}
		var exists bool
		if err := tx.QueryRowContext(ctx, check.query, args...).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return adminInputError(check.key + " is not available in the selected entity")
		}
	}
	return nil
}

func (server *apiServer) getAdminAsset(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "admin") {
		return
	}
	if !adminUUID.MatchString(c.Param("id")) {
		adminAssetError(c, adminInputError("invalid computer UUID"))
		return
	}
	asset, err := loadAdminAsset(c.Request.Context(), server.db, c.Param("id"), false)
	if err != nil {
		adminAssetError(c, err)
		return
	}
	allowed, err := adminAssetEntityAllowed(c, server.db, fmt.Sprint(asset["entityId"]))
	if err != nil {
		adminAssetError(c, err)
		return
	}
	if !allowed {
		adminAssetError(c, sql.ErrNoRows)
		return
	}
	httpx.JSON(c, http.StatusOK, asset)
}

// Scope SQL includes delegated entity membership, never role aliases or an
// assigned-user join (unassigned computers must remain visible).
func adminEntityPredicate(c *gin.Context, column string, args *[]any) string {
	claims := middleware.CurrentClaims(c)
	if isAdminRole(claims.Role) {
		return "TRUE"
	}
	*args = append(*args, claims.EntityID, claims.UserID)
	n := len(*args)
	return fmt.Sprintf("(%s = NULLIF($%d, '')::uuid OR EXISTS (SELECT 1 FROM user_entity_access uea WHERE uea.user_id = $%d::uuid AND uea.entity_id = %s))", column, n-1, n, column)
}

func (server *apiServer) adminEntityFilter(c *gin.Context) (string, bool) {
	entity := c.Query("entityId")
	if entity == "" {
		entity = c.Query("entity")
	}
	if entity != "" {
		if !adminUUID.MatchString(entity) {
			adminAssetError(c, adminInputError("invalid entity UUID"))
			return "", false
		}
		entity = strings.ToLower(entity)
		allowed, err := adminAssetEntityAllowed(c, server.db, entity)
		if err != nil {
			adminAssetError(c, err)
			return "", false
		}
		if !allowed {
			httpx.Error(c, http.StatusForbidden, "entity is outside your scope")
			return "", false
		}
	}
	return entity, true
}

func (server *apiServer) listAdminAssets(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "admin") {
		return
	}
	entity, ok := server.adminEntityFilter(c)
	if !ok {
		return
	}
	page, err1 := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, err2 := strconv.Atoi(c.DefaultQuery("pageSize", "50"))
	if err1 != nil || err2 != nil || page < 1 || page > 1000000 || size < 1 || size > 200 {
		adminAssetError(c, adminInputError("page must be 1–1000000 and pageSize 1–200"))
		return
	}
	args := []any{}
	where := "a.is_compute = TRUE AND " + adminEntityPredicate(c, "a.entity_id", &args)
	if entity != "" {
		args = append(args, entity)
		where += fmt.Sprintf(" AND a.entity_id = $%d::uuid", len(args))
	}
	if assigned := c.Query("assigned"); assigned != "" {
		switch assigned {
		case "true":
			where += " AND a.assigned_to IS NOT NULL"
		case "false":
			where += " AND a.assigned_to IS NULL"
		default:
			adminAssetError(c, adminInputError("assigned must be true or false"))
			return
		}
	}
	var total int
	if err := server.db.QueryRowContext(c.Request.Context(), "SELECT COUNT(*) FROM assets a WHERE "+where, args...).Scan(&total); err != nil {
		adminAssetError(c, err)
		return
	}
	args = append(args, size, (page-1)*size)
	query := adminAssetSelect() + " WHERE " + where + fmt.Sprintf(" ORDER BY a.asset_tag, a.id LIMIT $%d OFFSET $%d", len(args)-1, len(args))
	rows, err := server.db.QueryContext(c.Request.Context(), query, args...)
	if err != nil {
		adminAssetError(c, err)
		return
	}
	defer rows.Close()
	items := []json.RawMessage{}
	for rows.Next() {
		var raw json.RawMessage
		if err := rows.Scan(&raw); err != nil {
			adminAssetError(c, err)
			return
		}
		items = append(items, raw)
	}
	if err := rows.Err(); err != nil {
		adminAssetError(c, err)
		return
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items, "total": total, "page": page, "pageSize": size})
}

func (server *apiServer) adminAssetOptions(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "admin") {
		return
	}
	entity, ok := server.adminEntityFilter(c)
	if !ok {
		return
	}
	lookups := []struct{ key, table, name, entity, extra string }{
		{"entities", "entities x", "x.full_name", "x.id", " AND x.is_active"},
		{"locations", "locations x", "x.full_name", "x.entity_id", " AND x.is_active"},
		{"departments", "departments x", "x.name", "x.entity_id", ""},
		{"users", "users x", "x.full_name", "x.entity_id", " AND x.is_active"},
		{"technicians", "users x JOIN roles r ON r.id = x.role_id", "x.full_name", "x.entity_id", " AND x.is_active AND r.name IN ('super_admin', 'admin', 'it_team')"},
		// Suppliers have no entity ownership in the canonical schema.
		{"suppliers", "suppliers x", "x.name", "", ""},
	}
	result := gin.H{}
	for _, lookup := range lookups {
		args := []any{}
		where := "TRUE"
		if lookup.entity != "" {
			where = adminEntityPredicate(c, lookup.entity, &args)
			if entity != "" {
				args = append(args, entity)
				where += fmt.Sprintf(" AND %s = $%d::uuid", lookup.entity, len(args))
			}
		}
		rows, err := server.db.QueryContext(c.Request.Context(), "SELECT x.id::text, "+lookup.name+" FROM "+lookup.table+" WHERE "+where+lookup.extra+" ORDER BY "+lookup.name+", x.id", args...)
		if err != nil {
			adminAssetError(c, err)
			return
		}
		items := []gin.H{}
		for rows.Next() {
			var id, name string
			if err = rows.Scan(&id, &name); err != nil {
				break
			}
			items = append(items, gin.H{"id": id, "name": name})
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			adminAssetError(c, err)
			return
		}
		result[lookup.key] = items
	}
	httpx.JSON(c, http.StatusOK, result)
}

// Legacy endpoints may still manage non-compute inventory. A false is_compute
// payload must not let an IT operator demote an existing computer and edit it.
func (server *apiServer) allowManualComputerMutation(c *gin.Context, compute bool, category string) bool {
	switch strings.ToLower(strings.TrimSpace(category)) {
	case "computer", "desktop", "laptop", "server", "workstation", "all-in-one", "mini_pc":
		compute = true
	}
	return !compute || server.requireRoles(c, "super_admin", "admin")
}
