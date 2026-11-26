package saltstack

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

var packageIdentifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$`)
var exactMinionIdentifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$`)

func ValidPackageIdentifier(name string) bool { return packageIdentifier.MatchString(name) }
func ValidExactMinion(target string) bool     { return exactMinionIdentifier.MatchString(target) }

// packageCall never inherits configurable targeting or accepts arbitrary functions.
// Share the bounded, strict, no-retry transport with service/removal actions.
func (client *Client) packageCall(ctx context.Context, target, function, arg string) (json.RawMessage, error) {
	switch function {
	case "pkg.install", "pkg.version", "sys.list_functions":
		return client.managementCall(ctx, target, function, arg)
	default:
		return nil, fmt.Errorf("invalid package operation")
	}
}

// PackageProviderAvailable is a read-only check for macOS, where pkg is not
// guaranteed to have a configured provider (e.g. Homebrew or MacPorts).
func (client *Client) PackageProviderAvailable(ctx context.Context, target string) (bool, error) {
	raw, err := client.packageCall(ctx, target, "sys.list_functions", "pkg")
	if err != nil {
		return false, err
	}
	var names []string
	if json.Unmarshal(raw, &names) != nil || names == nil {
		return false, fmt.Errorf("package provider unavailable")
	}
	for _, name := range names {
		if name == "pkg.install" {
			return true, nil
		}
	}
	return false, nil
}

// InstallPackage dispatches one canonical package name as an argument vector,
// never a shell, SLS, script, URL, package source, version or provider override.
func (client *Client) InstallPackage(ctx context.Context, target, name string) (string, string) {
	if !ValidPackageIdentifier(name) || !ValidExactMinion(target) {
		return "failed", "invalid_package_target"
	}
	raw, err := client.packageCall(ctx, target, "pkg.install", name)
	if err != nil {
		return "unknown", "response_unavailable"
	}
	status, code := packageOutcome(raw, name)
	if code != "verification_required" {
		return status, code
	}
	// An empty change map is not evidence that the requested package exists.
	// Verify once with a read-only function; never retry pkg.install.
	raw, err = client.packageCall(ctx, target, "pkg.version", name)
	if err != nil {
		return "unknown", "verification_unavailable"
	}
	var version *string
	if json.Unmarshal(raw, &version) != nil || version == nil || managementExplicitFailure(raw) {
		return "unknown", "unrecognized_response"
	}
	if strings.TrimSpace(*version) == "" {
		return "unknown", "verification_mismatch"
	}
	return "succeeded", "already_present"
}

func packageOutcome(raw json.RawMessage, name string) (string, string) {
	if strings.TrimSpace(string(raw)) == "false" {
		return "failed", "provider_failed"
	}
	var message string
	if json.Unmarshal(raw, &message) == nil && strings.HasPrefix(message, "ERROR:") {
		return "failed", "provider_failed"
	}
	var changes map[string]json.RawMessage
	if json.Unmarshal(raw, &changes) != nil || changes == nil {
		return "unknown", "unrecognized_response"
	}
	// A caller must verify the requested package before accepting a no-op.
	if len(changes) == 0 {
		return "unknown", "verification_required"
	}
	for _, rawChange := range changes {
		var change map[string]json.RawMessage
		if json.Unmarshal(rawChange, &change) != nil || len(change) != 2 {
			return "unknown", "unrecognized_response"
		}
		var oldVersion, newVersion string
		if change["old"] == nil || change["new"] == nil || string(change["old"]) == "null" || string(change["new"]) == "null" ||
			json.Unmarshal(change["old"], &oldVersion) != nil || json.Unmarshal(change["new"], &newVersion) != nil || newVersion == "" {
			return "unknown", "unrecognized_response"
		}
	}
	if _, ok := changes[name]; !ok {
		return "unknown", "unrecognized_response"
	}
	return "succeeded", "package_changed"
}
