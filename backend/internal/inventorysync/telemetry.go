package inventorysync

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode"
)

// SectionStatus describes coverage, not every possible application on the device.
type SectionStatus struct {
	Status         string `json:"status"`
	Source         string `json:"source"`
	ScannedAt      string `json:"scanned_at"`
	Error          string `json:"error,omitempty"`
	Scope          string `json:"scope,omitempty"`
	Total          *int   `json:"total,omitempty"`
	Returned       *int   `json:"returned,omitempty"`
	Truncated      bool   `json:"truncated,omitempty"`
	TruncatedCount int    `json:"truncated_count,omitempty"`
}

const maxServiceRecords = 10000

// ServiceRecord deliberately excludes executable paths, arguments and accounts.
type ServiceRecord struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	State       string `json:"state"`
	StartMode   string `json:"start_mode"`
	Source      string `json:"source"`
}

func serviceText(value string, limit int) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, value)
	chars := []rune(strings.TrimSpace(value))
	if len(chars) > limit {
		chars = chars[:limit]
	}
	return string(chars)
}

// Normalize untrusted payloads before storage or hashing. Invalid/incomplete scans
// cannot acquire replacement authority, even if the sender reports success.
func normalizeServices(rows []ServiceRecord, section SectionStatus) ([]ServiceRecord, SectionStatus) {
	section.Source = serviceText(section.Source, 64)
	section.Scope = serviceText(section.Scope, 500)
	section.ScannedAt = serviceText(section.ScannedAt, 64)
	if section.Error != "" {
		section.Error = "service collection reported an error"
	}
	switch section.Status {
	case "success", "partial", "failed", "unsupported", "uncollected":
	default:
		section.Status, section.Error = "failed", "invalid service collection status"
	}
	if section.Status == "success" && rows == nil {
		section.Status, section.Error = "failed", "service array omitted"
	}
	total := len(rows)
	if section.Total != nil && *section.Total > total {
		total = *section.Total
	}
	incomplete := section.Truncated || section.TruncatedCount > 0 || len(rows) > maxServiceRecords ||
		section.Total != nil && *section.Total != len(rows) ||
		section.Returned != nil && *section.Returned != len(rows) || section.Error != ""
	unique := map[string]ServiceRecord{}
	if len(rows) > maxServiceRecords {
		rows = rows[:maxServiceRecords]
	}
	for _, row := range rows {
		clean := ServiceRecord{serviceText(row.Name, 256), serviceText(row.DisplayName, 256),
			serviceText(row.State, 64), serviceText(row.StartMode, 64), serviceText(row.Source, 64)}
		if clean != row {
			incomplete = true
		}
		if clean.Name == "" || clean.Source == "" {
			incomplete = true
			continue
		}
		key := clean.Source + "\x00" + clean.Name
		if _, exists := unique[key]; exists {
			incomplete = true
		}
		unique[key] = clean
	}
	keys := make([]string, 0, len(unique))
	for key := range unique {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]ServiceRecord, 0, len(keys))
	for _, key := range keys {
		result = append(result, unique[key])
	}
	returned := len(result)
	section.Total, section.Returned = &total, &returned
	if total-returned > section.TruncatedCount {
		section.TruncatedCount = total - returned
	}
	section.Truncated = section.Truncated || section.TruncatedCount > 0
	if section.Status == "success" && incomplete {
		section.Status = "partial"
	}
	return result, section
}

func mergeServiceObservations(previous, observations []ServiceRecord) ([]ServiceRecord, int) {
	// Prefer retaining existing keys when the storage cap is reached; never evict
	// unobserved services just because a partial scan did not see them.
	result := append([]ServiceRecord{}, previous...)
	indices := map[string]int{}
	for i, row := range result {
		indices[row.Source+"\x00"+row.Name] = i
	}
	dropped := 0
	for _, row := range observations {
		key := row.Source + "\x00" + row.Name
		if i, exists := indices[key]; exists {
			result[i] = row
		} else if len(result) < maxServiceRecords {
			indices[key] = len(result)
			result = append(result, row)
		} else {
			dropped++
		}
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Source+"\x00"+result[i].Name < result[j].Source+"\x00"+result[j].Name
	})
	return result, dropped
}

func (service *Service) reconcileServices(ctx context.Context, tx *sql.Tx, assetID string, asset *sourceAsset) error {
	section, reported := asset.CollectionStatus["services"]
	if !reported {
		return nil // Omitted/legacy payloads never touch the snapshot.
	}
	observations, section := normalizeServices(asset.Services, section)
	var raw []byte
	err := tx.QueryRowContext(ctx, `SELECT services FROM asset_service_inventory WHERE asset_id = $1::uuid FOR UPDATE`, assetID).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	rows := []ServiceRecord{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &rows); err != nil {
			return err
		}
	}
	complete := section.Status == "success" && !section.Truncated
	if complete {
		rows = observations
	} else if section.Status == "partial" {
		var dropped int
		rows, dropped = mergeServiceObservations(rows, observations)
		if dropped > 0 {
			section.Truncated = true
			section.TruncatedCount += dropped
			section.Error = "service snapshot capacity reached; prior observations retained"
		}
	}
	asset.Services, asset.CollectionStatus["services"] = observations, section
	encoded, _ := json.Marshal(rows)
	metadata, _ := json.Marshal(section)
	_, err = tx.ExecContext(ctx, `INSERT INTO asset_service_inventory (asset_id, services, section, last_success_at)
		VALUES ($1::uuid, $2::jsonb, $3::jsonb, CASE WHEN $4 THEN NOW() ELSE NULL END)
		ON CONFLICT (asset_id) DO UPDATE SET services = EXCLUDED.services, section = EXCLUDED.section,
		last_success_at = CASE WHEN $4 THEN NOW() ELSE asset_service_inventory.last_success_at END, updated_at = NOW()`,
		assetID, string(encoded), string(metadata), complete)
	return err
}

func softwareSnapshotReplaceable(asset sourceAsset) bool {
	section, exists := asset.CollectionStatus["software"]
	if exists {
		return section.Status == "success" && !section.Truncated && asset.InstalledSoftware != nil
	}
	// Legacy collectors may truncate; even nonempty is not a complete snapshot.
	return false
}

func updateSnapshotSuccessful(asset sourceAsset) bool {
	details := asset.ComputeDetails
	section := asset.CollectionStatus["updates"]
	return section.Status == "success" && !section.Truncated && details != nil &&
		details.PendingUpdates != nil && *details.PendingUpdates >= 0 &&
		details.PendingUpdateDetails != nil && *details.PendingUpdates == len(details.PendingUpdateDetails)
}

func telemetryFingerprint(asset sourceAsset) string {
	state := map[string]any{}
	for name, section := range asset.CollectionStatus {
		state[name] = section.Status
	}
	if section, exists := asset.CollectionStatus["services"]; exists {
		rows, normalized := normalizeServices(asset.Services, section)
		state["services"] = normalized.Status
		if normalized.Status == "success" || normalized.Status == "partial" {
			state["service_inventory"] = rows
			state["service_truncated"] = normalized.Truncated
			state["service_scope"] = normalized.Scope
		}
	}
	if d := asset.ComputeDetails; d != nil {
		state["hardware"] = []string{d.Processor, d.RAM, d.Storage, d.GPU, d.BIOSVersion, d.OSName, d.OSVersion, d.OSBuild, d.Kernel, d.Architecture, d.AnyDeskID, d.RustDeskID, d.Display, d.MACAddress, d.LastBoot}
		if updateSnapshotSuccessful(asset) {
			pending := append([]string{}, d.PendingUpdateDetails...)
			sort.Strings(pending)
			state["pending"] = pending
			state["reboot"] = d.RebootRequired
		}
	}
	if softwareSnapshotReplaceable(asset) || asset.CollectionStatus["software"].Status == "partial" ||
		asset.CollectionStatus["software"].Source == "legacy_or_uncollected" && len(asset.InstalledSoftware) > 0 {
		software := append([]softwareRecord{}, asset.InstalledSoftware...)
		sort.Slice(software, func(i, j int) bool {
			a, b := software[i], software[j]
			return a.Source+"\x00"+a.Name+"\x00"+a.Version < b.Source+"\x00"+b.Name+"\x00"+b.Version
		})
		state["software_inventory"] = software
	}
	if n := asset.Network; n != nil {
		state["network_config"] = []string{n.WiredIP, n.WirelessIP, n.NetbirdIP, n.DNS, n.Gateway}
	}
	raw, _ := json.Marshal(state)
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:])
}

func (service *Service) reconcileTelemetry(ctx context.Context, tx *sql.Tx, assetID string, asset sourceAsset) error {
	sectionsMap := map[string]SectionStatus{}
	for name, section := range asset.CollectionStatus {
		sectionsMap[name] = section
	}
	for _, name := range []string{"software", "updates"} {
		if _, exists := sectionsMap[name]; !exists {
			sectionsMap[name] = SectionStatus{Status: "uncollected", Source: "legacy_or_uncollected"}
		}
	}
	if sectionsMap["updates"].Status == "success" && !updateSnapshotSuccessful(asset) {
		section := sectionsMap["updates"]
		section.Status, section.Error = "failed", "inconsistent update count/details"
		sectionsMap["updates"] = section
	}
	asset.CollectionStatus = sectionsMap
	if err := service.reconcileServices(ctx, tx, assetID, &asset); err != nil {
		return err
	}
	var previous string
	err := tx.QueryRowContext(ctx, `SELECT fingerprint FROM asset_inventory_telemetry WHERE asset_id = $1::uuid FOR UPDATE`, assetID).Scan(&previous)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	sections, _ := json.Marshal(asset.CollectionStatus)
	var count *int
	var reboot *bool
	pending := []string{}
	if updateSnapshotSuccessful(asset) {
		count = asset.ComputeDetails.PendingUpdates
		reboot = asset.ComputeDetails.RebootRequired
		pending = asset.ComputeDetails.PendingUpdateDetails
	} else if asset.ComputeDetails != nil && asset.CollectionStatus["updates"].Status == "partial" {
		pending = asset.ComputeDetails.PendingUpdateDetails
		if pending == nil {
			pending = []string{}
		}
		if len(pending) > 5000 {
			pending = pending[:5000]
		}
		reboot = asset.ComputeDetails.RebootRequired
	}
	pendingRaw, _ := json.Marshal(pending)
	fingerprint := telemetryFingerprint(asset)
	_, err = tx.ExecContext(ctx, `INSERT INTO asset_inventory_telemetry
		(asset_id, sections, pending_updates, pending_update_details, reboot_required, fingerprint)
		VALUES ($1::uuid, $2::jsonb, $3, $4::jsonb, $5, $6)
		ON CONFLICT (asset_id) DO UPDATE SET sections = EXCLUDED.sections,
		pending_updates = EXCLUDED.pending_updates, pending_update_details = EXCLUDED.pending_update_details,
		reboot_required = EXCLUDED.reboot_required, fingerprint = EXCLUDED.fingerprint, updated_at = NOW()`,
		assetID, string(sections), count, string(pendingRaw), reboot, fingerprint)
	if err != nil {
		return err
	}
	if previous != fingerprint {
		// A digest detects changes without copying thousands of rows into history.
		summary := map[string]any{"software_status": asset.CollectionStatus["software"].Status,
			"update_status": asset.CollectionStatus["updates"].Status, "pending_updates": count,
			"software_returned": len(asset.InstalledSoftware), "fingerprint": fingerprint}
		if d := asset.ComputeDetails; d != nil {
			summary["system"] = map[string]string{"os": boundedSummary(d.OSName), "version": boundedSummary(d.OSVersion),
				"processor": boundedSummary(d.Processor), "ram": boundedSummary(d.RAM), "storage": boundedSummary(d.Storage)}
		}
		if section, reported := asset.CollectionStatus["services"]; reported {
			summary["services_status"] = section.Status
			summary["services_returned"] = len(asset.Services)
		}
		detail, _ := json.Marshal(summary)
		if _, err = tx.ExecContext(ctx, `INSERT INTO asset_history (asset_id, action, detail) VALUES ($1::uuid, 'inventory_changed', $2::jsonb)`, assetID, string(detail)); err != nil {
			return err
		}
	}
	if count == nil {
		return nil // Failed, partial, omitted and legacy scans never resolve alerts.
	}
	rebootPending := reboot != nil && *reboot
	if *count == 0 && !rebootPending {
		_, err = tx.ExecContext(ctx, `UPDATE asset_alerts SET is_resolved = TRUE, resolved_at = NOW(),
			mttr_seconds = GREATEST(0, EXTRACT(EPOCH FROM NOW() - created_at))::integer
			WHERE asset_id = $1::uuid AND source = 'patch_inventory' AND is_resolved = FALSE`, assetID)
	} else {
		detail := fmt.Sprintf("%d pending system updates. See device update telemetry for the recorded list and scan time.", *count)
		if rebootPending {
			detail += " A system restart is required."
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO asset_alerts (asset_id, source, severity, title, detail)
			VALUES ($1::uuid, 'patch_inventory', 'warning', 'Pending system updates', $2)
			ON CONFLICT (asset_id, source) WHERE source = 'patch_inventory' AND is_resolved = FALSE
			DO UPDATE SET detail = EXCLUDED.detail`, assetID, detail)
	}
	return err
}

// Partial scans can add observations but never infer removals. The asset upsert
// already holds the per-device row lock for this transaction.
func (service *Service) mergeSoftwareInventory(ctx context.Context, tx *sql.Tx, assetID string, software []softwareRecord) error {
	for _, app := range software {
		if app.Name == "" {
			continue
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO asset_software_inventory (asset_id, name, version, install_date, source)
			SELECT $1::uuid, $2, NULLIF($3, ''), NULLIF($4, '')::date, NULLIF($5, '')
			WHERE NOT EXISTS (SELECT 1 FROM asset_software_inventory WHERE asset_id = $1::uuid
			AND name = $2 AND COALESCE(version, '') = $3 AND COALESCE(source, '') = $5)`,
			assetID, app.Name, app.Version, app.InstallDate, app.Source)
		if err != nil {
			return err
		}
	}
	return nil
}

func boundedSummary(value string) string {
	chars := []rune(value)
	if len(chars) > 160 {
		return string(chars[:160])
	}
	return value
}
