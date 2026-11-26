CREATE TABLE IF NOT EXISTS patch_automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sls', 'sh')),
  content TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_id, name)
);

CREATE INDEX IF NOT EXISTS idx_patch_automations_entity ON patch_automations (entity_id, updated_at DESC);