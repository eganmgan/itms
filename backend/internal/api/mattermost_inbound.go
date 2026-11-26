package api

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"itms/backend/internal/app"
	"itms/backend/internal/platform/httpx"
)

const (
	mattermostMessageMaxBytes = 1 << 20
	mattermostWebhookMaxBytes = 3*mattermostMessageMaxBytes + 64<<10
	mattermostFeedMaxLimit    = 100
)

type MattermostInboundPost struct {
	PostID      string    `json:"postId"`
	ChannelID   string    `json:"channelId"`
	ChannelName string    `json:"channelName"`
	TeamID      string    `json:"teamId"`
	UserName    string    `json:"userName"`
	Message     string    `json:"message"`
	PostedAt    time.Time `json:"postedAt"`
}

func StoreMattermostInboundPost(ctx context.Context, db *sql.DB, post MattermostInboundPost) error {
	_, err := db.ExecContext(ctx, `
		INSERT INTO mattermost_inbound_posts (
			post_id, channel_id, channel_name, team_id, user_name, message, posted_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (post_id) DO NOTHING
	`, post.PostID, post.ChannelID, post.ChannelName, post.TeamID, post.UserName, post.Message, post.PostedAt)
	return err
}

// RegisterMattermostSyncRoutes exposes the existing sync handlers to a standalone service.
func RegisterMattermostSyncRoutes(router *gin.Engine, db *sql.DB, token, channelID string, authenticate gin.HandlerFunc) {
	server := &apiServer{db: db, config: app.Config{
		MattermostInboundEnabled:   true,
		MattermostWebhookToken:     token,
		MattermostInboundChannelID: channelID,
	}}
	router.POST("/api/integrations/mattermost/webhook", server.receiveMattermostWebhook)
	router.GET("/api/integrations/mattermost/messages", authenticate, server.listMattermostMessages)
}

func (server *apiServer) receiveMattermostWebhook(c *gin.Context) {
	if !server.config.MattermostInboundEnabled || len(server.config.MattermostWebhookToken) < 26 || strings.TrimSpace(server.config.MattermostInboundChannelID) == "" {
		httpx.Error(c, http.StatusServiceUnavailable, "Mattermost inbound sync is not configured")
		return
	}
	if c.Request.URL.RawQuery != "" {
		httpx.Error(c, http.StatusBadRequest, "webhook query parameters are not accepted")
		return
	}
	mediaType, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err != nil || mediaType != "application/x-www-form-urlencoded" {
		httpx.Error(c, http.StatusUnsupportedMediaType, "Mattermost webhook must use form encoding")
		return
	}

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, mattermostWebhookMaxBytes)
	if err := c.Request.ParseForm(); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			httpx.Error(c, http.StatusRequestEntityTooLarge, "Mattermost webhook body is too large")
			return
		}
		httpx.Error(c, http.StatusBadRequest, "Mattermost webhook form is invalid")
		return
	}

	token := c.PostForm("token")
	if len(token) != len(server.config.MattermostWebhookToken) ||
		subtle.ConstantTimeCompare([]byte(token), []byte(server.config.MattermostWebhookToken)) != 1 {
		httpx.Error(c, http.StatusUnauthorized, "invalid Mattermost webhook token")
		return
	}

	channelID := strings.TrimSpace(c.PostForm("channel_id"))
	if channelID == "" || channelID != server.config.MattermostInboundChannelID {
		httpx.Error(c, http.StatusForbidden, "Mattermost channel is not enabled for sync")
		return
	}

	postID := strings.TrimSpace(c.PostForm("post_id"))
	channelName := strings.TrimSpace(c.PostForm("channel_name"))
	teamID := strings.TrimSpace(c.PostForm("team_id"))
	userName := strings.TrimSpace(c.PostForm("user_name"))
	message := c.PostForm("text")
	if !validMattermostPostID(postID) ||
		channelName == "" || len(channelName) > 128 ||
		userName == "" || len(userName) > 128 ||
		len(teamID) > 128 ||
		len(message) > mattermostMessageMaxBytes ||
		!utf8.ValidString(channelName) || !utf8.ValidString(teamID) ||
		!utf8.ValidString(userName) || !utf8.ValidString(message) ||
		strings.ContainsRune(channelName, '\x00') ||
		strings.ContainsRune(teamID, '\x00') ||
		strings.ContainsRune(userName, '\x00') ||
		strings.ContainsRune(message, '\x00') {
		httpx.Error(c, http.StatusBadRequest, "Mattermost webhook fields are invalid")
		return
	}

	timestamp, err := strconv.ParseInt(strings.TrimSpace(c.PostForm("timestamp")), 10, 64)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "Mattermost webhook timestamp is invalid")
		return
	}
	postedAt := time.Unix(timestamp, 0).UTC()
	if postedAt.Before(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)) || postedAt.After(time.Now().Add(24*time.Hour)) {
		httpx.Error(c, http.StatusBadRequest, "Mattermost webhook timestamp is outside the accepted range")
		return
	}

	err = StoreMattermostInboundPost(c.Request.Context(), server.db, MattermostInboundPost{
		PostID: postID, ChannelID: channelID, ChannelName: channelName, TeamID: teamID,
		UserName: userName, Message: message, PostedAt: postedAt,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "failed to store Mattermost message")
		return
	}
	c.Status(http.StatusNoContent)
}

func (server *apiServer) listMattermostMessages(c *gin.Context) {
	limit := 50
	if rawLimit := strings.TrimSpace(c.Query("limit")); rawLimit != "" {
		parsedLimit, err := strconv.Atoi(rawLimit)
		if err != nil || parsedLimit < 1 || parsedLimit > mattermostFeedMaxLimit {
			httpx.Error(c, http.StatusBadRequest, "limit must be between 1 and 100")
			return
		}
		limit = parsedLimit
	}

	rows, err := server.db.QueryContext(c.Request.Context(), `
		SELECT post_id, channel_id, channel_name, team_id, user_name, message, posted_at
		FROM mattermost_inbound_posts
		ORDER BY posted_at DESC, post_id DESC
		LIMIT $1
	`, limit)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "failed to load Mattermost messages")
		return
	}
	defer rows.Close()

	items := make([]MattermostInboundPost, 0, limit)
	for rows.Next() {
		var item MattermostInboundPost
		if err := rows.Scan(
			&item.PostID,
			&item.ChannelID,
			&item.ChannelName,
			&item.TeamID,
			&item.UserName,
			&item.Message,
			&item.PostedAt,
		); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "failed to read Mattermost messages")
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "failed to read Mattermost messages")
		return
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items})
}

func validMattermostPostID(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for _, character := range value {
		if !(character >= 'a' && character <= 'z') &&
			!(character >= 'A' && character <= 'Z') &&
			!(character >= '0' && character <= '9') &&
			character != '_' && character != '-' {
			return false
		}
	}
	return true
}
