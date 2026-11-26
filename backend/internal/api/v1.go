package api

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

func (server *apiServer) registerV1Routes(api *gin.RouterGroup) {
	api.GET("/health", server.healthCheck)
	api.GET("/openapi.json", serveOpenAPIV1)
	server.registerAuthRoutes(api)
	auth := api.Group("/auth")
	auth.Use(middleware.RateLimit(true))
	{
		auth.POST("/refresh", server.refreshSession)
		auth.POST("/forgot-password", server.requestPasswordReset)
		auth.POST("/reset-password", server.confirmPasswordReset)
	}
	protected := api.Group("")
	protected.Use(middleware.AuthRequired(server.auth), middleware.RateLimit(false), server.portalAccessGuard)
	{
		protected.GET("/departments", server.listDepartments)
		protected.POST("/departments", server.createDepartment)
		protected.PATCH("/departments/:id", server.updateDepartment)
		protected.DELETE("/departments/:id", server.deleteDepartment)

		protected.GET("/users", server.listUsers)
		protected.POST("/users", server.createUser)
		protected.GET("/users/:id", server.getUser)
		protected.PATCH("/users/:id", server.updateUser)
		protected.DELETE("/users/:id", server.deactivateUser)

		protected.GET("/assets", server.listAssets)
		protected.POST("/assets", server.createAsset)
		protected.GET("/assets/:id", server.getAsset)
		protected.PATCH("/assets/:id", server.updateAsset)
		protected.DELETE("/assets/:id", server.deleteAsset)
		protected.GET("/me/assets", server.getMyAssets)

		protected.GET("/tickets", server.listTicketsV1)
		protected.POST("/tickets", server.createMyRequest)
		protected.GET("/tickets/:id", server.getTicketV1)
		protected.POST("/tickets/:id/comments", server.addTicketCommentV1)
		protected.PATCH("/tickets/:id/status", server.updateRequestStatus)
		protected.POST("/tickets/:id/assign", server.assignRequest)
		protected.GET("/tickets/:id/internal-notes", server.listTicketInternalNotes)
		protected.POST("/tickets/:id/internal-notes", server.createTicketInternalNote)
		protected.GET("/tickets/:id/attachments", server.listTicketAttachments)
		protected.POST("/tickets/:id/attachments", server.uploadTicketAttachment)
		protected.GET("/ticket-attachments/:id", server.downloadTicketAttachment)

		protected.GET("/ticket-categories", server.listTicketCategories)
		protected.POST("/ticket-categories", server.createTicketCategory)
		protected.PATCH("/ticket-categories/:id", server.updateTicketCategory)
		protected.DELETE("/ticket-categories/:id", server.deleteTicketCategory)

		protected.GET("/notifications", server.listNotifications)
		protected.PATCH("/notifications/:id/read", server.readNotification)
		protected.POST("/notifications/read-all", server.readAllNotifications)
		protected.GET("/reports/service-desk", server.serviceDeskReport)
		protected.GET("/audit", server.listAudit)
		protected.GET("/settings", server.getWorkflowSettings)
		protected.PUT("/settings", server.updateWorkflowSettings)
	}
}

func (server *apiServer) listTicketsV1(c *gin.Context) {
	claims := middleware.CurrentClaims(c)
	if claims != nil && claims.Role == "employee" {
		server.listMyRequests(c)
		return
	}
	server.listRequests(c)
}

func (server *apiServer) ticketVisible(c *gin.Context, ticketID string) (bool, error) {
	claims := middleware.CurrentClaims(c)
	if claims == nil {
		return false, nil
	}
	if claims.Role == "employee" {
		var exists bool
		err := server.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM requests WHERE id = $1::uuid AND requester_id = $2::uuid)`, ticketID, claims.UserID).Scan(&exists)
		return exists, err
	}
	_, err := server.requestScope(c, ticketID)
	return err == nil, err
}

func (server *apiServer) getTicketV1(c *gin.Context) {
	allowed, err := server.ticketVisible(c, c.Param("id"))
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		httpx.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	if !allowed || errors.Is(err, sql.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "ticket not found")
		return
	}
	items, err := server.loadRequests(` WHERE r.id = $1::uuid`, c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	if len(items) == 0 {
		httpx.Error(c, http.StatusNotFound, "ticket not found")
		return
	}
	httpx.JSON(c, http.StatusOK, items[0])
}

func (server *apiServer) addTicketCommentV1(c *gin.Context) {
	allowed, err := server.ticketVisible(c, c.Param("id"))
	if err != nil || !allowed {
		httpx.Error(c, http.StatusNotFound, "ticket not found")
		return
	}
	var input struct {
		Note string `json:"note"`
	}
	if err := c.ShouldBindJSON(&input); err != nil || strings.TrimSpace(input.Note) == "" {
		httpx.Error(c, http.StatusBadRequest, "note is required")
		return
	}
	claims := middleware.CurrentClaims(c)
	var id string
	err = server.db.QueryRow(`INSERT INTO request_comments (request_id, author_id, note) VALUES ($1::uuid, $2::uuid, $3) RETURNING id`, c.Param("id"), claims.UserID, strings.TrimSpace(input.Note)).Scan(&id)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	middleware.TagAudit(c, middleware.AuditMeta{Action: "ticket_commented", TargetType: "request", TargetID: c.Param("id")})
	httpx.Created(c, gin.H{"id": id})
}

func (server *apiServer) listTicketInternalNotes(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team") {
		return
	}
	if _, err := server.requestScope(c, c.Param("id")); err != nil {
		httpx.Error(c, http.StatusNotFound, "ticket not found")
		return
	}
	rows, err := server.db.Query(`SELECT n.id, n.note, n.created_at, u.id, u.full_name FROM ticket_internal_notes n JOIN users u ON u.id = n.author_id WHERE n.ticket_id = $1::uuid ORDER BY n.created_at`, c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	items := make([]gin.H, 0)
	for rows.Next() {
		var id, note, authorID, authorName string
		var createdAt time.Time
		if err := rows.Scan(&id, &note, &createdAt, &authorID, &authorName); err != nil {
			httpx.Error(c, http.StatusInternalServerError, err.Error())
			return
		}
		items = append(items, gin.H{"id": id, "note": note, "createdAt": createdAt, "author": gin.H{"id": authorID, "fullName": authorName}})
	}
	httpx.JSON(c, http.StatusOK, items)
}

func (server *apiServer) createTicketInternalNote(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team") {
		return
	}
	if _, err := server.requestScope(c, c.Param("id")); err != nil {
		httpx.Error(c, http.StatusNotFound, "ticket not found")
		return
	}
	var input struct {
		Note string `json:"note"`
	}
	if err := c.ShouldBindJSON(&input); err != nil || strings.TrimSpace(input.Note) == "" || len(strings.TrimSpace(input.Note)) > 10000 {
		httpx.Error(c, http.StatusBadRequest, "note must contain 1 to 10000 characters")
		return
	}
	claims := middleware.CurrentClaims(c)
	var id string
	if err := server.db.QueryRow(`INSERT INTO ticket_internal_notes (ticket_id, author_id, note) VALUES ($1::uuid, $2::uuid, $3) RETURNING id`, c.Param("id"), claims.UserID, strings.TrimSpace(input.Note)).Scan(&id); err != nil {
		httpx.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	middleware.TagAudit(c, middleware.AuditMeta{Action: "ticket_internal_note_added", TargetType: "request", TargetID: c.Param("id")})
	httpx.Created(c, gin.H{"id": id})
}

func (server *apiServer) uploadTicketAttachment(c *gin.Context) {
	allowed, err := server.ticketVisible(c, c.Param("id"))
	if err != nil || !allowed {
		httpx.Error(c, http.StatusNotFound, "ticket not found")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 9<<20)
	header, err := c.FormFile("file")
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "file is required")
		return
	}
	file, err := header.Open()
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid file")
		return
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, 8<<20+1))
	if err != nil || len(content) == 0 || len(content) > 8<<20 {
		httpx.Error(c, http.StatusBadRequest, "file must contain 1 byte to 8 MB")
		return
	}
	contentType := http.DetectContentType(content)
	if contentType != "application/pdf" && contentType != "text/plain; charset=utf-8" && !strings.HasPrefix(contentType, "image/") {
		httpx.Error(c, http.StatusBadRequest, "only PDF, text, and image attachments are supported")
		return
	}
	digest := sha256.Sum256(content)
	claims := middleware.CurrentClaims(c)
	var id string
	err = server.db.QueryRow(`INSERT INTO ticket_attachments (ticket_id, uploaded_by, file_name, content_type, size_bytes, checksum_sha256, content) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7) RETURNING id`, c.Param("id"), claims.UserID, filepath.Base(header.Filename), contentType, len(content), hex.EncodeToString(digest[:]), content).Scan(&id)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	middleware.TagAudit(c, middleware.AuditMeta{Action: "ticket_attachment_uploaded", TargetType: "request", TargetID: c.Param("id"), Detail: gin.H{"attachment_id": id, "size_bytes": len(content)}})
	httpx.Created(c, gin.H{"id": id, "fileName": filepath.Base(header.Filename), "contentType": contentType, "sizeBytes": len(content)})
}

func (server *apiServer) listTicketAttachments(c *gin.Context) {
	allowed, err := server.ticketVisible(c, c.Param("id"))
	if err != nil || !allowed {
		httpx.Error(c, http.StatusNotFound, "ticket not found")
		return
	}
	rows, err := server.db.Query(`SELECT a.id, a.file_name, a.content_type, a.size_bytes, a.checksum_sha256, a.created_at, u.full_name FROM ticket_attachments a JOIN users u ON u.id = a.uploaded_by WHERE a.ticket_id = $1::uuid ORDER BY a.created_at DESC`, c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	items := make([]gin.H, 0)
	for rows.Next() {
		var id, fileName, contentType, checksum, uploader string
		var size int
		var createdAt time.Time
		if err := rows.Scan(&id, &fileName, &contentType, &size, &checksum, &createdAt, &uploader); err != nil {
			httpx.Error(c, http.StatusInternalServerError, err.Error())
			return
		}
		items = append(items, gin.H{"id": id, "fileName": fileName, "contentType": contentType, "sizeBytes": size, "checksumSha256": checksum, "createdAt": createdAt, "uploadedBy": uploader})
	}
	httpx.JSON(c, http.StatusOK, items)
}

func (server *apiServer) downloadTicketAttachment(c *gin.Context) {
	var ticketID, fileName, contentType string
	var content []byte
	if err := server.db.QueryRow(`SELECT ticket_id::text, file_name, content_type, content FROM ticket_attachments WHERE id = $1::uuid`, c.Param("id")).Scan(&ticketID, &fileName, &contentType, &content); err != nil {
		httpx.Error(c, http.StatusNotFound, "attachment not found")
		return
	}
	allowed, err := server.ticketVisible(c, ticketID)
	if err != nil || !allowed {
		httpx.Error(c, http.StatusNotFound, "attachment not found")
		return
	}
	c.Header("Content-Disposition", `attachment; filename="`+strings.ReplaceAll(fileName, `"`, "")+`"`)
	c.Data(http.StatusOK, contentType, content)
}

func (server *apiServer) listTicketCategories(c *gin.Context) {
	claims := middleware.CurrentClaims(c)
	rows, err := server.db.Query(`SELECT id, name, COALESCE(description, ''), is_active, created_at, updated_at FROM ticket_categories WHERE entity_id = $1::uuid ORDER BY name`, claims.EntityID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	items := make([]gin.H, 0)
	for rows.Next() {
		var id, name, description string
		var active bool
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&id, &name, &description, &active, &createdAt, &updatedAt); err != nil {
			httpx.Error(c, http.StatusInternalServerError, err.Error())
			return
		}
		items = append(items, gin.H{"id": id, "name": name, "description": description, "isActive": active, "createdAt": createdAt, "updatedAt": updatedAt})
	}
	httpx.JSON(c, http.StatusOK, items)
}

func (server *apiServer) createTicketCategory(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team") {
		return
	}
	var input struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := c.ShouldBindJSON(&input); err != nil || strings.TrimSpace(input.Name) == "" {
		httpx.Error(c, http.StatusBadRequest, "name is required")
		return
	}
	claims := middleware.CurrentClaims(c)
	var id string
	err := server.db.QueryRow(`INSERT INTO ticket_categories (entity_id, name, description) VALUES ($1::uuid, $2, NULLIF($3, '')) RETURNING id`, claims.EntityID, strings.TrimSpace(input.Name), strings.TrimSpace(input.Description)).Scan(&id)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	httpx.Created(c, gin.H{"id": id})
}

func (server *apiServer) updateTicketCategory(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team") {
		return
	}
	var input struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
		IsActive    *bool   `json:"isActive"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid category payload")
		return
	}
	claims := middleware.CurrentClaims(c)
	result, err := server.db.Exec(`UPDATE ticket_categories SET name = COALESCE(NULLIF($3, ''), name), description = COALESCE($4, description), is_active = COALESCE($5, is_active), updated_at = NOW() WHERE id = $1::uuid AND entity_id = $2::uuid`, c.Param("id"), claims.EntityID, optionalTrimmedString(input.Name), input.Description, input.IsActive)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	if count, _ := result.RowsAffected(); count == 0 {
		httpx.Error(c, http.StatusNotFound, "category not found")
		return
	}
	httpx.JSON(c, http.StatusOK, gin.H{"status": "updated"})
}

func optionalTrimmedString(value *string) any {
	if value == nil {
		return nil
	}
	return strings.TrimSpace(*value)
}

func (server *apiServer) deleteTicketCategory(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team") {
		return
	}
	claims := middleware.CurrentClaims(c)
	result, err := server.db.Exec(`UPDATE ticket_categories SET is_active = FALSE, updated_at = NOW() WHERE id = $1::uuid AND entity_id = $2::uuid`, c.Param("id"), claims.EntityID)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	if count, _ := result.RowsAffected(); count == 0 {
		httpx.Error(c, http.StatusNotFound, "category not found")
		return
	}
	c.Status(http.StatusNoContent)
}

func (server *apiServer) listNotifications(c *gin.Context) {
	claims := middleware.CurrentClaims(c)
	page, pageSize, _ := parsePaginationRequest(c, 25)
	var total int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM notifications WHERE user_id = $1::uuid`, claims.UserID).Scan(&total); err != nil {
		httpx.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	rows, err := server.db.Query(`SELECT id, type, title, COALESCE(body, ''), COALESCE(target_type, ''), COALESCE(target_id::text, ''), read_at, created_at FROM notifications WHERE user_id = $1::uuid ORDER BY created_at DESC LIMIT $2 OFFSET $3`, claims.UserID, pageSize, (page-1)*pageSize)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	items := make([]gin.H, 0)
	for rows.Next() {
		var id, kind, title, body, targetType, targetID string
		var readAt sql.NullTime
		var createdAt time.Time
		if err := rows.Scan(&id, &kind, &title, &body, &targetType, &targetID, &readAt, &createdAt); err != nil {
			httpx.Error(c, http.StatusInternalServerError, err.Error())
			return
		}
		items = append(items, gin.H{"id": id, "type": kind, "title": title, "body": body, "targetType": targetType, "targetId": targetID, "readAt": nullTime(readAt), "createdAt": createdAt})
	}
	httpx.JSON(c, http.StatusOK, paginatedResponse{Items: items, Total: total, Page: page, PageSize: pageSize})
}

func (server *apiServer) readNotification(c *gin.Context) {
	claims := middleware.CurrentClaims(c)
	result, err := server.db.Exec(`UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1::uuid AND user_id = $2::uuid`, c.Param("id"), claims.UserID)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	if count, _ := result.RowsAffected(); count == 0 {
		httpx.Error(c, http.StatusNotFound, "notification not found")
		return
	}
	httpx.JSON(c, http.StatusOK, gin.H{"status": "read"})
}

func (server *apiServer) readAllNotifications(c *gin.Context) {
	claims := middleware.CurrentClaims(c)
	result, err := server.db.Exec(`UPDATE notifications SET read_at = NOW() WHERE user_id = $1::uuid AND read_at IS NULL`, claims.UserID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	count, _ := result.RowsAffected()
	httpx.JSON(c, http.StatusOK, gin.H{"updated": count})
}

func (server *apiServer) serviceDeskReport(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team") {
		return
	}
	claims := middleware.CurrentClaims(c)
	rows, err := server.db.Query(`SELECT r.status, COUNT(*), COUNT(*) FILTER (WHERE r.sla_deadline IS NOT NULL AND r.sla_deadline < NOW() AND r.status NOT IN ('resolved', 'closed')) FROM requests r JOIN users u ON u.id = r.requester_id WHERE $1 = 'super_admin' OR (u.entity_id = $2::uuid AND (r.requester_id = $3::uuid OR r.assignee_id = $3::uuid)) GROUP BY r.status ORDER BY r.status`, claims.Role, claims.EntityID, claims.UserID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	items := make([]gin.H, 0)
	for rows.Next() {
		var status string
		var total, breached int
		if err := rows.Scan(&status, &total, &breached); err != nil {
			httpx.Error(c, http.StatusInternalServerError, err.Error())
			return
		}
		items = append(items, gin.H{"status": status, "total": total, "slaBreached": breached})
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items, "generatedAt": time.Now().UTC()})
}