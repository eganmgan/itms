-- Existing zero counts are not evidence of a successful scan.
-- Package IDs and Windows bundle versions can exceed the old UI-sized limits.
ALTER TABLE asset_software_inventory ALTER COLUMN name TYPE TEXT;
ALTER TABLE asset_software_inventory ALTER COLUMN version TYPE TEXT;

CREATE TABLE IF NOT EXISTS asset_inventory_telemetry (
    asset_id UUID PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    sections JSONB NOT NULL DEFAULT '{}'::jsonb,
    pending_updates INTEGER,
    pending_update_details JSONB NOT NULL DEFAULT '[]'::jsonb,
    reboot_required BOOLEAN,
    fingerprint TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reserved collector source: one unresolved summary per device.
CREATE UNIQUE INDEX IF NOT EXISTS asset_patch_inventory_open_unique
    ON asset_alerts(asset_id, source)
    WHERE source = 'patch_inventory' AND is_resolved = FALSE;