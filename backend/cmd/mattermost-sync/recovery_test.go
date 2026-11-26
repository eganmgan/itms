package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestRecoveryWithPostgres(t *testing.T) {
	dsn := os.Getenv("SYNC_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("SYNC_TEST_DATABASE_URL is not set")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	start := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	posts := make([]recoveryPost, 0, 1200)
	for i := 0; i < 1100; i++ {
		posts = append(posts, recoveryPost{
			ID: fmt.Sprintf("post-%04d", i), ChannelID: "recovery-channel", UserID: "test-user",
			Message: "recovered message", CreateAt: start.Add(time.Minute).UnixMilli(),
		})
	}
	loginCount := 0
	expectedToken := ""
	failPage := -1
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/v4/users/login" {
			loginCount++
			expectedToken = fmt.Sprintf("session-%d", loginCount)
			w.Header().Set("Token", expectedToken)
			_, _ = w.Write([]byte(`{}`))
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+expectedToken || expectedToken == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch {
		case r.URL.Path == "/api/v4/channels/recovery-channel":
			_, _ = w.Write([]byte(`{"id":"recovery-channel","team_id":"test-team","name":"town-square","type":"O"}`))
		case r.URL.Path == "/api/v4/users/test-user":
			_, _ = w.Write([]byte(`{"id":"test-user","username":"test-user"}`))
		case r.URL.Path == "/api/v4/channels/recovery-channel/posts":
			page, err := strconv.Atoi(r.URL.Query().Get("page"))
			if err != nil || r.URL.Query().Get("collapsedThreads") != "false" || r.URL.Query().Get("skipFetchThreads") != "true" {
				t.Error("invalid page request")
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if page == failPage {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			list := recoveryPostList{Order: []string{}, Posts: make(map[string]recoveryPost)}
			from := page * recoveryPageSize
			for i := from; i < from+recoveryPageSize && i < len(posts); i++ {
				list.Order = append(list.Order, posts[i].ID)
				list.Posts[posts[i].ID] = posts[i]
			}
			_ = json.NewEncoder(w).Encode(list)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	service := &recoveryService{
		db: db, client: newAuthClient(), baseURL: server.URL, login: "test-user", password: "test-password",
		channelID: "recovery-channel", startMS: start.UnixMilli(),
	}
	ctx := context.Background()
	if err := service.sync(ctx, start.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM mattermost_inbound_posts WHERE channel_id = 'recovery-channel'`).Scan(&count); err != nil || count != 1100 {
		t.Fatalf("recovered count = %d, error = %v", count, err)
	}
	var watermark int64
	if err := db.QueryRow(`SELECT watermark_ms FROM mattermost_sync_recovery WHERE channel_id = 'recovery-channel'`).Scan(&watermark); err != nil {
		t.Fatal(err)
	}
	newPosts := make([]recoveryPost, 0, 80+len(posts))
	for i := 0; i < 80; i++ {
		newPosts = append(newPosts, recoveryPost{
			ID: fmt.Sprintf("new-%04d", i), ChannelID: "recovery-channel", UserID: "test-user",
			Message: "missed while offline", CreateAt: start.Add(5 * time.Minute).UnixMilli(),
		})
	}
	posts = append(newPosts, posts...)
	failPage = 1
	if err := service.sync(ctx, start.Add(6*time.Minute)); err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("expected page failure, got %v", err)
	}
	var afterFailure int64
	if err := db.QueryRow(`SELECT watermark_ms FROM mattermost_sync_recovery WHERE channel_id = 'recovery-channel'`).Scan(&afterFailure); err != nil || afterFailure != watermark {
		t.Fatalf("watermark changed on failure: %d, error = %v", afterFailure, err)
	}
	failPage = -1
	expectedToken = "expired"
	if err := service.sync(ctx, start.Add(7*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if loginCount != 2 {
		t.Fatalf("login count = %d, want 2 after session expiration", loginCount)
	}
	if err := db.QueryRow(`SELECT count(*) FROM mattermost_inbound_posts WHERE channel_id = 'recovery-channel'`).Scan(&count); err != nil || count != 1180 {
		t.Fatalf("recovered count after retry = %d, error = %v", count, err)
	}
	posts = append(posts, recoveryPost{
		ID: "late-post", ChannelID: "recovery-channel", UserID: "test-user",
		Message: "late-visible post", CreateAt: start.Add(time.Minute).UnixMilli(),
	})
	if err := service.sync(ctx, start.Add(8*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM mattermost_inbound_posts WHERE channel_id = 'recovery-channel'`).Scan(&count); err != nil || count != 1180 {
		t.Fatalf("unexpected incremental count = %d, error = %v", count, err)
	}
	if err := service.sync(ctx, start.Add(25*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM mattermost_inbound_posts WHERE channel_id = 'recovery-channel'`).Scan(&count); err != nil || count != 1181 {
		t.Fatalf("full audit count = %d, error = %v", count, err)
	}
}
