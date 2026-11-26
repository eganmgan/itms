package api

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

func (server *apiServer) transferSupportChat(c *gin.Context) {
	if !server.requireRoles(c, "it_team", "admin", "super_admin") {
		return
	}
	claims := middleware.CurrentClaims(c)
	if claims == nil {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized")
		return
	}
	channelID := strings.TrimSpace(c.Param("id"))
	var input struct {
		OwnerID string `json:"ownerId"`
	}
	if !validManagementUUID(channelID) || bindJSONWithLimit(c, &input, 1024) != nil || !validManagementUUID(input.OwnerID) {
		httpx.Error(c, http.StatusBadRequest, "valid chat and owner are required")
		return
	}
	settings, err := server.getWorkflowSettingsRecord()
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "chat assignment unavailable")
		return
	}
	if len(settings.ChatMemberIDs) > 0 && !containsWorkflowID(settings.ChatMemberIDs, input.OwnerID) {
		httpx.Error(c, http.StatusConflict, "selected IT team member is not enabled for chat")
		return
	}
	tx, err := server.db.BeginTx(c.Request.Context(), nil)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "chat assignment unavailable")
		return
	}
	defer tx.Rollback()
	var status, kind, creatorEntity string
	var member bool
	err = tx.QueryRowContext(c.Request.Context(), `SELECT c.status, c.kind, COALESCE(creator.entity_id::text, ''),
		EXISTS (SELECT 1 FROM chat_members m WHERE m.channel_id = c.id AND m.user_id = $2::uuid)
		FROM chat_channels c JOIN users creator ON creator.id = c.created_by
		WHERE c.id = $1::uuid FOR UPDATE OF c`, channelID, claims.UserID).Scan(&status, &kind, &creatorEntity, &member)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "chat not found")
		return
	}
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "chat assignment unavailable")
		return
	}
	if !member && claims.Role != "super_admin" {
		httpx.Error(c, http.StatusForbidden, "only chat members or super admins can transfer chats")
		return
	}
	if kind != "support" || status != "open" {
		httpx.Error(c, http.StatusConflict, "only open support chats can be transferred")
		return
	}
	var eligible bool
	err = tx.QueryRowContext(c.Request.Context(), `SELECT EXISTS (
		SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id
		JOIN chat_agent_presence p ON p.user_id = u.id
		WHERE u.id = $1::uuid AND u.is_active AND r.name = 'it_team'
		AND p.last_seen_at > NOW() - INTERVAL '90 seconds'
		AND (u.entity_id = NULLIF($2, '')::uuid OR EXISTS (
			SELECT 1 FROM user_entity_access a WHERE a.user_id = u.id AND a.entity_id = NULLIF($2, '')::uuid))
	)`, input.OwnerID, creatorEntity).Scan(&eligible)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "chat assignment unavailable")
		return
	}
	if !eligible {
		httpx.Error(c, http.StatusConflict, "selected IT team member is offline or unavailable for this company")
		return
	}
	if _, err := tx.ExecContext(c.Request.Context(), `INSERT INTO chat_members (channel_id, user_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`, channelID, input.OwnerID); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "chat assignment could not be saved")
		return
	}
	if _, err := tx.ExecContext(c.Request.Context(), `UPDATE chat_channels SET primary_owner_id = $2::uuid, backup_owner_id = CASE WHEN backup_owner_id = $2::uuid THEN NULL ELSE backup_owner_id END WHERE id = $1::uuid`, channelID, input.OwnerID); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "chat assignment could not be saved")
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "chat assignment could not be confirmed")
		return
	}
	middleware.TagAudit(c, middleware.AuditMeta{Action: "chat_channel_owner_updated", TargetType: "chat_channel", TargetID: channelID, Detail: gin.H{"ownerId": input.OwnerID}})
	httpx.JSON(c, http.StatusOK, gin.H{"ownerId": input.OwnerID})
}
