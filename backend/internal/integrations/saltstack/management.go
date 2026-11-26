package saltstack

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

var serviceIdentifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@:+-]{0,254}$`)

func ValidServiceName(name string) bool {
	if !serviceIdentifier.MatchString(name) {
		return false
	}
	// Some service.get_all providers also return non-service systemd units.
	// Reject these at every boundary, including direct calls, without requiring
	// a provider probe or excluding plain SysV/Windows names and .service units.
	if dot := strings.LastIndexByte(name, '.'); dot >= 0 {
		switch strings.ToLower(name[dot:]) {
		case ".target", ".mount", ".automount", ".device", ".socket", ".timer", ".path", ".swap", ".slice", ".scope":
			return false
		}
	}
	return true
}

// Conservative, case-insensitive protection also covers instance/alias/package
// variants. This is intentionally stricter than the remote provider's policy.
func ProtectedManagementName(name string) bool {
	name = strings.ToLower(name)
	for _, protected := range []string{"salt", "wazuh", "ossec", "ssh", "inventory", "itms", "glpi", "osquery", "systemd", "dbus", "docker", "containerd"} {
		if strings.Contains(name, protected) {
			return true
		}
	}
	return false
}

func ValidServiceAction(action string) bool {
	switch action {
	case "start", "stop", "restart", "enable", "disable":
		return true
	}
	return false
}

type ManagedService struct {
	Name    string `json:"name"`
	Running *bool  `json:"running"`
	Enabled *bool  `json:"enabled"`
}

// All endpoint operations go directly to /run with inline eauth/static token.
// No session login/retry, async acknowledgement, glob or configurable targeting.
// get_all must receive ZERO arguments, not an empty name.
func (client *Client) managementCall(ctx context.Context, target, function string, args ...string) (json.RawMessage, error) {
	if !client.Enabled() || !ValidExactMinion(target) {
		return nil, errors.New("management unavailable")
	}
	switch function {
	case "service.get_all":
		if len(args) != 0 {
			return nil, errors.New("invalid management operation")
		}
	case "service.start", "service.stop", "service.restart", "service.enable", "service.disable", "service.status", "service.enabled":
		if len(args) != 1 || !ValidServiceName(args[0]) {
			return nil, errors.New("invalid management operation")
		}
	case "pkg.install", "pkg.remove", "pkg.version":
		if len(args) != 1 || !ValidPackageIdentifier(args[0]) {
			return nil, errors.New("invalid management operation")
		}
	case "sys.list_functions":
		if len(args) != 1 || args[0] != "pkg" {
			return nil, errors.New("invalid management operation")
		}
	default:
		return nil, errors.New("invalid management operation")
	}
	if args == nil {
		args = []string{}
	}
	return client.exactManagementCall(ctx, target, function, args, nil, 25*time.Second)
}

func (client *Client) exactManagementCall(ctx context.Context, target, function string, args []string, kwargs map[string]any, timeout time.Duration) (json.RawMessage, error) {
	if !client.Enabled() || !ValidExactMinion(target) {
		return nil, errors.New("management unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	payload := client.withInlineEAuth(map[string]any{
		"client": "local", "tgt": []string{target}, "expr_form": "list", "tgt_type": "list",
		"fun": function, "arg": args, "timeout": int(timeout/time.Second) - 5,
	})
	if kwargs != nil {
		payload["kwarg"] = kwargs
	}
	// Direct transport prevents auth retries and allows a bounded, complete JSON
	// read. Reject duplicate keys/trailing data rather than taking the last value.
	contentType := "application/json"
	encoded, err := json.Marshal(payload)
	if client.usesInlineEAuth("/run", payload) {
		encoded = []byte(client.formEncodedBody(payload))
		contentType = "application/x-www-form-urlencoded"
	}
	if err != nil {
		return nil, errors.New("management response unavailable")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, client.baseURL+"/run", bytes.NewReader(encoded))
	if err != nil {
		return nil, errors.New("management response unavailable")
	}
	req.Header.Set("Content-Type", contentType)
	if client.token != "" {
		req.Header.Set("Authorization", "Bearer "+client.token)
	}
	transport := *client.httpClient
	transport.Timeout = timeout
	resp, err := transport.Do(req)
	if err != nil {
		return nil, errors.New("management response unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("management response unavailable")
	}
	const responseLimit = 2 * 1024 * 1024
	body, err := io.ReadAll(io.LimitReader(resp.Body, responseLimit+1))
	if err != nil || len(body) > responseLimit || !managementUniqueJSON(body) {
		return nil, errors.New("management response unavailable")
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(body, &envelope) != nil || len(envelope) != 1 || envelope["return"] == nil {
		return nil, errors.New("management response unavailable")
	}
	var result []map[string]json.RawMessage
	if json.Unmarshal(envelope["return"], &result) != nil || len(result) != 1 || len(result[0]) != 1 || result[0][target] == nil {
		return nil, errors.New("management response unavailable")
	}
	return result[0][target], nil
}

func managementUniqueJSON(body []byte) bool {
	d := json.NewDecoder(bytes.NewReader(body))
	var value func(int) bool
	value = func(depth int) bool {
		if depth > 16 {
			return false
		}
		token, err := d.Token()
		if err != nil {
			return false
		}
		delim, container := token.(json.Delim)
		if !container {
			return true
		}
		if delim != '{' && delim != '[' {
			return false
		}
		seen := map[string]bool{}
		for d.More() {
			if delim == '{' {
				key, err := d.Token()
				name, ok := key.(string)
				if err != nil || !ok || seen[name] {
					return false
				}
				seen[name] = true
			}
			if !value(depth + 1) {
				return false
			}
		}
		end, err := d.Token()
		return err == nil && ((delim == '{' && end == json.Delim('}')) || (delim == '[' && end == json.Delim(']')))
	}
	if !value(0) {
		return false
	}
	_, err := d.Token()
	return err == io.EOF
}

const managementServiceLimit = 4096

func (client *Client) managementServiceNames(ctx context.Context, target string) ([]string, bool, error) {
	raw, err := client.managementCall(ctx, target, "service.get_all")
	if err != nil {
		return nil, false, err
	}
	var names []*string
	if json.Unmarshal(raw, &names) != nil || names == nil {
		return nil, false, errors.New("service listing unavailable")
	}
	// Completeness describes discovery bounds, not whether every returned name
	// is supported by our deliberately narrow service-management policy.
	complete := len(names) <= managementServiceLimit
	if !complete {
		names = names[:managementServiceLimit]
	}
	items := make([]string, 0, len(names))
	seen := make(map[string]bool, len(names))
	for _, candidate := range names {
		if candidate == nil {
			return nil, false, errors.New("service listing unavailable")
		}
		name := *candidate
		if !ValidServiceName(name) {
			continue
		}
		if !seen[name] {
			items = append(items, name)
			seen[name] = true
		}
	}
	sort.Strings(items)
	return items, complete, nil
}

// Listing deliberately does not fan out into N remote calls or claim that an
// installed service is running/enabled. Null states are part of the API contract.
func (client *Client) ListManagedServices(ctx context.Context, target string) ([]ManagedService, string) {
	items := []ManagedService{}
	names, complete, err := client.managementServiceNames(ctx, target)
	if err != nil {
		return items, "unavailable"
	}
	for _, name := range names {
		items = append(items, ManagedService{Name: name})
	}
	if len(items) == 0 && complete {
		return items, "success"
	}
	return items, "partial"
}

func managementExplicitFailure(raw json.RawMessage) bool {
	if strings.TrimSpace(string(raw)) == "false" {
		return true
	}
	var message string
	return json.Unmarshal(raw, &message) == nil && strings.HasPrefix(message, "ERROR:")
}

// RemovePackage never retries a mutation. An empty change map alone is not proof
// of absence: only an exact empty pkg.version string can confirm that case.
func (client *Client) RemovePackage(ctx context.Context, target, name string) (string, string) {
	if !ValidExactMinion(target) || !ValidPackageIdentifier(name) {
		return "failed", "invalid_package_target"
	}
	if ProtectedManagementName(name) {
		return "failed", "protected_component"
	}
	raw, err := client.managementCall(ctx, target, "pkg.remove", name)
	if err != nil {
		return "unknown", "response_unavailable"
	}
	if managementExplicitFailure(raw) {
		return "failed", "provider_failed"
	}
	var changes map[string]json.RawMessage
	if json.Unmarshal(raw, &changes) != nil || changes == nil {
		return "unknown", "unrecognized_response"
	}
	if len(changes) != 0 {
		if changes[name] == nil {
			return "unknown", "unrecognized_response"
		}
		for _, value := range changes {
			var change map[string]json.RawMessage
			if json.Unmarshal(value, &change) != nil || len(change) != 2 {
				return "unknown", "unrecognized_response"
			}
			var old, next *string
			if json.Unmarshal(change["old"], &old) != nil || json.Unmarshal(change["new"], &next) != nil || old == nil || next == nil || *old == "" || *next != "" {
				return "unknown", "unrecognized_response"
			}
		}
		return "succeeded", "package_removed"
	}
	raw, err = client.managementCall(ctx, target, "pkg.version", name)
	if err != nil {
		return "unknown", "verification_unavailable"
	}
	var version *string
	if json.Unmarshal(raw, &version) != nil || version == nil {
		return "unknown", "unrecognized_response"
	}
	if *version != "" {
		return "unknown", "verification_mismatch"
	}
	return "succeeded", "package_absent"
}

// ManageService always reads the exact remote service list BEFORE dispatch.
// A true restart result acknowledges the provider operation, not a process
// observation. Other actions additionally verify the appropriate boolean read.
func (client *Client) ManageService(ctx context.Context, target, name, action string) (string, string) {
	if !ValidExactMinion(target) || !ValidServiceName(name) || !ValidServiceAction(action) {
		return "failed", "invalid_service_target"
	}
	if (action == "stop" || action == "disable") && ProtectedManagementName(name) {
		return "failed", "protected_component"
	}
	names, complete, err := client.managementServiceNames(ctx, target)
	if err != nil || !complete {
		return "unknown", "service_validation_unavailable"
	}
	found := false
	for _, candidate := range names {
		if candidate == name {
			found = true
			break
		}
	}
	if !found {
		return "failed", "service_not_found"
	}
	raw, err := client.managementCall(ctx, target, "service."+action, name)
	if err != nil {
		return "unknown", "response_unavailable"
	}
	if managementExplicitFailure(raw) {
		return "failed", "provider_failed"
	}
	if strings.TrimSpace(string(raw)) != "true" {
		return "unknown", "unrecognized_response"
	}
	if action == "restart" {
		return "succeeded", "restart_acknowledged"
	}
	function := "service.status"
	if action == "enable" || action == "disable" {
		function = "service.enabled"
	}
	raw, err = client.managementCall(ctx, target, function, name)
	if err != nil {
		return "unknown", "verification_unavailable"
	}
	var observed *bool
	if json.Unmarshal(raw, &observed) != nil || observed == nil {
		return "unknown", "unrecognized_response"
	}
	if *observed != (action == "start" || action == "enable") {
		return "unknown", "verification_mismatch"
	}
	return "succeeded", "service_state_verified"
}
