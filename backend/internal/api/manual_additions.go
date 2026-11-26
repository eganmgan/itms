package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/lib/pq"

	"itms/backend/internal/platform/authn"
	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

const manualWriteTimeout = 8 * time.Second

var manualCodePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)

type manualInputError string

func (err manualInputError) Error() string { return string(err) }

// Only these errors are safe to return. PostgreSQL errors may contain submitted
// values, including password hashes, so never serialize or audit the raw error.
func manualWriteError(c *gin.Context, err error) {
	var input manualInputError
	var pg *pq.Error
	switch {
	case errors.As(err, &input):
		httpx.Error(c, http.StatusBadRequest, string(input))
	case errors.As(err, &pg) && pg.Code == "23505":
		httpx.Error(c, http.StatusConflict, "a record with these unique fields already exists")
	case errors.As(err, &pg) && pg.Code == "23503":
		httpx.Error(c, http.StatusBadRequest, "a referenced record is unavailable")
	default:
		httpx.Error(c, http.StatusInternalServerError, "unable to save record")
	}
}

func validateManualText(field, value string, limit int, required bool) error {
	if required && value == "" {
		return manualInputError(field + " is required")
	}
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > limit || strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return manualInputError(fmt.Sprintf("%s must be valid text of at most %d characters without control characters", field, limit))
	}
	return nil
}

func validateManualCode(field, value string, limit int, required bool) error {
	if err := validateManualText(field, value, limit, required); err != nil {
		return err
	}
	if value != "" && !manualCodePattern.MatchString(value) {
		return manualInputError(field + " must start with a letter or number and contain only letters, numbers, dot, underscore or hyphen")
	}
	return nil
}

func validateManualID(field, value string, required bool) error {
	if value == "" && !required {
		return nil
	}
	if !adminUUID.MatchString(value) {
		return manualInputError(field + " must be a UUID")
	}
	return nil
}

type manualUserInput struct {
	FullName        string `json:"full_name"`
	EmpID           string `json:"emp_id"`
	Email           string `json:"email"`
	EntityID        string `json:"entity_id"`
	DeptID          string `json:"dept_id"`
	LocationID      string `json:"location_id"`
	Role            string `json:"role"`
	InitialPassword string `json:"initial_password"`
	IsActive        *bool  `json:"is_active"`
}

// A dedicated allowlist avoids retaining a request/password in audit metadata.
// The audit middleware leaves this secret-free struct intact, preserving the
// boolean password_set instead of masking it as if it were a credential.
type manualUserCreatedAudit struct {
	FullName    string `json:"full_name"`
	EmpID       string `json:"emp_id"`
	Email       string `json:"email"`
	EntityID    string `json:"entity_id"`
	DeptID      string `json:"dept_id"`
	LocationID  string `json:"location_id"`
	Role        string `json:"role"`
	IsActive    bool   `json:"is_active"`
	PasswordSet bool   `json:"password_set"`
}

func (input *manualUserInput) validate(create bool) error {
	input.FullName = strings.TrimSpace(input.FullName)
	input.EmpID = strings.TrimSpace(input.EmpID)
	input.Email = strings.ToLower(strings.TrimSpace(input.Email))
	input.EntityID = strings.TrimSpace(input.EntityID)
	input.DeptID = strings.TrimSpace(input.DeptID)
	input.LocationID = strings.TrimSpace(input.LocationID)
	input.Role = strings.TrimSpace(input.Role)
	for _, err := range []error{
		validateManualText("full_name", input.FullName, 100, create),
		validateManualCode("emp_id", input.EmpID, 10, create),
		validateManualText("email", input.Email, 150, create),
		validateManualText("role", input.Role, 60, create),
		validateManualID("entity_id", input.EntityID, create),
		validateManualID("dept_id", input.DeptID, false),
		validateManualID("location_id", input.LocationID, false),
	} {
		if err != nil {
			return err
		}
	}
	if input.Email != "" {
		address, err := mail.ParseAddress(input.Email)
		if err != nil || address.Address != input.Email || address.Name != "" {
			return manualInputError("email must be a valid email address")
		}
	}
	if create || strings.TrimSpace(input.InitialPassword) != "" {
		if err := authn.ValidatePasswordStrength(input.InitialPassword); err != nil {
			return manualInputError(err.Error())
		}
	}
	return nil
}

// Validate against the roles table so settings administrators can assign configured roles.
func (server *apiServer) validateManualRole(ctx context.Context, role string) error {
	if role == "" {
		return nil // PATCH preserves the existing role.
	}
	var exists bool
	if err := server.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM roles WHERE name = $1)`, role).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return manualInputError("unknown role")
	}
	return nil
}

func (server *apiServer) validateManualLinks(ctx context.Context, entityID, deptID, locationID string) error {
	for _, link := range []struct {
		field, id string
		required  bool
	}{
		{"entity_id", entityID, true}, {"dept_id", deptID, false}, {"location_id", locationID, false},
	} {
		if err := validateManualID(link.field, link.id, link.required); err != nil {
			return err
		}
	}
	var exists bool
	if err := server.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM entities WHERE id = $1::uuid)`, entityID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return manualInputError("unknown entity")
	}
	if deptID != "" {
		if err := server.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM departments WHERE id = $1::uuid AND entity_id = $2::uuid)`, deptID, entityID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return manualInputError("department does not belong to the selected entity")
		}
	}
	if locationID != "" {
		if err := server.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM locations WHERE id = $1::uuid AND entity_id = $2::uuid)`, locationID, entityID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return manualInputError("location does not belong to the selected entity")
		}
	}
	return nil
}

func (server *apiServer) createEntity(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "admin") {
		return
	}
	var input struct {
		ShortCode string `json:"short_code"`
		FullName  string `json:"full_name"`
		IsActive  *bool  `json:"is_active"`
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16384)
	if c.ShouldBindJSON(&input) != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid entity payload")
		return
	}
	input.ShortCode = strings.ToUpper(strings.TrimSpace(input.ShortCode))
	input.FullName = strings.TrimSpace(input.FullName)
	for _, err := range []error{
		validateManualCode("short_code", input.ShortCode, 10, true),
		validateManualText("full_name", input.FullName, 150, true),
	} {
		if err != nil {
			manualWriteError(c, err)
			return
		}
	}
	active := input.IsActive == nil || *input.IsActive
	ctx, cancel := context.WithTimeout(c.Request.Context(), manualWriteTimeout)
	defer cancel()
	var id string
	err := server.db.QueryRowContext(ctx, `INSERT INTO entities (short_code, full_name, is_active) VALUES ($1, $2, $3) RETURNING id`, input.ShortCode, input.FullName, active).Scan(&id)
	if err != nil {
		manualWriteError(c, err)
		return
	}
	middleware.TagAudit(c, middleware.AuditMeta{Action: "entity_created", TargetType: "entity", TargetID: id, Detail: input})
	httpx.Created(c, gin.H{"id": id})
}

// Context-aware lookup only for manual edits; existing authentication callers
// retain their existing lookup and password/login policies.
func (server *apiServer) manualUserLinks(ctx context.Context, id string) (email, entity, dept, location string, err error) {
	err = server.db.QueryRowContext(ctx, `SELECT email, COALESCE(entity_id::text, ''), COALESCE(dept_id::text, ''), COALESCE(location_id::text, '') FROM users WHERE id = $1::uuid`, id).Scan(&email, &entity, &dept, &location)
	return
}
