package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"itms/backend/internal/app"
	"itms/backend/internal/platform/authn"
)

func TestMattermostEmbedConfigIsAvailableToEmployeesWhenEnabled(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	config := app.Config{
		FrontendOrigin:         "http://localhost:5173",
		JWTSecret:              "test-secret-with-sufficient-length-123",
		JWTTTL:                 time.Hour,
		MattermostEmbedEnabled: true,
		MattermostBaseURL:      "http://localhost:8065/",
	}
	router := NewRouter(db, config, nil)
	manager := authn.NewManager(config.JWTSecret, config.JWTTTL)
	token := issueRouterTestToken(t, manager, "employee", "employee-1", "entity-1")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, newAuthorizedRequest(http.MethodGet, "/api/integrations/mattermost/embed-config", token, ""))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	var body struct {
		Configured bool   `json:"configured"`
		BaseURL    string `json:"baseUrl"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if !body.Configured || body.BaseURL != "http://localhost:8065" {
		t.Fatalf("embed config = %+v, want configured localhost URL", body)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("database expectations: %v", err)
	}
}

func TestMattermostEmbedConfigStaysDisabledByDefault(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	config := app.Config{
		FrontendOrigin: "http://localhost:5173",
		JWTSecret:      "test-secret-with-sufficient-length-123",
		JWTTTL:         time.Hour,
	}
	router := NewRouter(db, config, nil)
	manager := authn.NewManager(config.JWTSecret, config.JWTTTL)
	token := issueRouterTestToken(t, manager, "employee", "employee-1", "entity-1")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, newAuthorizedRequest(http.MethodGet, "/api/integrations/mattermost/embed-config", token, ""))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	var body struct {
		Configured bool `json:"configured"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if body.Configured {
		t.Fatal("configured = true, want false when embedding is disabled")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("database expectations: %v", err)
	}
}

func TestMattermostEmbedURLRejectsUnsafeValues(t *testing.T) {
	for _, value := range []string{"javascript:alert(1)", "https://user:pass@chat.example.com", "https://chat.example.com/?token=secret", "https://chat.example.com/#fragment"} {
		if _, err := mattermostEmbedURL(value); err == nil {
			t.Errorf("mattermostEmbedURL(%q) unexpectedly succeeded", value)
		}
	}
}
