package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	_ "github.com/lib/pq"
	"itms/backend/internal/api"
)

func authenticate(authURL string, client *http.Client) gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		if !strings.HasPrefix(header, "Bearer ") || strings.TrimSpace(strings.TrimPrefix(header, "Bearer ")) == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
			return
		}
		request, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, authURL, nil)
		if err != nil {
			log.Printf("cannot create authentication request: %v", err)
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "authentication unavailable"})
			return
		}
		request.Header.Set("Authorization", header)
		response, err := client.Do(request)
		if err != nil {
			log.Printf("authentication service request failed: %v", err)
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "authentication unavailable"})
			return
		}
		response.Body.Close()
		switch response.StatusCode {
		case http.StatusOK:
			c.Next()
		case http.StatusUnauthorized, http.StatusForbidden:
			c.AbortWithStatusJSON(response.StatusCode, gin.H{"error": "authentication failed"})
		default:
			log.Printf("authentication service returned HTTP %d", response.StatusCode)
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "authentication unavailable"})
		}
	}
}

func newAuthClient() *http.Client {
	return &http.Client{
		Timeout: 5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func logServerErrors(c *gin.Context) {
	c.Next()
	if c.Writer.Status() >= http.StatusInternalServerError {
		log.Printf("sync request failed: route=%s status=%d", c.FullPath(), c.Writer.Status())
	}
}

func run() error {
	databaseURL := strings.TrimSpace(os.Getenv("SYNC_DATABASE_URL"))
	token := strings.TrimSpace(os.Getenv("MATTERMOST_INBOUND_WEBHOOK_TOKEN"))
	channel := strings.TrimSpace(os.Getenv("MATTERMOST_INBOUND_CHANNEL_ID"))
	authURL := strings.TrimSpace(os.Getenv("ITMS_AUTH_URL"))
	recoveryURL := strings.TrimRight(strings.TrimSpace(os.Getenv("MATTERMOST_RECOVERY_URL")), "/")
	recoveryLogin := strings.TrimSpace(os.Getenv("MATTERMOST_RECOVERY_LOGIN"))
	recoveryPassword := os.Getenv("MATTERMOST_RECOVERY_PASSWORD")
	recoveryStart, startErr := time.Parse(time.RFC3339, strings.TrimSpace(os.Getenv("MATTERMOST_RECOVERY_START")))
	parsed, err := url.Parse(authURL)
	if err != nil || parsed == nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "/api/auth/me" {
		return errors.New("ITMS_AUTH_URL must be an HTTP(S) URL ending in /api/auth/me without credentials or query")
	}
	if databaseURL == "" || len(token) < 26 || channel == "" {
		return errors.New("SYNC_DATABASE_URL, MATTERMOST_INBOUND_CHANNEL_ID and a webhook token of at least 26 characters are required")
	}
	recoveryBase, err := url.Parse(recoveryURL)
	if err != nil || recoveryBase == nil || (recoveryBase.Scheme != "http" && recoveryBase.Scheme != "https") ||
		recoveryBase.Host == "" || recoveryBase.User != nil || recoveryBase.RawQuery != "" ||
		recoveryBase.Fragment != "" || recoveryBase.Path != "" || recoveryLogin == "" || recoveryPassword == "" ||
		startErr != nil || recoveryStart.Before(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)) || recoveryStart.After(time.Now()) {
		return errors.New("valid Mattermost recovery URL, login, password and past RFC3339 start time are required")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return fmt.Errorf("open sync database: %w", err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("connect to sync database: %w", err)
	}
	// Refuse to start if the dedicated database has not been initialized.
	var tableExists bool
	if err := db.QueryRowContext(ctx, `SELECT to_regclass('public.mattermost_inbound_posts') IS NOT NULL AND to_regclass('public.mattermost_sync_recovery') IS NOT NULL`).Scan(&tableExists); err != nil || !tableExists {
		return errors.New("sync database schema is unavailable; initialize the dedicated database before starting")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	recoveryClient := newAuthClient()
	recoveryClient.Transport = transport
	recoveryContext, stopRecovery := context.WithCancel(context.Background())
	defer stopRecovery()
	recovery := &recoveryService{
		db: db, client: recoveryClient, baseURL: recoveryURL, login: recoveryLogin,
		password: recoveryPassword, channelID: channel, startMS: recoveryStart.UnixMilli(),
	}
	go recovery.run(recoveryContext)
	router := gin.New()
	router.Use(gin.Recovery(), logServerErrors)
	router.GET("/healthz", func(c *gin.Context) {
		lastSuccess := recovery.lastSuccess.Load()
		if lastSuccess == 0 || time.Since(time.UnixMilli(lastSuccess)) > recoveryMaxStaleness {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Mattermost recovery is not current"})
			return
		}
		c.Status(http.StatusNoContent)
	})
	api.RegisterMattermostSyncRoutes(router, db, token, channel, authenticate(authURL, newAuthClient()))
	server := &http.Server{
		Addr:              ":3002",
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	return server.ListenAndServe()
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
