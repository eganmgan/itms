package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"itms/backend/internal/api"
)

func TestAuthenticate(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		name        string
		header      string
		authStatus  int
		wantStatus  int
		wantRequest bool
	}{
		{"missing token", "", 200, 401, false},
		{"valid token", "Bearer valid", 200, 200, true},
		{"invalid token", "Bearer invalid", 401, 401, true},
		{"forbidden", "Bearer forbidden", 403, 403, true},
		{"auth failure", "Bearer valid", 500, 503, true},
		{"redirect rejected", "Bearer valid", 302, 503, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			authServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				if r.Header.Get("Authorization") != tc.header {
					t.Errorf("authorization header not forwarded")
				}
				w.WriteHeader(tc.authStatus)
			}))
			defer authServer.Close()
			router := gin.New()
			router.GET("/messages", authenticate(authServer.URL, authServer.Client()), func(c *gin.Context) {
				c.Status(http.StatusOK)
			})
			request := httptest.NewRequest(http.MethodGet, "/messages", nil)
			request.Header.Set("Authorization", tc.header)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != tc.wantStatus || called != tc.wantRequest {
				t.Fatalf("status = %d, auth called = %v; want %d, %v", response.Code, called, tc.wantStatus, tc.wantRequest)
			}
		})
	}
}

func TestAuthenticateDoesNotFollowRedirect(t *testing.T) {
	targetCalled := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetCalled = true
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()
	authServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer authServer.Close()
	router := gin.New()
	router.GET("/messages", authenticate(authServer.URL, newAuthClient()), func(c *gin.Context) {
		c.Status(http.StatusOK)
	})
	request := httptest.NewRequest(http.MethodGet, "/messages", nil)
	request.Header.Set("Authorization", "Bearer valid")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || targetCalled {
		t.Fatalf("status = %d, redirect followed = %v", response.Code, targetCalled)
	}
}

func TestSyncWithPostgres(t *testing.T) {
	dsn := os.Getenv("SYNC_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("SYNC_TEST_DATABASE_URL is not set")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer valid" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer authServer.Close()
	router := gin.New()
	api.RegisterMattermostSyncRoutes(router, db, "test-webhook-token-at-least-26-characters", "test-channel", authenticate(authServer.URL, authServer.Client()))
	form := url.Values{
		"token":        {"test-webhook-token-at-least-26-characters"},
		"channel_id":   {"test-channel"},
		"channel_name": {"town-square"},
		"team_id":      {"test-team"},
		"post_id":      {"test-post"},
		"user_name":    {"test-user"},
		"text":         {"test message"},
		"timestamp":    {strconv.FormatInt(time.Now().Unix(), 10)},
	}
	for i := 0; i < 2; i++ {
		request := httptest.NewRequest(http.MethodPost, "/api/integrations/mattermost/webhook", strings.NewReader(form.Encode()))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("webhook status = %d: %s", response.Code, response.Body.String())
		}
	}
	for _, token := range []string{"invalid", "valid"} {
		request := httptest.NewRequest(http.MethodGet, "/api/integrations/mattermost/messages", nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if token == "invalid" {
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("invalid token status = %d", response.Code)
			}
			continue
		}
		var payload struct {
			Items []struct {
				PostID  string `json:"postId"`
				Message string `json:"message"`
			} `json:"items"`
		}
		if response.Code != http.StatusOK {
			t.Fatalf("feed status = %d: %s", response.Code, response.Body.String())
		}
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if len(payload.Items) != 1 || payload.Items[0].PostID != "test-post" || payload.Items[0].Message != "test message" {
			t.Fatalf("unexpected feed items: %+v", payload.Items)
		}
	}
}
