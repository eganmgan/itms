ALTER TABLE admin_installation_scripts
  ADD COLUMN category TEXT NOT NULL DEFAULT 'application'
  CHECK (category IN ('application', 'service'));