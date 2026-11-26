package api

import (
	"database/sql"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/lib/pq"

	"itms/backend/internal/chatbridge"
	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

type chatAssignmentSettings struct {
	Enabled            bool            `json:"enabled"`
	AllowNewChats      bool            `json:"allowNewChats"`
	FallbackAssigneeID string          `json:"fallbackAssigneeId"`
	Routes             []workflowRoute `json:"routes"`
}

func assignmentSettings(settings workflowSettings) chatAssignmentSettings {
	return chatAssignmentSettings{settings.ChatAutoRouteEnabled, settings.ChatAutoCreateEnabled, settings.ChatFallbackAssigneeID, settings.ChatSubjectRoutes}
}

func (server *apiServer) getChatAssignmentSettings(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "admin") {
		return
	}
	settings, err := server.getWorkflowSettingsRecord()
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "chat settings unavailable")
		return
	}
	rows, err := server.db.Query(`SELECT u.id, u.full_name, r.name,
		COALESCE(p.last_seen_at > NOW() - INTERVAL '90 seconds', FALSE)
		FROM users u JOIN roles r ON r.id = u.role_id
		LEFT JOIN chat_agent_presence p ON p.user_id = u.id
		WHERE u.is_active = TRUE AND r.name IN ('it_team', 'super_admin', 'admin')
		ORDER BY u.full_name, u.id`)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "chat agents unavailable")
		return
	}
	defer rows.Close()
	agents := make([]gin.H, 0)
	for rows.Next() {
		var id, name, role string
		var online bool
		if err := rows.Scan(&id, &name, &role, &online); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "chat agents unavailable")
			return
		}
		agents = append(agents, gin.H{"id": id, "fullName": name, "role": role, "online": online})
	}
	if rows.Err() != nil {
		httpx.Error(c, http.StatusInternalServerError, "chat agents unavailable")
		return
	}
	httpx.JSON(c, http.StatusOK, gin.H{"settings": assignmentSettings(settings), "agents": agents})
}

func (server *apiServer) updateChatAssignmentSettings(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "admin") {
		return
	}
	var input chatAssignmentSettings
	if err := bindJSONWithLimit(c, &input, 32<<10); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid chat settings")
		return
	}
	if err := validateChatAssignmentRules(input.Routes); err != nil {
		httpx.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	settings, err := server.getWorkflowSettingsRecord()
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "chat settings unavailable")
		return
	}
	settings.ChatAutoRouteEnabled = input.Enabled
	settings.ChatAutoCreateEnabled = input.AllowNewChats
	settings.ChatFallbackAssigneeID = strings.TrimSpace(input.FallbackAssigneeID)
	settings.ChatSubjectRoutes = normalizeWorkflowRoutes(input.Routes)
	for _, route := range settings.ChatSubjectRoutes {
		if err := server.validateITWorkflowAssignee(route.AssigneeID); err != nil {
			httpx.Error(c, http.StatusBadRequest, "choose an active IT team assignee")
			return
		}
	}
	if err := server.validateITWorkflowAssignee(settings.ChatFallbackAssigneeID); err != nil {
		httpx.Error(c, http.StatusBadRequest, "choose an active fallback assignee")
		return
	}
	if err := server.validateWorkflowScopeAssignments(settings); err != nil {
		httpx.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	saved, err := server.saveWorkflowSettings(settings)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "chat settings were not saved")
		return
	}
	middleware.TagAudit(c, middleware.AuditMeta{Action: "settings_changed", TargetType: "settings", TargetID: workflowSettingsKey, Detail: assignmentSettings(saved)})
	httpx.JSON(c, http.StatusOK, assignmentSettings(saved))
}

func (server *apiServer) chatSupportOptions(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "admin", "it_team", "employee") {
		return
	}
	settings, err := server.getWorkflowSettingsRecord()
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "support options unavailable")
		return
	}
	subjects := make([]string, 0)
	if settings.ChatAutoRouteEnabled {
		for _, route := range settings.ChatSubjectRoutes {
			subjects = append(subjects, route.Match)
		}
	}
	httpx.JSON(c, http.StatusOK, gin.H{"subjects": subjects, "allowNewChats": settings.ChatAutoCreateEnabled})
}

func (server *apiServer) onlineChatAgents(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "admin", "it_team", "employee") {
		return
	}
	claims := middleware.CurrentClaims(c)
	if claims == nil {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized")
		return
	}
	if strings.TrimSpace(claims.EntityID) == "" && claims.Role != "super_admin" {
		httpx.Error(c, http.StatusForbidden, "entity scope required")
		return
	}
	settings, err := server.getWorkflowSettingsRecord()
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "support availability unavailable")
		return
	}
	rows, err := server.db.QueryContext(c.Request.Context(), `SELECT u.id, u.full_name FROM users u
		JOIN roles r ON r.id = u.role_id
		JOIN chat_agent_presence p ON p.user_id = u.id
		WHERE u.is_active = TRUE AND r.name = 'it_team'
		AND p.last_seen_at > NOW() - INTERVAL '90 seconds'
		AND ($1 = '' OR u.entity_id = NULLIF($1, '')::uuid OR EXISTS (
			SELECT 1 FROM user_entity_access access WHERE access.user_id = u.id AND access.entity_id = NULLIF($1, '')::uuid))
		AND (cardinality($2::uuid[]) = 0 OR u.id = ANY($2::uuid[]))
		ORDER BY u.full_name, u.id`, claims.EntityID, pq.Array(settings.ChatMemberIDs))
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "support availability unavailable")
		return
	}
	defer rows.Close()
	agents := make([]gin.H, 0)
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "support availability unavailable")
			return
		}
		agents = append(agents, gin.H{"id": id, "fullName": name})
	}
	if rows.Err() != nil {
		httpx.Error(c, http.StatusInternalServerError, "support availability unavailable")
		return
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": agents})
}

func (server *apiServer) updateChatPresence(c *gin.Context) {
	if !server.requireRoles(c, "it_team", "super_admin", "admin") {
		return
	}
	var input struct {
		Available bool `json:"available"`
	}
	if err := bindJSONWithLimit(c, &input, 1024); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid availability")
		return
	}
	claims := middleware.CurrentClaims(c)
	var err error
	if input.Available {
		_, err = server.db.Exec(`INSERT INTO chat_agent_presence (user_id, last_seen_at) VALUES ($1::uuid, NOW())
			ON CONFLICT (user_id) DO UPDATE SET last_seen_at = NOW()`, claims.UserID)
	} else {
		_, err = server.db.Exec(`DELETE FROM chat_agent_presence WHERE user_id = $1::uuid`, claims.UserID)
	}
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "availability unavailable")
		return
	}
	httpx.JSON(c, http.StatusOK, gin.H{"available": input.Available})
}

func (server *apiServer) onlineChatAssignee(settings workflowSettings, entityID string) (string, error) {
	var id string
	err := server.db.QueryRow(`SELECT u.id FROM users u
		JOIN roles r ON r.id = u.role_id
		JOIN chat_agent_presence p ON p.user_id = u.id
		WHERE u.is_active = TRUE AND r.name IN ('it_team', 'super_admin', 'admin')
		AND p.last_seen_at > NOW() - INTERVAL '90 seconds'
		AND (r.name = 'super_admin' OR u.entity_id = NULLIF($1, '')::uuid OR EXISTS (
			SELECT 1 FROM user_entity_access access WHERE access.user_id = u.id AND access.entity_id = NULLIF($1, '')::uuid))
		AND (cardinality($2::uuid[]) = 0 OR u.id = ANY($2::uuid[]))
		ORDER BY (SELECT COUNT(*) FROM chat_channels channel WHERE channel.primary_owner_id = u.id AND channel.status <> 'closed'), p.last_seen_at DESC, u.id
		LIMIT 1`, entityID, pq.Array(settings.ChatMemberIDs)).Scan(&id)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return id, err
}

func (server *apiServer) postSupportMessage(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "admin", "it_team", "employee") {
		return
	}
	claims := middleware.CurrentClaims(c)
	var input struct {
		Body string `json:"body"`
	}
	if err := bindJSONWithLimit(c, &input, 16<<10); err != nil || strings.TrimSpace(input.Body) == "" || len(input.Body) > 4000 {
		httpx.Error(c, http.StatusBadRequest, "message must contain 1 to 4000 characters")
		return
	}
	channelID := c.Param("id")
	allowed, err := server.userIsChatMember(c.Request.Context(), channelID, claims.UserID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "chat unavailable")
		return
	}
	if !allowed {
		httpx.Error(c, http.StatusForbidden, "forbidden")
		return
	}
	var id, name, kind string
	var createdAt time.Time
	body := strings.TrimSpace(input.Body)
	err = server.db.QueryRow(`WITH inserted AS (
		INSERT INTO chat_messages (channel_id, author_id, body)
		SELECT channel.id, $2::uuid, $3 FROM chat_channels channel
		WHERE channel.id = $1::uuid AND channel.status <> 'closed'
		AND EXISTS (SELECT 1 FROM chat_members member WHERE member.channel_id = channel.id AND member.user_id = $2::uuid)
		RETURNING id, created_at, channel_id)
		SELECT inserted.id, inserted.created_at, channel.name, channel.kind FROM inserted
		JOIN chat_channels channel ON channel.id = inserted.channel_id`, channelID, claims.UserID, body).Scan(&id, &createdAt, &name, &kind)
	if err == sql.ErrNoRows {
		httpx.Error(c, http.StatusConflict, "chat closed or access changed")
		return
	}
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "message not confirmed; refresh chat before retrying")
		return
	}
	if server.chat != nil {
		server.chat.publish(channelID, chatEnvelope{Type: "message", ChannelID: channelID, MessageID: id, AuthorID: claims.UserID, AuthorName: claims.Name, Body: body, CreatedAt: createdAt.UTC().Format(time.RFC3339Nano)})
	}
	server.mirrorChatMessageToMattermost(c.Request.Context(), chatbridge.OutboundMessageInput{ChatChannelID: channelID, ChannelName: name, ChannelKind: kind, ChatMessageID: id, AuthorName: claims.Name, Body: body})
	httpx.Created(c, gin.H{"id": id, "body": body, "createdAt": createdAt, "author": gin.H{"id": claims.UserID, "fullName": claims.Name}})
}

func (server *apiServer) listWaitingSupportChats(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "admin", "it_team") {
		return
	}
	claims := middleware.CurrentClaims(c)
	if err := server.validateChatMemberAssignee(claims.UserID); err != nil {
		httpx.Error(c, http.StatusForbidden, "chat assignment is not enabled for this account")
		return
	}
	rows, err := server.db.Query(`SELECT channel.id, channel.name, creator.full_name FROM chat_channels channel
		JOIN users creator ON creator.id = channel.created_by
		WHERE channel.kind = 'support' AND channel.status <> 'closed' AND channel.primary_owner_id IS NULL
		AND ($1 = 'super_admin' OR creator.entity_id = NULLIF($2, '')::uuid OR EXISTS (
			SELECT 1 FROM user_entity_access access WHERE access.user_id = $3::uuid AND access.entity_id = creator.entity_id))
		ORDER BY channel.created_at ASC LIMIT 50`, claims.Role, claims.EntityID, claims.UserID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "waiting chats unavailable")
		return
	}
	defer rows.Close()
	items := make([]gin.H, 0)
	for rows.Next() {
		var id, name, requester string
		if err := rows.Scan(&id, &name, &requester); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "waiting chats unavailable")
			return
		}
		items = append(items, gin.H{"id": id, "name": name, "requester": requester})
	}
	if rows.Err() != nil {
		httpx.Error(c, http.StatusInternalServerError, "waiting chats unavailable")
		return
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items})
}

func (server *apiServer) claimSupportChat(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "admin", "it_team") {
		return
	}
	claims := middleware.CurrentClaims(c)
	if err := server.validateChatMemberAssignee(claims.UserID); err != nil {
		httpx.Error(c, http.StatusForbidden, "chat assignment is not enabled for this account")
		return
	}
	tx, err := server.db.BeginTx(c.Request.Context(), nil)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "chat assignment unavailable")
		return
	}
	defer tx.Rollback()
	var id string
	err = tx.QueryRow(`UPDATE chat_channels channel SET primary_owner_id = $2::uuid
		FROM users creator WHERE channel.id = $1::uuid AND creator.id = channel.created_by
		AND channel.kind = 'support' AND channel.status <> 'closed' AND channel.primary_owner_id IS NULL
		AND ($3 = 'super_admin' OR creator.entity_id = NULLIF($4, '')::uuid OR EXISTS (
			SELECT 1 FROM user_entity_access access WHERE access.user_id = $2::uuid AND access.entity_id = creator.entity_id))
		RETURNING channel.id`, c.Param("id"), claims.UserID, claims.Role, claims.EntityID).Scan(&id)
	if err == sql.ErrNoRows {
		httpx.Error(c, http.StatusConflict, "chat is no longer available for assignment")
		return
	}
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "chat assignment unavailable")
		return
	}
	if _, err := tx.Exec(`INSERT INTO chat_members (channel_id, user_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`, id, claims.UserID); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "chat assignment unavailable")
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "chat assignment not confirmed")
		return
	}
	middleware.TagAudit(c, middleware.AuditMeta{Action: "chat_owner_changed", TargetType: "chat_channel", TargetID: id, Detail: gin.H{"primaryOwnerId": claims.UserID}})
	httpx.JSON(c, http.StatusOK, gin.H{"id": id, "primaryOwner": gin.H{"id": claims.UserID, "fullName": claims.Name}})
}
