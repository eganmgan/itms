ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS added_on DATE,
  ADD COLUMN IF NOT EXISTS scrapped_on DATE;

UPDATE assets
SET added_on = created_at::date
WHERE added_on IS NULL;
