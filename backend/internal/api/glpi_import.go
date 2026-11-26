package api

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/lib/pq"

	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

const glpiMaxBytes = 8 * 1024 * 1024
const glpiMaxRows = 5000

type glpiRow struct {
	Row    int               `json:"row"`
	Fields map[string]string `json:"fields"`
	Issues []string          `json:"issues"`
}

func parseGLPICSV(input io.Reader) ([]glpiRow, error) {
	body, err := io.ReadAll(io.LimitReader(input, glpiMaxBytes+1))
	if err != nil || len(body) > glpiMaxBytes || !utf8.Valid(body) {
		return nil, errors.New("CSV must be UTF-8 and no larger than 8 MiB")
	}
	reader := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(body), "\ufeff")))
	reader.Comma = ';'
	headers, err := reader.Read()
	if err != nil {
		return nil, errors.New("invalid GLPI CSV header")
	}
	seen := map[string]bool{}
	for index, header := range headers {
		header = strings.TrimSpace(header)
		if header == "" && index == len(headers)-1 {
			continue
		}
		if header == "" || seen[header] {
			return nil, errors.New("CSV contains an empty or duplicate header")
		}
		seen[header] = true
		headers[index] = header
	}
	for _, header := range []string{"Name", "Entity", "Status", "Inventory/Asset Number"} {
		if !seen[header] {
			return nil, errors.New("GLPI CSV requires Name, Entity, Status and Inventory/Asset Number columns")
		}
	}
	rows := []glpiRow{}
	tags := map[string][]int{}
	for {
		record, readErr := reader.Read()
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return nil, errors.New("invalid CSV quoting or column count")
		}
		if len(rows) >= glpiMaxRows {
			return nil, errors.New("CSV exceeds 5000 records; split the export")
		}
		row := glpiRow{Row: len(rows) + 1, Fields: map[string]string{}, Issues: []string{}}
		for index, value := range record {
			if headers[index] == "" {
				if strings.TrimSpace(value) != "" {
					return nil, errors.New("unexpected data in the trailing empty column")
				}
				continue
			}
			row.Fields[headers[index]] = strings.TrimSpace(value)
			if strings.ContainsRune(value, 0) {
				return nil, errors.New("CSV contains a null character")
			}
		}
		for _, header := range []string{"Name", "Entity", "Status", "Inventory/Asset Number"} {
			if row.Fields[header] == "" {
				row.Issues = append(row.Issues, "Missing "+header)
			}
		}
		tag := strings.ToUpper(row.Fields["Inventory/Asset Number"])
		if tag != "" {
			tags[tag] = append(tags[tag], len(rows))
		}
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		return nil, errors.New("CSV contains no records")
	}
	for _, indexes := range tags {
		if len(indexes) > 1 {
			for _, index := range indexes {
				rows[index].Issues = append(rows[index].Issues, "Duplicate asset tag in CSV")
			}
		}
	}
	return rows, nil
}

type glpiRequest struct {
	CSV        string            `json:"csv"`
	Categories map[string]string `json:"categories"`
	Rows       []int             `json:"rows"`
	Digest     string            `json:"digest"`
}

type glpiDraft struct {
	glpiRow
	EntityID       string   `json:"entityId"`
	LocationID     string   `json:"locationId"`
	Category       string   `json:"category"`
	CategorySource string   `json:"categorySource"`
	IsCompute      bool     `json:"isCompute"`
	Status         string   `json:"status"`
	Warnings       []string `json:"warnings"`
}

func glpiCategory(category string) (bool, bool) {
	switch category {
	case "laptop", "desktop", "server":
		return true, true
	case "accessory", "monitor", "printer", "scanner", "phone", "network", "cctv", "ups":
		return false, true
	default:
		return false, false
	}
}

func glpiStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "deployed":
		return "in_use"
	case "scrapped":
		return "scrapped"
	case "in stock":
		return "in_stock"
	default:
		return ""
	}
}

func glpiKey(value string) string { return strings.ToUpper(strings.TrimSpace(value)) }

var glpiCategoryRules = []struct {
	category string
	terms    []string
}{
	{"accessory", []string{"accessory", "accessories", "keyboard", "keyboards", "mouse", "mice", "headset", "headsets", "headphone", "headphones", "earphone", "earphones", "adapter", "adaptor", "charger", "cable", "docking station", "webcam", "hard disk", "hard drive", "ssd", "pendrive", "pen drive", "laptop bag"}},
	{"laptop", []string{"laptop", "laptops", "notebook", "macbook", "thinkpad", "latitude", "elitebook", "probook"}},
	{"desktop", []string{"desktop", "desktops", "workstation", "optiplex", "thinkcentre", "imac", "mac mini"}},
	{"server", []string{"server", "servers", "poweredge", "proliant"}},
	{"monitor", []string{"monitor", "monitors", "display"}},
	{"printer", []string{"printer", "printers"}},
	{"scanner", []string{"scanner", "scanners"}},
	{"phone", []string{"phone", "phones", "iphone", "smartphone", "telephone"}},
	{"network", []string{"router", "switch", "firewall", "modem", "access point", "network equipment"}},
	{"cctv", []string{"cctv", "nvr", "dvr", "surveillance camera"}},
	{"ups", []string{"ups", "uninterruptible power supply"}},
}

func glpiCategoryFromText(value string) string {
	normalized := " " + strings.Join(strings.FieldsFunc(strings.ToLower(value), func(character rune) bool {
		return !unicode.IsLetter(character) && !unicode.IsNumber(character)
	}), " ") + " "
	category := ""
	for _, rule := range glpiCategoryRules {
		for _, term := range rule.terms {
			if !strings.Contains(normalized, " "+term+" ") {
				continue
			}
			if rule.category == "accessory" {
				return rule.category
			}
			if category != "" && category != rule.category {
				return ""
			}
			category = rule.category
			break
		}
	}
	return category
}

func glpiValidateDraft(row glpiRow, categories map[string]string) glpiDraft {
	draft := glpiDraft{glpiRow: row, Category: categories[row.Fields["Type"]], Status: glpiStatus(row.Fields["Status"]), Warnings: []string{}}
	draft.CategorySource = "manual"
	if draft.Category == "" {
		typeCategory, nameCategory := glpiCategoryFromText(row.Fields["Type"]), glpiCategoryFromText(row.Fields["Name"])
		draft.CategorySource = "unresolved"
		switch {
		case typeCategory != "" && nameCategory != "" && typeCategory != nameCategory:
			draft.Issues = append(draft.Issues, "GLPI type and equipment name suggest different categories; choose a category")
		case typeCategory != "":
			draft.Category, draft.CategorySource = typeCategory, "type"
		case nameCategory != "":
			draft.Category, draft.CategorySource = nameCategory, "name"
		}
		if draft.Category != "" {
			draft.Warnings = append(draft.Warnings, "Category automatically suggested from GLPI "+draft.CategorySource+"; review before import")
		}
	}
	compute, valid := glpiCategory(draft.Category)
	draft.IsCompute = compute
	if !valid {
		draft.Issues = append(draft.Issues, "Choose a category for this GLPI type")
	}
	if draft.Status == "" {
		draft.Issues = append(draft.Issues, "Unsupported or missing status")
	}
	for field, limit := range map[string]int{"Name": 150, "Inventory/Asset Number": 20, "Serial Number": 100, "Manufacturers": 100, "Model": 100, "Operating System - Name": 255} {
		if utf8.RuneCountInString(row.Fields[field]) > limit {
			draft.Issues = append(draft.Issues, fmt.Sprintf("%s exceeds %d characters", field, limit))
		}
	}
	if date := row.Fields["Financial & Administrative Information - Start Date of Warranty"]; date != "" {
		parsed, err := time.Parse("2006-01-02", date)
		if err != nil || parsed.Year() < 1 {
			draft.Issues = append(draft.Issues, "Invalid warranty start date")
		}
	}
	if tag := glpiKey(row.Fields["Inventory/Asset Number"]); tag == "NF" || tag == "NA" || tag == "N/A" || tag == "-" {
		draft.Issues = append(draft.Issues, "Placeholder asset tag")
	}
	draft.Warnings = append(draft.Warnings, "No employee or technician assignment; GLPI identities retained in source notes")
	if compute {
		draft.Warnings = append(draft.Warnings, "Imported inventory only; agent connection and application freshness unknown")
	}
	return draft
}

func glpiPlan(ctx context.Context, tx *sql.Tx, rows []glpiRow, categories map[string]string) ([]glpiDraft, error) {
	entities := map[string][]string{}
	entityRows, err := tx.QueryContext(ctx, "SELECT id::text, full_name FROM entities WHERE is_active")
	if err != nil {
		return nil, err
	}
	for entityRows.Next() {
		var id, name string
		if err := entityRows.Scan(&id, &name); err != nil {
			entityRows.Close()
			return nil, err
		}
		entities[glpiKey(name)] = append(entities[glpiKey(name)], id)
	}
	if err := entityRows.Err(); err != nil {
		entityRows.Close()
		return nil, err
	}
	entityRows.Close()
	locations := map[string][]string{}
	locationRows, err := tx.QueryContext(ctx, "SELECT id::text, entity_id::text, full_name FROM locations WHERE is_active")
	if err != nil {
		return nil, err
	}
	for locationRows.Next() {
		var id, entityID, name string
		if err := locationRows.Scan(&id, &entityID, &name); err != nil {
			locationRows.Close()
			return nil, err
		}
		key := entityID + ":" + glpiKey(name)
		locations[key] = append(locations[key], id)
	}
	if err := locationRows.Err(); err != nil {
		locationRows.Close()
		return nil, err
	}
	locationRows.Close()
	tags, serials := []string{}, []string{}
	serialCounts := map[string]int{}
	for _, row := range rows {
		tags = append(tags, glpiKey(row.Fields["Inventory/Asset Number"]))
		if serial := glpiKey(row.Fields["Serial Number"]); serial != "" {
			serials = append(serials, serial)
			serialCounts[serial]++
		}
	}
	existingRows, err := tx.QueryContext(ctx, `SELECT asset_tag, COALESCE(serial_number, '') FROM assets
		WHERE upper(btrim(asset_tag)) = ANY($1) OR (serial_number IS NOT NULL AND upper(btrim(serial_number)) = ANY($2))
		UNION ALL SELECT COALESCE(asset_tag, ''), COALESCE(serial_number, '') FROM stock_items
		WHERE upper(btrim(asset_tag)) = ANY($1) OR (serial_number IS NOT NULL AND upper(btrim(serial_number)) = ANY($2))`, pq.Array(tags), pq.Array(serials))
	if err != nil {
		return nil, err
	}
	existingTags, existingSerials := map[string]bool{}, map[string]bool{}
	for existingRows.Next() {
		var tag, serial string
		if err := existingRows.Scan(&tag, &serial); err != nil {
			existingRows.Close()
			return nil, err
		}
		existingTags[glpiKey(tag)], existingSerials[glpiKey(serial)] = true, true
	}
	if err := existingRows.Err(); err != nil {
		existingRows.Close()
		return nil, err
	}
	existingRows.Close()
	plan := make([]glpiDraft, 0, len(rows))
	for _, row := range rows {
		draft := glpiValidateDraft(row, categories)
		if matches := entities[glpiKey(row.Fields["Entity"])]; len(matches) == 1 {
			draft.EntityID = matches[0]
		} else {
			draft.Issues = append(draft.Issues, "Entity must match exactly one active ITMS entity")
		}
		if location := row.Fields["Locations"]; location != "" {
			if matches := locations[draft.EntityID+":"+glpiKey(location)]; len(matches) == 1 {
				draft.LocationID = matches[0]
			} else {
				draft.Warnings = append(draft.Warnings, "Location not matched; retained in source notes")
			}
		}
		if existingTags[glpiKey(row.Fields["Inventory/Asset Number"])] {
			draft.Issues = append(draft.Issues, "Asset tag already exists in ITMS")
		}
		if serial := glpiKey(row.Fields["Serial Number"]); serial != "" && (existingSerials[serial] || serialCounts[serial] > 1) {
			draft.Issues = append(draft.Issues, "Serial number already exists or is duplicated in CSV")
		}
		sort.Strings(draft.Issues)
		plan = append(plan, draft)
	}
	return plan, nil
}

func glpiDigest(plan []glpiDraft) string {
	body, _ := json.Marshal(plan)
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}

func (server *apiServer) previewGLPI(c *gin.Context) { server.handleGLPI(c, false) }
func (server *apiServer) importGLPI(c *gin.Context)  { server.handleGLPI(c, true) }

func (server *apiServer) listAdminAccessories(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "admin") {
		return
	}
	c.Header("Cache-Control", "no-store")
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil || page < 1 || page > 100000 {
		httpx.Error(c, http.StatusBadRequest, "invalid page")
		return
	}
	search := strings.TrimSpace(c.Query("search"))
	if utf8.RuneCountInString(search) > 150 {
		httpx.Error(c, http.StatusBadRequest, "search exceeds 150 characters")
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 8*time.Second)
	defer cancel()
	rows, err := server.db.QueryContext(ctx, `WITH equipment AS (
		SELECT a.id::text, 'asset'::text AS source, a.name, a.category, a.asset_tag,
		COALESCE(a.serial_number, '') AS serial_number, a.status, e.full_name AS entity,
		COALESCE(l.full_name, '') AS location, COALESCE(u.full_name, '') AS assignee,
		COALESCE(a.notes, '') AS notes
		FROM assets a JOIN entities e ON e.id = a.entity_id
		LEFT JOIN locations l ON l.id = a.location_id LEFT JOIN users u ON u.id = a.assigned_to
		WHERE a.is_compute = FALSE
		UNION ALL
		SELECT s.id::text, 'stock'::text, s.name, s.category, COALESCE(s.asset_tag, ''),
		COALESCE(s.serial_number, ''), s.status, COALESCE(s.company_name, ''),
		COALESCE(l.full_name, ''), COALESCE(u.full_name, ''), COALESCE(s.specs, '')
		FROM stock_items s LEFT JOIN locations l ON l.id = s.branch_id LEFT JOIN users u ON u.id = s.assigned_user_id
	) SELECT json_build_object('id', id, 'source', source, 'name', name, 'category', category,
		'assetTag', asset_tag, 'serialNumber', serial_number, 'status', status, 'entity', entity,
		'location', location, 'assignee', assignee, 'notes', notes)
	FROM equipment WHERE strpos(lower(concat_ws(' ', name, category, asset_tag, serial_number, entity, location, assignee)), lower($1)) > 0
	ORDER BY name, source, id LIMIT 51 OFFSET $2`, search, (page-1)*50)
	if err != nil {
		adminAssetError(c, err)
		return
	}
	defer rows.Close()
	items := []json.RawMessage{}
	for rows.Next() {
		var item json.RawMessage
		if err := rows.Scan(&item); err != nil {
			adminAssetError(c, err)
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		adminAssetError(c, err)
		return
	}
	hasMore := len(items) > 50
	if hasMore {
		items = items[:50]
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items, "page": page, "hasMore": hasMore})
}

func (server *apiServer) handleGLPI(c *gin.Context, commit bool) {
	if !server.requireRoles(c, "super_admin", "admin") {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2*glpiMaxBytes)
	var input glpiRequest
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		httpx.Error(c, http.StatusBadRequest, "invalid GLPI upload request")
		return
	}
	rows, err := parseGLPICSV(strings.NewReader(input.CSV))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	selected := map[int]bool{}
	if commit {
		if len(input.Rows) == 0 || len(input.Rows) > 200 || input.Digest == "" {
			httpx.Error(c, http.StatusBadRequest, "review and select 1 to 200 rows before importing")
			return
		}
		for _, row := range input.Rows {
			if row < 1 || row > len(rows) || selected[row] {
				httpx.Error(c, http.StatusBadRequest, "invalid or duplicate selected row")
				return
			}
			selected[row] = true
		}
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	tx, err := server.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable, ReadOnly: !commit})
	if err != nil {
		adminAssetError(c, err)
		return
	}
	defer tx.Rollback()
	plan, err := glpiPlan(ctx, tx, rows, input.Categories)
	if err != nil {
		adminAssetError(c, err)
		return
	}
	digest := glpiDigest(plan)
	if !commit {
		httpx.JSON(c, http.StatusOK, gin.H{"rows": plan, "digest": digest})
		return
	}
	if digest != input.Digest {
		httpx.Error(c, http.StatusConflict, "inventory or mapping changed; preview the CSV again")
		return
	}
	for _, draft := range plan {
		if selected[draft.Row] && len(draft.Issues) != 0 {
			httpx.Error(c, http.StatusBadRequest, "selected rows contain review issues")
			return
		}
	}
	ids := []string{}
	for _, draft := range plan {
		if !selected[draft.Row] {
			continue
		}
		fields := draft.Fields
		notes, _ := json.Marshal(fields)
		var id string
		err = tx.QueryRowContext(ctx, `INSERT INTO assets
			(asset_tag, name, category, is_compute, serial_number, manufacturer, model, entity_id, location_id,
			status, warranty_start_date, notes, manually_managed)
			VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), $8::uuid, NULLIF($9, '')::uuid,
			$10, NULLIF($11, '')::date, $12, TRUE) RETURNING id::text`,
			fields["Inventory/Asset Number"], fields["Name"], draft.Category, draft.IsCompute,
			fields["Serial Number"], fields["Manufacturers"], fields["Model"], draft.EntityID, draft.LocationID,
			draft.Status, fields["Financial & Administrative Information - Start Date of Warranty"], "GLPI source: "+string(notes)).Scan(&id)
		if err == nil && draft.IsCompute {
			_, err = tx.ExecContext(ctx, `INSERT INTO asset_compute_details (asset_id, os_name) VALUES ($1::uuid, NULLIF($2, ''))`, id, fields["Operating System - Name"])
		}
		if err == nil {
			_, err = tx.ExecContext(ctx, `INSERT INTO asset_history (asset_id, actor_id, action, detail)
				VALUES ($1::uuid, $2::uuid, 'glpi_imported', jsonb_build_object('source', 'glpi_csv', 'row', $3::integer))`, id, middleware.CurrentClaims(c).UserID, draft.Row)
		}
		if err != nil {
			adminAssetError(c, err)
			return
		}
		ids = append(ids, id)
	}
	if err := tx.Commit(); err != nil {
		adminAssetError(c, err)
		return
	}
	httpx.Created(c, gin.H{"imported": len(ids), "ids": ids})
}
