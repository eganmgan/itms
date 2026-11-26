-- Literal admin is entity-scoped by the API; it is not an alias for super_admin.
INSERT INTO roles (name, is_system) VALUES ('admin', TRUE)
ON CONFLICT (name) DO NOTHING;

ALTER TABLE assets ADD COLUMN IF NOT EXISTS group_in_charge_id UUID;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'assets'::regclass AND contype = 'f'
      AND confrelid = 'departments'::regclass
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                         WHERE attrelid = 'assets'::regclass AND attname = 'group_in_charge_id')]
  ) THEN
    ALTER TABLE assets ADD CONSTRAINT assets_group_in_charge_id_fkey
      FOREIGN KEY (group_in_charge_id) REFERENCES departments(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Once claimed by manual management, enrollment must not replace management data.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS manually_managed BOOLEAN NOT NULL DEFAULT FALSE;