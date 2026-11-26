package api

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type vendorTestTransport func(*http.Request) (*http.Response, error)

func (transport vendorTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestVendorVersions(t *testing.T) {
	for _, testcase := range []struct {
		name, body, version string
		status              int
	}{
		{"chrome", `{"versions":[{"version":"154.0.8037.92"}]}`, "154.0.8037.92", 200},
		{"firefox", `{"LATEST_FIREFOX_VERSION":"157.0"}`, "157.0", 200},
		{"rustdesk", `{"tag_name":"v1.4.9","draft":false,"prerelease":false}`, "1.4.9", 200},
		{"rustdesk", `{"tag_name":"v1.5.0","prerelease":true}`, "", 200},
		{"rustdesk", `{"tag_name":"v1.5.0","draft":true}`, "", 200},
		{"rustdesk", `{"tag_name":"nightly"}`, "", 200},
		{"rustdesk", `{"tag_name":"v1.4.9"}`, "", 429},
		{"chrome", `{"versions":[]}`, "", 200},
		{"firefox", `not json`, "", 200},
	} {
		t.Run(testcase.name+testcase.body, func(t *testing.T) {
			url := vendorFeeds("linux")[testcase.name]
			client := &http.Client{Transport: vendorTestTransport(func(request *http.Request) (*http.Response, error) {
				if request.URL.String() != url || request.Header.Get("Authorization") != "" {
					t.Fatal("unexpected vendor request")
				}
				return &http.Response{StatusCode: testcase.status, Body: io.NopCloser(strings.NewReader(testcase.body)), Header: make(http.Header)}, nil
			})}
			result := fetchVendorVersion(context.Background(), client, url)
			if result.Version != testcase.version || result.SourceURL != url || result.CheckedAt.IsZero() {
				t.Fatalf("unexpected result: %+v", result)
			}
			if testcase.version == "" && result.Status != "unavailable" {
				t.Fatal("failure reported as available")
			}
		})
	}
}
