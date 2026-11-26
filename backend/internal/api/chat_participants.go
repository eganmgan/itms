package api

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

const participantScope = `u.is_active AND
	EXISTS (SELECT 1 FROM roles r WHERE r.id = u.role_id AND r.name IN ('employee', 'it_team', 'super_admin')) AND
	($3 = 'super_admin' OR
		(u.entity_id = NULLIF($4, '')::uuid) OR
		($3 = 'it_team' AND EXISTS (SELECT 1 FROM user_entity_access a WHERE a.user_id = $2::uuid AND a.entity_id = u.entity_id)))`

func (server *apiServer) listSupportParticipants(c *gin.Context) {
	if !server.requireRoles(c, "employee", "it_team", "super_admin") {
		return
	}
	claims := middleware.CurrentClaims(c)
	id := strings.TrimSpace(c.Param("id"))
	if claims == nil || (id != "" && !validManagementUUID(id)) {
		httpx.Error(c, http.StatusBadRequest, "invalid chat")
		return
	}
	if id != "" {
		allowed, err := server.userIsChatMember(c.Request.Context(), id, claims.UserID)
		if err != nil {
			httpx.Error(c, http.StatusInternalServerError, "participants unavailable")
			return
		}
		if !allowed {
			httpx.Error(c, http.StatusForbidden, "only chat members can view participants")
			return
		}
	}
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 || page > 10000 {
		httpx.Error(c, http.StatusBadRequest, "invalid page")
		return
	}
	search := strings.TrimSpace(c.Query("search"))
	if len(search) > 400 {
		httpx.Error(c, http.StatusBadRequest, "search is too long")
		return
	}
	rows, err := server.db.QueryContext(c.Request.Context(), `SELECT u.id::text, u.full_name,
		(u.id = $2::uuid OR EXISTS (SELECT 1 FROM chat_members m WHERE m.channel_id = NULLIF($1, '')::uuid AND m.user_id = u.id))
		FROM users u WHERE `+participantScope+`
		AND (strpos(lower(u.full_name), lower($6)) > 0 OR strpos(lower(u.emp_id), lower($6)) > 0)
		ORDER BY u.full_name, u.id LIMIT 51 OFFSET $5`, id, claims.UserID, claims.Role, claims.EntityID, (page-1)*50, search)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "participants unavailable")
		return
	}
	defer rows.Close()
	items := make([]gin.H, 0, 50)
	hasMore := false
	for rows.Next() {
		var userID, name string
		var member bool
		if err := rows.Scan(&userID, &name, &member); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "participants unavailable")
			return
		}
		if len(items) == 50 {
			hasMore = true
			break
		}
		items = append(items, gin.H{"id": userID, "fullName": name, "isMember": member})
	}
	if err := rows.Err(); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "participants unavailable")
		return
	}
	c.Header("Cache-Control", "no-store")
	httpx.JSON(c, http.StatusOK, gin.H{"items": items, "hasMore": hasMore})
}

func (server *apiServer) addSupportParticipant(c *gin.Context) {
	if !server.requireRoles(c, "employee", "it_team", "super_admin") {
		return
	}
	claims := middleware.CurrentClaims(c)
	id := strings.TrimSpace(c.Param("id"))
	var input struct {
		UserID string `json:"userId"`
	}
	if claims == nil || !validManagementUUID(id) || bindJSONWithLimit(c, &input, 1024) != nil || !validManagementUUID(input.UserID) {
		httpx.Error(c, http.StatusBadRequest, "valid chat and user are required")
		return
	}
	tx, err := server.db.BeginTx(c.Request.Context(), nil)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "participant could not be added")
		return
	}
	defer tx.Rollback()
	var kind, status string
	var member bool
	err = tx.QueryRowContext(c.Request.Context(), `SELECT c.kind, c.status,
		EXISTS (SELECT 1 FROM chat_members m WHERE m.channel_id = c.id AND m.user_id = $2::uuid)
		FROM chat_channels c WHERE c.id = $1::uuid FOR UPDATE OF c`, id, claims.UserID).Scan(&kind, &status, &member)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "chat not found")
		return
	}
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "participant could not be added")
		return
	}
	if !member {
		httpx.Error(c, http.StatusForbidden, "only chat members can add participants")
		return
	}
	if kind != "support" || status != "open" {
		httpx.Error(c, http.StatusConflict, "only open support chats can add participants")
		return
	}
	var eligible bool
	err = tx.QueryRowContext(c.Request.Context(), `SELECT EXISTS (SELECT 1 FROM users u WHERE u.id = $1::uuid AND u.id <> $2::uuid AND `+participantScope+`)`,
		input.UserID, claims.UserID, claims.Role, claims.EntityID).Scan(&eligible)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "participant could not be added")
		return
	}
	if !eligible {
		httpx.Error(c, http.StatusForbidden, "user is unavailable for this account")
		return
	}
	result, err := tx.ExecContext(c.Request.Context(), `INSERT INTO chat_members (channel_id, user_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`, id, input.UserID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "participant could not be added")
		return
	}
	added, err := result.RowsAffected()
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "addition not confirmed; refresh before retrying")
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "addition not confirmed; refresh before retrying")
		return
	}
	middleware.TagAudit(c, middleware.AuditMeta{Action: "chat_participant_added", TargetType: "chat_channel", TargetID: id, Detail: gin.H{"userId": input.UserID, "added": added}})
	httpx.JSON(c, http.StatusOK, gin.H{"added": added})
}
