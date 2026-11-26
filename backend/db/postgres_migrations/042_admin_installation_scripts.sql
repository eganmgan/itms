-- Storage only: deliberately NOT scripts/script_variants used by the Salt BFF.
-- Keep the existing library's type/platform vocabulary without sharing executable IDs.
CREATE TABLE IF NOT EXISTS admin_installation_scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id),
  name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
  type TEXT NOT NULL CHECK (type IN ('sh', 'sls')),
  os TEXT NOT NULL CHECK (os IN ('default', 'Ubuntu', 'Debian', 'Rocky Linux')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 48000),
  description VARCHAR(4000),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_installation_scripts_entity_idx
  ON admin_installation_scripts (entity_id, name, id);