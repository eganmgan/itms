-- Additive, idempotent storage only. No executable service configuration is stored.
CREATE TABLE IF NOT EXISTS asset_service_inventory (
    asset_id UUID PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    services JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(services) = 'array' AND jsonb_array_length(services) <= 10000),
    section JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_success_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);