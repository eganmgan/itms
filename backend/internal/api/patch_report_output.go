package api

import (
	"encoding/json"
	"fmt"
	"strings"
)

const (
	patchReportBodyLimit = 4 << 20
	patchReportRowLimit  = 256 << 10
	patchReportMaxRows   = 500
)

func normalizePatchStatus(status string) string {
	switch status = strings.ToLower(strings.TrimSpace(status)); status {
	case "success", "completed", "up_to_date", "failed", "running", "queued", "pending", "skipped", "cancelled":
		return status
	case "error", "failure":
		return "failed"
	case "canceled":
		return "cancelled"
	default:
		return "unknown"
	}
}

// Reports are caller-submitted snapshots, not verified package inventories.
// Preserve supplied output (including empty strings and zero exit codes) and
// opaque agent results. Reject oversized rows rather than silently losing data.
func normalizePatchReport(input *patchRunReportInput) error {
	if len(input.Rows) > patchReportMaxRows {
		return fmt.Errorf("patch report exceeds %d rows", patchReportMaxRows)
	}
	input.SuccessCount, input.FailedCount = 0, 0
	for index := range input.Rows {
		row := &input.Rows[index]
		row.Status = normalizePatchStatus(row.Status)
		if len(row.Result) > 0 {
			var result any
			if err := json.Unmarshal(row.Result, &result); err != nil {
				return fmt.Errorf("patch report row %d has invalid result JSON", index+1)
			}
			row.Status = patchRunStatus(map[string]any{"status": row.Status, "result": result})
		}
		if (row.ExitCode != nil && *row.ExitCode != 0) || (row.Retcode != nil && *row.Retcode != 0) {
			row.Status = "failed"
		}
		switch row.Status {
		case "success", "completed", "up_to_date":
			input.SuccessCount++
		case "failed":
			input.FailedCount++
		}
		payload, err := json.Marshal(row)
		if err != nil || len(payload) > patchReportRowLimit {
			return fmt.Errorf("patch report row %d is invalid or exceeds %d bytes", index+1, patchReportRowLimit)
		}
	}
	return nil
}
