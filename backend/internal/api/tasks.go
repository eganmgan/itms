package api

import (
	"database/sql"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

var taskIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

var taskStatuses = map[string]bool{
	"pending":     true,
	"in_progress": true,
	"completed":   true,
	"cancelled":   true,
}

var taskPriorities = map[string]bool{
	"low":      true,
	"medium":   true,
	"high":     true,
	"critical": true,
}

func isTaskAssigneeRole(role string) bool {
	return role == "it_team" || role == "super_admin"
}

type employeeTaskInput struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	AssigneeID  string `json:"assigneeId"`
	Priority    string `json:"priority"`
	DueDate     string `json:"dueDate"`
}

type employeeTaskUpdateInput struct {
	Status     *string `json:"status"`
	AssigneeID *string `json:"assigneeId"`
	DueDate    *string `json:"dueDate"`
}

func parseTaskDueDate(value string) (*string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	if _, err := time.Parse("2006-01-02", value); err != nil {
		return nil, fmt.Errorf("dueDate must use YYYY-MM-DD")
	}
	return &value, nil
}

func (server *apiServer) listEmployeeTasks(c *gin.Context) {
	if !server.requireRoles(c, "admin", "super_admin") {
		return
	}
	rows, err := server.db.Query(`
		SELECT t.id::text, t.task_number, t.title, t.description, t.status, t.priority,
			COALESCE(t.due_date::text, ''), t.created_at, t.updated_at,
			COALESCE(t.assignee_id::text, ''), COALESCE(assignee.full_name, ''),
			t.created_by::text, creator.full_name
		FROM employee_tasks t
		LEFT JOIN users assignee ON assignee.id = t.assignee_id
		JOIN users creator ON creator.id = t.created_by
		ORDER BY t.created_at DESC, t.task_number DESC
	`)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()

	items := make([]gin.H, 0)
	for rows.Next() {
		var id, number, title, description, status, priority, dueDate string
		var assigneeID, assigneeName, creatorID, creatorName string
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&id, &number, &title, &description, &status, &priority, &dueDate, &createdAt, &updatedAt, &assigneeID, &assigneeName, &creatorID, &creatorName); err != nil {
			httpx.Error(c, http.StatusInternalServerError, err.Error())
			return
		}
		items = append(items, gin.H{
			"id":          id,
			"taskNumber":  number,
			"title":       title,
			"description": description,
			"status":      status,
			"priority":    priority,
			"dueDate":     dueDate,
			"createdAt":   createdAt,
			"updatedAt":   updatedAt,
			"assignee":    gin.H{"id": emptyToNullString(assigneeID), "fullName": assigneeName},
			"createdBy":   gin.H{"id": creatorID, "fullName": creatorName},
		})
	}
	if err := rows.Err(); err != nil {
		httpx.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items})
}

func (server *apiServer) createEmployeeTask(c *gin.Context) {
	if !server.requireRoles(c, "admin", "super_admin") {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32768)
	var input employeeTaskInput
	if err := c.ShouldBindJSON(&input); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid task")
		return
	}
	input.Title = strings.TrimSpace(input.Title)
	input.Description = strings.TrimSpace(input.Description)
	input.AssigneeID = strings.TrimSpace(input.AssigneeID)
	input.Priority = strings.ToLower(strings.TrimSpace(input.Priority))
	if input.Title == "" || utf8.RuneCountInString(input.Title) > 200 || utf8.RuneCountInString(input.Description) > 4000 {
		httpx.Error(c, http.StatusBadRequest, "task title and description are invalid")
		return
	}
	if input.AssigneeID == "" || !taskIDPattern.MatchString(input.AssigneeID) {
		httpx.Error(c, http.StatusBadRequest, "an active assignee is required")
		return
	}
	if input.Priority == "" {
		input.Priority = "medium"
	}
	if !taskPriorities[input.Priority] {
		httpx.Error(c, http.StatusBadRequest, "invalid task priority")
		return
	}
	dueDate, err := parseTaskDueDate(input.DueDate)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, err.Error())
		return
	}

	var entityID sql.NullString
	var active bool
	var assigneeRole string
	err = server.db.QueryRow(`
		SELECT u.entity_id::text, u.is_active, r.name
		FROM users u
		JOIN roles r ON r.id = u.role_id
		WHERE u.id = $1::uuid
	`, input.AssigneeID).Scan(&entityID, &active, &assigneeRole)
	if err != nil || !active || !entityID.Valid || !isTaskAssigneeRole(assigneeRole) {
		if err != nil && err != sql.ErrNoRows {
			httpx.Error(c, http.StatusInternalServerError, err.Error())
			return
		}
		httpx.Error(c, http.StatusBadRequest, "assignee must be an active IT team or super-admin user with an entity")
		return
	}

	claims := middleware.CurrentClaims(c)
	if claims == nil {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized")
		return
	}
	var id, number string
	err = server.db.QueryRow(`
		INSERT INTO employee_tasks (entity_id, title, description, status, priority, assignee_id, created_by, due_date)
		VALUES ($1::uuid, $2, $3, 'pending', $4, $5::uuid, $6::uuid, $7::date)
		RETURNING id::text, task_number
	`, entityID.String, input.Title, input.Description, input.Priority, input.AssigneeID, claims.UserID, dueDate).Scan(&id, &number)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	middleware.TagAudit(c, middleware.AuditMeta{
		Action:     "task_created",
		TargetType: "employee_task",
		TargetID:   id,
		Detail:     gin.H{"taskNumber": number, "title": input.Title, "assigneeId": input.AssigneeID, "priority": input.Priority},
	})
	httpx.Created(c, gin.H{"id": id, "taskNumber": number, "status": "pending"})
}

func (server *apiServer) updateEmployeeTask(c *gin.Context) {
	if !server.requireRoles(c, "admin", "super_admin") {
		return
	}
	id := c.Param("id")
	if !taskIDPattern.MatchString(id) {
		httpx.Error(c, http.StatusBadRequest, "invalid task ID")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32768)
	var input employeeTaskUpdateInput
	if err := c.ShouldBindJSON(&input); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid task update")
		return
	}
	if input.Status == nil && input.AssigneeID == nil && input.DueDate == nil {
		httpx.Error(c, http.StatusBadRequest, "no task changes supplied")
		return
	}
	if input.Status != nil {
		*input.Status = strings.ToLower(strings.TrimSpace(*input.Status))
		if !taskStatuses[*input.Status] {
			httpx.Error(c, http.StatusBadRequest, "invalid task status")
			return
		}
	}
	var dueDate *string
	var err error
	if input.DueDate != nil {
		dueDate, err = parseTaskDueDate(*input.DueDate)
		if err != nil {
			httpx.Error(c, http.StatusBadRequest, err.Error())
			return
		}
	}

	var entityID string
	err = server.db.QueryRow(`SELECT entity_id::text FROM employee_tasks WHERE id = $1::uuid`, id).Scan(&entityID)
	if err == sql.ErrNoRows {
		httpx.Error(c, http.StatusNotFound, "task not found")
		return
	}
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, err.Error())
		return
	}

	sets := make([]string, 0, 4)
	args := []any{id}
	if input.Status != nil {
		args = append(args, *input.Status)
		sets = append(sets, fmt.Sprintf("status = $%d", len(args)))
	}
	if input.AssigneeID != nil {
		assigneeID := strings.TrimSpace(*input.AssigneeID)
		if assigneeID == "" {
			sets = append(sets, "assignee_id = NULL")
		} else {
			if !taskIDPattern.MatchString(assigneeID) {
				httpx.Error(c, http.StatusBadRequest, "invalid assignee ID")
				return
			}
			var assigneeEntity sql.NullString
			var active bool
			var assigneeRole string
			err := server.db.QueryRow(`
				SELECT u.entity_id::text, u.is_active, r.name
				FROM users u
				JOIN roles r ON r.id = u.role_id
				WHERE u.id = $1::uuid
			`, assigneeID).Scan(&assigneeEntity, &active, &assigneeRole)
			if err != nil || !active || !assigneeEntity.Valid || !isTaskAssigneeRole(assigneeRole) {
				if err != nil && err != sql.ErrNoRows {
					httpx.Error(c, http.StatusInternalServerError, err.Error())
					return
				}
				httpx.Error(c, http.StatusBadRequest, "assignee must be an active IT team or super-admin user with an entity")
				return
			}
			args = append(args, assigneeID)
			sets = append(sets, fmt.Sprintf("assignee_id = $%d::uuid", len(args)))
			args = append(args, assigneeEntity.String)
			sets = append(sets, fmt.Sprintf("entity_id = $%d::uuid", len(args)))
			entityID = assigneeEntity.String
		}
	}
	if input.DueDate != nil {
		if dueDate == nil {
			sets = append(sets, "due_date = NULL")
		} else {
			args = append(args, *dueDate)
			sets = append(sets, fmt.Sprintf("due_date = $%d::date", len(args)))
		}
	}
	sets = append(sets, "updated_at = NOW()")
	result, err := server.db.Exec(`UPDATE employee_tasks SET `+strings.Join(sets, ", ")+` WHERE id = $1::uuid`, args...)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	affected, err := result.RowsAffected()
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	if affected == 0 {
		httpx.Error(c, http.StatusNotFound, "task not found")
		return
	}
	middleware.TagAudit(c, middleware.AuditMeta{
		Action:     "task_updated",
		TargetType: "employee_task",
		TargetID:   id,
		Detail:     gin.H{"status": input.Status, "assigneeId": input.AssigneeID, "dueDate": input.DueDate, "entityId": entityID},
	})
	httpx.JSON(c, http.StatusOK, gin.H{"status": "updated"})
}
