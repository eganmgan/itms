ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS technician_in_charge_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS group_in_charge_id UUID REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS update_sources TEXT;
ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS os_architecture VARCHAR(50);
ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS warranty_start_date DATE;
ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS warranty_duration_months INTEGER CHECK (warranty_duration_months IS NULL OR warranty_duration_months >= 0);

ALTER TABLE assets ADD COLUMN IF NOT EXISTS technician_in_charge_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS update_sources TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS warranty_start_date DATE;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS warranty_duration_months INTEGER CHECK (warranty_duration_months IS NULL OR warranty_duration_months >= 0);