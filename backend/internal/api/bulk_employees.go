package api

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/lib/pq"

	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

const bulkEmployeeMaxBytes = 1024 * 1024

type bulkEmployeeRow struct {
	Row      int      `json:"row"`
	EmpID    string   `json:"empId"`
	FullName string   `json:"fullName"`
	Email    string   `json:"email"`
	Issues   []string `json:"issues"`
}

type bulkEmployeeRequest struct {
	CSV      string `json:"csv"`
	EntityID string `json:"entityId"`
	Rows     []int  `json:"rows"`
	Digest   string `json:"digest"`
}

func parseBulkEmployees(body, domain string) ([]bulkEmployeeRow, error) {
	if len(body) > bulkEmployeeMaxBytes || !utf8.ValidString(body) {
		return nil, errors.New("CSV must be UTF-8 and no larger than 1 MiB")
	}
	reader := csv.NewReader(strings.NewReader(strings.TrimPrefix(body, "\ufeff")))
	headers, err := reader.Read()
	if err != nil {
		return nil, errors.New("invalid employee CSV header")
	}
	columns := map[string]int{}
	for index, header := range headers {
		header = strings.ToLower(strings.TrimSpace(header))
		if header != "emp_id" && header != "full_name" && header != "email" {
			return nil, errors.New("CSV must contain only emp_id, full_name and email columns; do not upload passwords")
		}
		if _, exists := columns[header]; exists {
			return nil, errors.New("duplicate CSV header")
		}
		columns[header] = index
	}
	if len(columns) != 3 {
		return nil, errors.New("CSV requires emp_id, full_name and email columns")
	}
	rows := []bulkEmployeeRow{}
	ids, emails := map[string]int{}, map[string]int{}
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, errors.New("invalid CSV quoting or column count")
		}
		if len(rows) >= 1000 {
			return nil, errors.New("CSV exceeds 1000 records; split the export")
		}
		row := bulkEmployeeRow{Row: len(rows) + 1, EmpID: strings.TrimSpace(record[columns["emp_id"]]), FullName: strings.TrimSpace(record[columns["full_name"]]), Email: strings.ToLower(strings.TrimSpace(record[columns["email"]])), Issues: []string{}}
		input := manualUserInput{EmpID: row.EmpID, FullName: row.FullName, Email: row.Email}
		for _, validation := range []error{validateManualCode("emp_id", row.EmpID, 10, true), validateManualText("full_name", row.FullName, 100, true), validateManualText("email", row.Email, 150, true), input.validate(false)} {
			if validation != nil {
				row.Issues = append(row.Issues, validation.Error())
				break
			}
		}
		if domain != "" && !strings.HasSuffix(row.Email, "@"+strings.ToLower(domain)) {
			row.Issues = append(row.Issues, "Email is outside the configured company domain")
		}
		ids[glpiKey(row.EmpID)]++
		emails[row.Email]++
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		return nil, errors.New("CSV contains no employee records")
	}
	for index := range rows {
		if ids[glpiKey(rows[index].EmpID)] > 1 {
			rows[index].Issues = append(rows[index].Issues, "Duplicate employee ID in CSV")
		}
		if emails[rows[index].Email] > 1 {
			rows[index].Issues = append(rows[index].Issues, "Duplicate email in CSV")
		}
	}
	return rows, nil
}

func bulkEmployeePlan(ctx context.Context, tx *sql.Tx, rows []bulkEmployeeRow, entityID string) error {
	var entityActive, roleExists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM entities WHERE id = $1::uuid AND is_active), EXISTS(SELECT 1 FROM roles WHERE name = 'employee')`, entityID).Scan(&entityActive, &roleExists); err != nil {
		return err
	}
	if !entityActive {
		return manualInputError("Select an active company")
	}
	if !roleExists {
		return manualInputError("Employee role is unavailable")
	}
	ids, emails := []string{}, []string{}
	for _, row := range rows {
		ids = append(ids, glpiKey(row.EmpID))
		emails = append(emails, row.Email)
	}
	existing, err := tx.QueryContext(ctx, `SELECT emp_id, email FROM users WHERE upper(btrim(emp_id)) = ANY($1) OR lower(btrim(email)) = ANY($2)`, pq.Array(ids), pq.Array(emails))
	if err != nil {
		return err
	}
	defer existing.Close()
	existingIDs, existingEmails := map[string]bool{}, map[string]bool{}
	for existing.Next() {
		var id, email string
		if err := existing.Scan(&id, &email); err != nil {
			return err
		}
		existingIDs[glpiKey(id)], existingEmails[strings.ToLower(strings.TrimSpace(email))] = true, true
	}
	if err := existing.Err(); err != nil {
		return err
	}
	for index := range rows {
		if existingIDs[glpiKey(rows[index].EmpID)] {
			rows[index].Issues = append(rows[index].Issues, "Employee ID already exists; existing accounts are not changed")
		}
		if existingEmails[rows[index].Email] {
			rows[index].Issues = append(rows[index].Issues, "Email already exists; existing accounts are not changed")
		}
	}
	return nil
}

func bulkEmployeeDigest(entityID string, rows []bulkEmployeeRow) string {
	body, _ := json.Marshal(struct {
		EntityID string
		Rows     []bulkEmployeeRow
	}{entityID, rows})
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}

func (server *apiServer) previewBulkEmployees(c *gin.Context) { server.handleBulkEmployees(c, false) }
func (server *apiServer) importBulkEmployees(c *gin.Context)  { server.handleBulkEmployees(c, true) }

func (server *apiServer) handleBulkEmployees(c *gin.Context, commit bool) {
	if !server.requireRoles(c, "super_admin", "admin") {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2*bulkEmployeeMaxBytes)
	var input bulkEmployeeRequest
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		httpx.Error(c, http.StatusBadRequest, "invalid employee CSV request")
		return
	}
	if err := validateManualID("entityId", input.EntityID, true); err != nil {
		manualWriteError(c, err)
		return
	}
	rows, err := parseBulkEmployees(input.CSV, server.config.GoogleHostedDomain)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	selected := map[int]bool{}
	if commit {
		if len(input.Rows) == 0 || len(input.Rows) > 200 || input.Digest == "" {
			httpx.Error(c, http.StatusBadRequest, "Review and select 1 to 200 rows")
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
		manualWriteError(c, err)
		return
	}
	defer tx.Rollback()
	if err := bulkEmployeePlan(ctx, tx, rows, input.EntityID); err != nil {
		manualWriteError(c, err)
		return
	}
	digest := bulkEmployeeDigest(input.EntityID, rows)
	if !commit {
		httpx.JSON(c, http.StatusOK, gin.H{"rows": rows, "digest": digest})
		return
	}
	if digest != input.Digest {
		httpx.Error(c, http.StatusConflict, "Employees or company changed; preview again")
		return
	}
	for _, row := range rows {
		if selected[row.Row] && len(row.Issues) != 0 {
			httpx.Error(c, http.StatusBadRequest, "Selected rows contain issues")
			return
		}
	}
	ids := []string{}
	for _, row := range rows {
		if !selected[row.Row] {
			continue
		}
		var id string
		err := tx.QueryRowContext(ctx, `INSERT INTO users (emp_id, full_name, email, entity_id, role_id, password_hash, is_active)
			SELECT $1, $2, $3, $4::uuid, id, NULL, FALSE FROM roles WHERE name = 'employee' RETURNING id::text`, row.EmpID, row.FullName, row.Email, input.EntityID).Scan(&id)
		if err != nil {
			manualWriteError(c, err)
			return
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO user_entity_access (user_id, entity_id) VALUES ($1::uuid, $2::uuid)`, id, input.EntityID); err != nil {
			manualWriteError(c, err)
			return
		}
		ids = append(ids, id)
	}
	if err := tx.Commit(); err != nil {
		manualWriteError(c, err)
		return
	}
	middleware.TagAudit(c, middleware.AuditMeta{Action: "employees_bulk_created", TargetType: "entity", TargetID: input.EntityID, Detail: gin.H{"created": len(ids), "ids": ids, "active": false}})
	httpx.Created(c, gin.H{"created": len(ids), "ids": ids})
}
