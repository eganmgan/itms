package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

func (server *apiServer) listLegacySupportChats(c *gin.Context) {
	claims := middleware.CurrentClaims(c)
	if claims == nil {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized")
		return
	}
	status := strings.ToLower(strings.TrimSpace(c.Query("status")))
	if status != "open" && status != "closed" {
		status = "open"
	}
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil || page < 1 {
		page = 1
	}
	const pageSize = 20
	search := strings.ToLower(strings.TrimSpace(c.Query("search")))

	where := "m.user_id = $1::uuid AND c.kind = 'support' AND c.status = $2"
	args := []any{claims.UserID, status}
	argIndex := 3
	if search != "" {
		where += fmt.Sprintf(" AND (lower(c.name) LIKE $%d OR EXISTS (SELECT 1 FROM chat_messages cm_search WHERE cm_search.channel_id = c.id AND lower(cm_search.body) LIKE $%d))", argIndex, argIndex)
		args = append(args, "%"+search+"%")
		argIndex++
	}
	var total int
	if err := server.db.QueryRow(`SELECT COUNT(DISTINCT c.id) FROM chat_channels c JOIN chat_members m ON m.channel_id = c.id WHERE `+where, args...).Scan(&total); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "support chats unavailable")
		return
	}
	queryArgs := append([]any{}, args...)
	queryArgs = append(queryArgs, pageSize, (page-1)*pageSize)
	rows, err := server.db.Query(`
		SELECT c.id, c.name, c.status, c.created_at, c.created_by,
			COALESCE(creator.full_name, ''), c.primary_owner_id, COALESCE(owner.full_name, ''),
			COALESCE(c.linked_request_id::text, '')
		FROM chat_channels c
		JOIN chat_members m ON m.channel_id = c.id
		LEFT JOIN users creator ON creator.id = c.created_by
		LEFT JOIN users owner ON owner.id = c.primary_owner_id
		WHERE `+where+`
		ORDER BY COALESCE((SELECT MAX(created_at) FROM chat_messages WHERE channel_id = c.id), c.created_at) DESC
		LIMIT $`+strconv.Itoa(argIndex)+` OFFSET $`+strconv.Itoa(argIndex+1), queryArgs...)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "support chats unavailable")
		return
	}
	defer rows.Close()
	items := make([]gin.H, 0)
	openCount := total
	if status == "closed" {
		openCount = 0
	}
	for rows.Next() {
		var id, name, chatStatus string
		var createdAt time.Time
		var creatorID, creatorName, ownerID, ownerName, linkedID string
		if err := rows.Scan(&id, &name, &chatStatus, &createdAt, &creatorID, &creatorName, &ownerID, &ownerName, &linkedID); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "support chats unavailable")
			return
		}
		items = append(items, gin.H{
			"id": id, "name": name, "status": chatStatus, "createdAt": createdAt.UTC().Format(time.RFC3339Nano),
			"employee":        gin.H{"id": creatorID, "fullName": creatorName},
			"employeeId":      creatorID,
			"owner":           gin.H{"id": ownerID, "fullName": ownerName},
			"ownerId":         ownerID,
			"intakePending":   false,
			"resolutionNotes": "",
		})
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items, "page": page, "pageSize": pageSize, "total": total, "open": openCount, "unread": 0})
}

func (server *apiServer) createLegacySupportChat(c *gin.Context) {
	var input struct {
		Name string `json:"name"`
		Body string `json:"body"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid support chat payload")
		return
	}
	payload, _ := json.Marshal(gin.H{"name": input.Name, "kind": "support", "initialMessage": input.Body})
	c.Request.Body = io.NopCloser(bytes.NewReader(payload))
	c.Request.ContentLength = int64(len(payload))
	server.createChatChannel(c)
}

func (server *apiServer) listLegacySupportMessages(c *gin.Context) {
	claims := middleware.CurrentClaims(c)
	if claims == nil {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized")
		return
	}
	channelID := strings.TrimSpace(c.Param("id"))
	allowed, err := server.userIsChatMember(c.Request.Context(), channelID, claims.UserID)
	if err != nil || !allowed {
		httpx.Error(c, http.StatusForbidden, "forbidden")
		return
	}
	var name, status, creatorID, creatorName, ownerID, ownerName string
	err = server.db.QueryRow(`
		SELECT c.name, c.status, c.created_by, COALESCE(creator.full_name, ''),
			COALESCE(c.primary_owner_id::text, ''), COALESCE(owner.full_name, '')
		FROM chat_channels c
		LEFT JOIN users creator ON creator.id = c.created_by
		LEFT JOIN users owner ON owner.id = c.primary_owner_id
		WHERE c.id = $1::uuid`, channelID).
		Scan(&name, &status, &creatorID, &creatorName, &ownerID, &ownerName)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "support chat not found")
		return
	}
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil || page < 1 {
		page = 1
	}
	const pageSize = 100
	offset := (page - 1) * pageSize
	var total int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM chat_messages WHERE channel_id = $1::uuid`, channelID).Scan(&total); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "messages unavailable")
		return
	}
	rows, err := server.db.Query(`
		SELECT m.id, m.body, m.created_at, u.id, u.full_name
		FROM (
			SELECT m.* FROM chat_messages m WHERE m.channel_id = $1::uuid
			ORDER BY m.created_at DESC LIMIT $2 OFFSET $3
		) m JOIN users u ON u.id = m.author_id
		ORDER BY m.created_at ASC`, channelID, pageSize, offset)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "messages unavailable")
		return
	}
	defer rows.Close()
	items := make([]gin.H, 0)
	sequence := (page - 1) * pageSize
	for rows.Next() {
		var id, body, authorID, authorName string
		var createdAt time.Time
		if err := rows.Scan(&id, &body, &createdAt, &authorID, &authorName); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "messages unavailable")
			return
		}
		sequence++
		items = append(items, gin.H{"id": id, "body": body, "sequence": sequence, "createdAt": createdAt.UTC().Format(time.RFC3339Nano),
			"author": gin.H{"id": authorID, "fullName": authorName}})
	}
	httpx.JSON(c, http.StatusOK, gin.H{
		"items": items, "total": total, "page": page, "pageSize": pageSize,
		"conversation": gin.H{"id": channelID, "name": name, "status": status, "employee": gin.H{"id": creatorID, "fullName": creatorName},
			"employeeId": creatorID, "owner": gin.H{"id": ownerID, "fullName": ownerName}, "ownerId": ownerID,
			"intakePending": false, "resolutionNotes": ""},
		"employeeId": creatorID, "ownerId": ownerID, "status": status,
	})
}

func (server *apiServer) postLegacySupportMessage(c *gin.Context) {
	server.postSupportMessage(c)
}

func (server *apiServer) markLegacySupportRead(c *gin.Context) {
	httpx.JSON(c, http.StatusOK, gin.H{"ok": true})
}

func (server *apiServer) changeLegacySupportChat(c *gin.Context) {
	var input struct {
		Action  string `json:"action"`
		OwnerID string `json:"ownerId"`
		Notes   string `json:"notes"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid support chat action")
		return
	}
	switch strings.ToLower(strings.TrimSpace(input.Action)) {
	case "resolve":
		server.closeChatChannel(c)
	case "reopen":
		server.reopenChatChannel(c)
	case "transfer":
		if input.OwnerID == "" {
			httpx.Error(c, http.StatusBadRequest, "ownerId is required")
			return
		}
		payload, _ := json.Marshal(gin.H{"ownerId": input.OwnerID})
		c.Request.Body = io.NopCloser(bytes.NewReader(payload))
		c.Request.ContentLength = int64(len(payload))
		server.transferSupportChat(c)
	default:
		httpx.Error(c, http.StatusBadRequest, "unsupported support chat action")
	}
}

func (server *apiServer) listLegacySupportStaff(c *gin.Context) {
	rows, err := server.db.Query(`
		SELECT u.id, u.full_name,
			(SELECT COUNT(*) FROM chat_channels c
			 JOIN chat_members m ON m.channel_id = c.id
			 WHERE c.primary_owner_id = u.id OR m.user_id = u.id AND c.status <> 'closed')::int
		FROM users u JOIN roles r ON r.id = u.role_id
		WHERE r.name IN ('it_team','admin','super_admin') AND u.is_active = TRUE
		ORDER BY u.full_name ASC`)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "support staff unavailable")
		return
	}
	defer rows.Close()
	items := make([]gin.H, 0)
	for rows.Next() {
		var id, name string
		var active int
		if err := rows.Scan(&id, &name, &active); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "support staff unavailable")
			return
		}
		items = append(items, gin.H{"id": id, "fullName": name, "active": active})
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items})
}

func (server *apiServer) legacySupportEvents(c *gin.Context) {
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("X-Accel-Buffering", "no")
	c.Status(http.StatusOK)
	_, _ = c.Writer.WriteString("event: refresh\ndata: {}\n\n")
	c.Writer.Flush()
}
