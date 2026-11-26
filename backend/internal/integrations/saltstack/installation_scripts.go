package saltstack

import (
	"context"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"
)

func (client *Client) ApplyInstallationScript(ctx context.Context, target, language, body string) (string, string) {
	if !ValidExactMinion(target) || !utf8.ValidString(body) || strings.TrimSpace(body) == "" || strings.ContainsRune(body, 0) || utf8.RuneCountInString(body) > 48000 {
		return "failed", "invalid_script"
	}
	function := "state.template_str"
	var kwargs map[string]any
	switch language {
	case "sh":
		function = "cmd.run_all"
		kwargs = map[string]any{"shell": "/bin/sh", "python_shell": true, "timeout": 600}
	case "sls":
	default:
		return "failed", "invalid_script"
	}
	raw, err := client.exactManagementCall(ctx, target, function, []string{body}, kwargs, 605*time.Second)
	if err != nil {
		return "unknown", "response_unavailable"
	}
	if managementExplicitFailure(raw) {
		return "failed", "provider_failed"
	}
	if language == "sh" {
		var result struct {
			Retcode *int `json:"retcode"`
		}
		if json.Unmarshal(raw, &result) != nil || result.Retcode == nil {
			return "unknown", "unrecognized_response"
		}
		if *result.Retcode != 0 {
			return "failed", "script_exited_nonzero"
		}
		return "succeeded", "script_exited_zero"
	}
	var results map[string]struct {
		Result *bool `json:"result"`
	}
	if json.Unmarshal(raw, &results) != nil || len(results) == 0 {
		return "unknown", "unrecognized_response"
	}
	failed := false
	for _, result := range results {
		if result.Result == nil {
			return "unknown", "unrecognized_response"
		}
		failed = failed || !*result.Result
	}
	if failed {
		return "failed", "state_failed"
	}
	return "succeeded", "state_completed"
}
