-- No backfill: current master data cannot establish historical company identity.
ALTER TABLE gatepasses ADD COLUMN IF NOT EXISTS record_snapshot JSONB;
COMMENT ON COLUMN gatepasses.record_snapshot IS 'Server-resolved authorized entity/asset/branch/recipient snapshot at creation; NULL for legacy unverified documents';