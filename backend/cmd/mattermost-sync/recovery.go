package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"itms/backend/internal/api"
)

const (
	recoveryPageSize     = 50
	recoveryOverlap      = 2 * time.Minute
	recoveryAudit        = 24 * time.Hour
	recoveryInterval     = time.Minute
	recoveryMaxStaleness = 5 * time.Minute
)

type recoveryPost struct {
	ID        string `json:"id"`
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
	Message   string `json:"message"`
	Type      string `json:"type"`
	CreateAt  int64  `json:"create_at"`
}

type recoveryPostList struct {
	Order []string                `json:"order"`
	Posts map[string]recoveryPost `json:"posts"`
}

type recoveryService struct {
	db          *sql.DB
	client      *http.Client
	baseURL     string
	login       string
	password    string
	channelID   string
	startMS     int64
	token       string
	lastSuccess atomic.Int64
}

func (service *recoveryService) loginSession(ctx context.Context) error {
	body, err := json.Marshal(map[string]string{"login_id": service.login, "password": service.password})
	if err != nil {
		return fmt.Errorf("encode Mattermost login: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, service.baseURL+"/api/v4/users/login", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create Mattermost login request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := service.client.Do(request)
	if err != nil {
		return fmt.Errorf("Mattermost login request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Mattermost login returned HTTP %d", response.StatusCode)
	}
	service.token = response.Header.Get("Token")
	if service.token == "" {
		return errors.New("Mattermost login response has no session token")
	}
	return nil
}

func (service *recoveryService) get(ctx context.Context, path string, output any) error {
	for attempt := 0; attempt < 2; attempt++ {
		if service.token == "" {
			if err := service.loginSession(ctx); err != nil {
				return err
			}
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, service.baseURL+path, nil)
		if err != nil {
			return fmt.Errorf("create Mattermost API request: %w", err)
		}
		request.Header.Set("Authorization", "Bearer "+service.token)
		response, err := service.client.Do(request)
		if err != nil {
			return fmt.Errorf("Mattermost API request failed: %w", err)
		}
		if response.StatusCode == http.StatusUnauthorized && attempt == 0 {
			response.Body.Close()
			service.token = ""
			continue
		}
		if response.StatusCode != http.StatusOK {
			response.Body.Close()
			return fmt.Errorf("Mattermost API returned HTTP %d", response.StatusCode)
		}
		err = json.NewDecoder(io.LimitReader(response.Body, 320<<20)).Decode(output)
		response.Body.Close()
		if err != nil {
			return fmt.Errorf("decode Mattermost API response: %w", err)
		}
		return nil
	}
	return errors.New("Mattermost API authentication failed")
}

func (service *recoveryService) sync(ctx context.Context, now time.Time) error {
	_, err := service.db.ExecContext(ctx, `
		INSERT INTO mattermost_sync_recovery (channel_id, start_ms, watermark_ms, last_audit_ms)
		VALUES ($1, $2, $2, 0) ON CONFLICT (channel_id) DO NOTHING
	`, service.channelID, service.startMS)
	if err != nil {
		return fmt.Errorf("initialize recovery state: %w", err)
	}
	var startMS, watermarkMS, lastAuditMS int64
	err = service.db.QueryRowContext(ctx, `
		SELECT start_ms, watermark_ms, last_audit_ms FROM mattermost_sync_recovery WHERE channel_id = $1
	`, service.channelID).Scan(&startMS, &watermarkMS, &lastAuditMS)
	if err != nil {
		return fmt.Errorf("load recovery state: %w", err)
	}
	var channel struct {
		ID     string `json:"id"`
		TeamID string `json:"team_id"`
		Name   string `json:"name"`
		Type   string `json:"type"`
	}
	if err := service.get(ctx, "/api/v4/channels/"+url.PathEscape(service.channelID), &channel); err != nil {
		return fmt.Errorf("load recovery channel: %w", err)
	}
	if channel.ID != service.channelID || channel.Name != "town-square" || channel.Type != "O" || channel.TeamID == "" {
		return errors.New("recovery channel is not the configured public town-square")
	}

	fullAudit := lastAuditMS == 0 || now.UnixMilli()-lastAuditMS >= recoveryAudit.Milliseconds()
	cutoff := startMS
	if !fullAudit && watermarkMS-recoveryOverlap.Milliseconds() > cutoff {
		cutoff = watermarkMS - recoveryOverlap.Milliseconds()
	}
	users := make(map[string]string)
	newWatermark := watermarkMS
	var previousPage string
	for page := 0; ; page++ {
		values := url.Values{
			"page":             {strconv.Itoa(page)},
			"per_page":         {strconv.Itoa(recoveryPageSize)},
			"collapsedThreads": {"false"},
			"skipFetchThreads": {"true"},
		}
		var list recoveryPostList
		path := "/api/v4/channels/" + url.PathEscape(service.channelID) + "/posts?" + values.Encode()
		if err := service.get(ctx, path, &list); err != nil {
			return fmt.Errorf("load recovery page %d: %w", page, err)
		}
		if list.Order == nil || list.Posts == nil {
			return errors.New("Mattermost returned an invalid post list")
		}
		pageIDs, err := json.Marshal(list.Order)
		if err != nil {
			return fmt.Errorf("encode recovery page IDs: %w", err)
		}
		if page > 0 && len(list.Order) > 0 && string(pageIDs) == previousPage {
			return errors.New("Mattermost returned the same recovery page repeatedly")
		}
		previousPage = string(pageIDs)
		older := false
		for _, id := range list.Order {
			post, ok := list.Posts[id]
			if !ok || post.ID != id || post.ChannelID != service.channelID || post.CreateAt <= 0 {
				return errors.New("Mattermost returned an invalid channel post")
			}
			if post.CreateAt < cutoff {
				older = true
				continue
			}
			if post.CreateAt > newWatermark {
				newWatermark = post.CreateAt
			}
			if strings.HasPrefix(post.Type, "system_") {
				continue
			}
			if post.UserID == "" || post.ID == "" || len(post.Message) > 1<<20 ||
				!utf8.ValidString(post.Message) || strings.ContainsRune(post.Message, '\x00') {
				return errors.New("Mattermost returned an invalid post for recovery")
			}
			username, found := users[post.UserID]
			if !found {
				var user struct {
					ID       string `json:"id"`
					Username string `json:"username"`
				}
				if err := service.get(ctx, "/api/v4/users/"+url.PathEscape(post.UserID), &user); err != nil {
					return fmt.Errorf("load recovery post author: %w", err)
				}
				if user.ID != post.UserID || user.Username == "" || len(user.Username) > 128 ||
					!utf8.ValidString(user.Username) || strings.ContainsRune(user.Username, '\x00') {
					return errors.New("Mattermost returned an invalid post author")
				}
				username = user.Username
				users[post.UserID] = username
			}
			err := api.StoreMattermostInboundPost(ctx, service.db, api.MattermostInboundPost{
				PostID: post.ID, ChannelID: channel.ID, ChannelName: channel.Name, TeamID: channel.TeamID,
				UserName: username, Message: post.Message, PostedAt: time.UnixMilli(post.CreateAt).UTC(),
			})
			if err != nil {
				return fmt.Errorf("store recovered post: %w", err)
			}
		}
		if older || len(list.Order) < recoveryPageSize {
			break
		}
	}
	if fullAudit {
		lastAuditMS = now.UnixMilli()
	}
	_, err = service.db.ExecContext(ctx, `
		UPDATE mattermost_sync_recovery SET watermark_ms = $2, last_audit_ms = $3 WHERE channel_id = $1
	`, service.channelID, newWatermark, lastAuditMS)
	if err != nil {
		return fmt.Errorf("save recovery state: %w", err)
	}
	return nil
}

func (service *recoveryService) run(ctx context.Context) {
	for {
		if err := service.sync(ctx, time.Now()); err != nil {
			log.Printf("Mattermost recovery failed: %v", err)
		} else {
			service.lastSuccess.Store(time.Now().UnixMilli())
		}
		timer := time.NewTimer(recoveryInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
