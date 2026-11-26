package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"itms/backend/internal/inventorysync"
)

type deviceTelemetry struct {
	CollectionStatus      map[string]inventorysync.SectionStatus `json:"collectionStatus"`
	PendingUpdates        *int                                   `json:"pendingUpdates"`
	PendingUpdateDetails  []string                               `json:"pendingUpdateDetails"`
	RebootRequired        *bool                                  `json:"rebootRequired"`
	Services              []inventorysync.ServiceRecord          `json:"services"`
	ServicesLastSuccessAt *time.Time                             `json:"servicesLastSuccessAt"`
	ServicesUpdatedAt     *time.Time                             `json:"servicesUpdatedAt"`
}

func (server *apiServer) fetchDeviceTelemetry(ctx context.Context, assetID string) (deviceTelemetry, error) {
	result := deviceTelemetry{CollectionStatus: map[string]inventorysync.SectionStatus{
		"updates":  {Status: "uncollected", Source: "legacy_or_uncollected"},
		"software": {Status: "uncollected", Source: "legacy_or_uncollected"},
		"services": {Status: "uncollected", Source: "legacy_or_uncollected"},
	}, PendingUpdateDetails: []string{}, Services: []inventorysync.ServiceRecord{}}
	var sections, pending, services, serviceSection []byte
	var pendingUpdates sql.NullInt64
	var rebootRequired sql.NullBool
	err := server.db.QueryRowContext(ctx, `SELECT COALESCE(t.sections, '{}'::jsonb), t.pending_updates,
		COALESCE(t.pending_update_details, '[]'::jsonb), t.reboot_required,
		COALESCE(s.services, '[]'::jsonb), s.section, s.last_success_at, s.updated_at
		FROM (SELECT * FROM asset_inventory_telemetry WHERE asset_id = $1::uuid) t
		FULL JOIN (SELECT * FROM asset_service_inventory WHERE asset_id = $1::uuid) s ON TRUE`, assetID).
		Scan(&sections, &pendingUpdates, &pending, &rebootRequired,
			&services, &serviceSection, &result.ServicesLastSuccessAt, &result.ServicesUpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	if pendingUpdates.Valid {
		value := int(pendingUpdates.Int64)
		result.PendingUpdates = &value
	}
	if rebootRequired.Valid {
		value := rebootRequired.Bool
		result.RebootRequired = &value
	}
	if len(sections) == 0 {
		sections = []byte(`{}`)
	}
	if len(pending) == 0 {
		pending = []byte(`[]`)
	}
	if len(services) == 0 {
		services = []byte(`[]`)
	}
	if err = json.Unmarshal(sections, &result.CollectionStatus); err != nil {
		return result, err
	}
	if err = json.Unmarshal(pending, &result.PendingUpdateDetails); err != nil {
		return result, err
	}
	if err = json.Unmarshal(services, &result.Services); err != nil {
		return result, err
	}
	if len(serviceSection) > 0 {
		var section inventorysync.SectionStatus
		if err = json.Unmarshal(serviceSection, &section); err != nil {
			return result, err
		}
		result.CollectionStatus["services"] = section
	}
	return result, nil
}
