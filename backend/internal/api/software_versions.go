package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"itms/backend/internal/platform/httpx"
)

type vendorVersion struct {
	Version   string    `json:"version"`
	SourceURL string    `json:"sourceUrl"`
	CheckedAt time.Time `json:"checkedAt"`
	Status    string    `json:"status"`
}

var stableVendorVersion = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+){1,3}$`)
var vendorCache = struct {
	sync.Mutex
	entries map[string]vendorVersion
}{entries: map[string]vendorVersion{}}

func vendorFeeds(os string) map[string]string {
	platform := map[string]string{"linux": "linux", "windows": "win64", "macos": "mac"}[os]
	return map[string]string{
		"chrome":     "https://versionhistory.googleapis.com/v1/chrome/platforms/" + platform + "/channels/stable/versions?pageSize=1",
		"firefox":    "https://product-details.mozilla.org/1.0/firefox_versions.json",
		"netbird":    "https://api.github.com/repos/netbirdio/netbird/releases/latest",
		"onlyoffice": "https://api.github.com/repos/ONLYOFFICE/DesktopEditors/releases/latest",
		"pritunl":    "https://api.github.com/repos/pritunl/pritunl-client-electron/releases/latest",
		"rustdesk":   "https://api.github.com/repos/rustdesk/rustdesk/releases/latest",
	}
}

func fetchVendorVersion(ctx context.Context, client *http.Client, url string) vendorVersion {
	result := vendorVersion{SourceURL: url, CheckedAt: time.Now().UTC(), Status: "unavailable"}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return result
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "ITMS-vendor-version-check")
	response, err := client.Do(request)
	if err != nil {
		return result
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return result
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 1048577))
	if err != nil || len(body) > 1048576 {
		return result
	}
	var release struct {
		Tag        string `json:"tag_name"`
		Prerelease bool   `json:"prerelease"`
		Draft      bool   `json:"draft"`
		Firefox    string `json:"LATEST_FIREFOX_VERSION"`
		Versions   []struct {
			Version string `json:"version"`
		} `json:"versions"`
	}
	if json.Unmarshal(body, &release) != nil || release.Prerelease || release.Draft {
		return result
	}
	version := strings.TrimPrefix(release.Tag, "v")
	if strings.Contains(url, "versionhistory.googleapis.com/") {
		if len(release.Versions) != 1 {
			return result
		}
		version = release.Versions[0].Version
	} else if strings.Contains(url, "product-details.mozilla.org/") {
		version = release.Firefox
	}
	if !stableVendorVersion.MatchString(version) {
		return result
	}
	result.Version, result.Status = version, "available"
	return result
}

func (server *apiServer) listVendorVersions(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	if !server.requireRoles(c, "super_admin", "admin", "it_team", "auditor") {
		return
	}
	os := c.Query("os")
	if os != "linux" && os != "macos" && os != "windows" {
		adminCatalogError(c, adminInputError("unsupported os"))
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()
	client := &http.Client{Timeout: 4 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return fmt.Errorf("vendor redirects are not permitted")
	}}
	items := map[string]vendorVersion{}
	for name, url := range vendorFeeds(os) {
		vendorCache.Lock()
		cached, exists := vendorCache.entries[url]
		vendorCache.Unlock()
		ttl := time.Hour
		if cached.Status != "available" {
			ttl = 5 * time.Minute
		}
		if exists && time.Since(cached.CheckedAt) < ttl {
			items[name] = cached
			continue
		}
		if ctx.Err() != nil {
			items[name] = vendorVersion{Status: "unavailable", SourceURL: url}
			continue
		}
		result := fetchVendorVersion(ctx, client, url)
		vendorCache.Lock()
		vendorCache.entries[url] = result
		vendorCache.Unlock()
		items[name] = result
	}
	httpx.JSON(c, http.StatusOK, gin.H{"items": items})
}
