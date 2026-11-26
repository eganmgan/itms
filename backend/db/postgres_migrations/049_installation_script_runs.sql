CREATE TABLE installation_script_runs (
  request_id UUID PRIMARY KEY,
  asset_id UUID NOT NULL REFERENCES assets(id),
  entity_id UUID NOT NULL REFERENCES entities(id),
  actor_id UUID NOT NULL REFERENCES users(id),
  script_id UUID NOT NULL REFERENCES admin_installation_scripts(id),
  script_hash TEXT NOT NULL CHECK (script_hash ~ '^[0-9a-f]{64}$'),
  script_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('application', 'service')),
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'succeeded', 'failed')),
  outcome_code TEXT NOT NULL DEFAULT 'dispatch_unconfirmed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX installation_script_runs_asset_idx
  ON installation_script_runs(asset_id, entity_id, created_at DESC);