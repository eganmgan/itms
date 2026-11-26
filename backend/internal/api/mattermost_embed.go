package api

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
	"itms/backend/internal/platform/httpx"
)

func mattermostEmbedURL(raw string) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if raw == "" {
		return "", nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("Mattermost workspace URL is invalid")
	}
	return raw, nil
}

func (server *apiServer) getMattermostEmbedConfig(c *gin.Context) {
	if !server.config.MattermostEmbedEnabled {
		httpx.JSON(c, http.StatusOK, gin.H{"configured": false})
		return
	}
	baseURL, err := mattermostEmbedURL(server.config.MattermostBaseURL)
	if err != nil {
		httpx.Error(c, http.StatusServiceUnavailable, err.Error())
		return
	}
	if baseURL == "" {
		httpx.JSON(c, http.StatusOK, gin.H{"configured": false})
		return
	}
	httpx.JSON(c, http.StatusOK, gin.H{"configured": true, "baseUrl": baseURL})
}
