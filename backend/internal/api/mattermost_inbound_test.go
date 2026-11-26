package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"itms/backend/internal/app"
	"itms/backend/internal/platform/authn"
)

const (
	testMattermostWebhookToken = "mattermost-webhook-token-with-more-than-26"
	testMattermostChannelID    = "town-square-channel-id"
)

func TestMattermostWebhookStoresPostsAndTreatsRetriesAsDuplicates(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	config := mattermostInboundTestConfig()
	router := NewRouter(db, config, nil)
	postedAt := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	for attempt := 0; attempt < 2; attempt++ {
		mock.ExpectExec(`INSERT INTO mattermost_inbound_posts`).
			WithArgs("post-123", testMattermostChannelID, "town-square", "team-123", "egan", "Hello from Mattermost", postedAt).
			WillReturnResult(sqlmock.NewResult(0, int64(1-attempt)))
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, mattermostWebhookRequest(testMattermostWebhookToken, testMattermostChannelID, "post-123", postedAt.Unix()))
		if recorder.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusNoContent, recorder.Body.String())
		}
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("database expectations: %v", err)
	}
}

func TestMattermostWebhookAcceptsLargeURLEncodedUnicodePosts(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	router := NewRouter(db, mattermostInboundTestConfig(), nil)
	postedAt := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	for _, message := range []string{
		strings.Repeat("\u0d05", 4000),
		strings.Repeat("\U0001f600", 262144),
	} {
		form := url.Values{
			"token":        {testMattermostWebhookToken},
			"channel_id":   {testMattermostChannelID},
			"channel_name": {"town-square"},
			"team_id":      {"team-123"},
			"post_id":      {"post-123"},
			"user_name":    {"egan"},
			"text":         {message},
			"timestamp":    {strconv.FormatInt(postedAt.Unix(), 10)},
		}
		mock.ExpectExec(`INSERT INTO mattermost_inbound_posts`).
			WithArgs("post-123", testMattermostChannelID, "town-square", "team-123", "egan", message, postedAt).
			WillReturnResult(sqlmock.NewResult(0, 1))
		request := httptest.NewRequest(http.MethodPost, "/api/integrations/mattermost/webhook", strings.NewReader(form.Encode()))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusNoContent {
			t.Fatalf("message bytes = %d, status = %d, want %d; body: %s", len(message), recorder.Code, http.StatusNoContent, recorder.Body.String())
		}
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("database expectations: %v", err)
	}
}

func TestMattermostWebhookRejectsOversizedRequests(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	router := NewRouter(db, mattermostInboundTestConfig(), nil)
	for _, testCase := range []struct {
		name       string
		body       string
		wantStatus int
	}{
		{name: "message exceeds limit", body: url.Values{
			"token":        {testMattermostWebhookToken},
			"channel_id":   {testMattermostChannelID},
			"channel_name": {"town-square"},
			"team_id":      {"team-123"},
			"post_id":      {"post-123"},
			"user_name":    {"egan"},
			"timestamp":    {strconv.FormatInt(time.Now().Unix(), 10)},
			"text":         {strings.Repeat("x", (1<<20)+1)},
		}.Encode(), wantStatus: http.StatusBadRequest},
		{name: "body exceeds limit", body: strings.Repeat("x", (3<<20)+(64<<10)+1), wantStatus: http.StatusRequestEntityTooLarge},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/integrations/mattermost/webhook", strings.NewReader(testCase.body))
			request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, request)
			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status = %d, want %d; body: %s", recorder.Code, testCase.wantStatus, recorder.Body.String())
			}
		})
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unexpected database operation: %v", err)
	}
}

func TestMattermostWebhookRejectsInvalidTokenAndUnmappedChannel(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	router := NewRouter(db, mattermostInboundTestConfig(), nil)
	for _, testCase := range []struct {
		name       string
		token      string
		channelID  string
		wantStatus int
	}{
		{name: "invalid token", token: "wrong-token", channelID: testMattermostChannelID, wantStatus: http.StatusUnauthorized},
		{name: "unmapped channel", token: testMattermostWebhookToken, channelID: "other-channel", wantStatus: http.StatusForbidden},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, mattermostWebhookRequest(testCase.token, testCase.channelID, "post-123", 1_800_000_000))
			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status = %d, want %d; body: %s", recorder.Code, testCase.wantStatus, recorder.Body.String())
			}
		})
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unexpected database operation: %v", err)
	}
}

func TestMattermostMessagesRequireAuthenticationAndReturnRecentPosts(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	config := mattermostInboundTestConfig()
	router := NewRouter(db, config, nil)
	unauthenticated := httptest.NewRecorder()
	router.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, "/api/integrations/mattermost/messages", nil))
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want %d", unauthenticated.Code, http.StatusUnauthorized)
	}

	postedAt := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	mock.ExpectQuery(`SELECT post_id, channel_id, channel_name`).
		WithArgs(50).
		WillReturnRows(sqlmock.NewRows([]string{
			"post_id", "channel_id", "channel_name", "team_id", "user_name", "message", "posted_at",
		}).AddRow("post-123", testMattermostChannelID, "town-square", "team-123", "egan", "Hello from Mattermost", postedAt))
	manager := authn.NewManager(config.JWTSecret, config.JWTTTL)
	token := issueRouterTestToken(t, manager, "employee", "employee-1", "entity-1")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, newAuthorizedRequest(http.MethodGet, "/api/integrations/mattermost/messages", token, ""))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response struct {
		Items []MattermostInboundPost `json:"items"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if len(response.Items) != 1 || response.Items[0].UserName != "egan" || response.Items[0].Message != "Hello from Mattermost" {
		t.Fatalf("items = %+v, want the mirrored Mattermost post", response.Items)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("database expectations: %v", err)
	}
}

func mattermostInboundTestConfig() app.Config {
	return app.Config{
		FrontendOrigin:             "http://localhost:5173",
		JWTSecret:                  "test-secret-with-sufficient-length-123",
		JWTTTL:                     time.Hour,
		MattermostInboundEnabled:   true,
		MattermostWebhookToken:     testMattermostWebhookToken,
		MattermostInboundChannelID: testMattermostChannelID,
	}
}

func mattermostWebhookRequest(token, channelID, postID string, timestamp int64) *http.Request {
	form := url.Values{
		"token":        {token},
		"channel_id":   {channelID},
		"channel_name": {"town-square"},
		"team_id":      {"team-123"},
		"post_id":      {postID},
		"user_name":    {"egan"},
		"text":         {"Hello from Mattermost"},
		"timestamp":    {strconv.FormatInt(timestamp, 10)},
	}
	request := httptest.NewRequest(http.MethodPost, "/api/integrations/mattermost/webhook", strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return request
}
