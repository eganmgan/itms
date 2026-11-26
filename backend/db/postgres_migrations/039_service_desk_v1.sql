ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_type VARCHAR(16) NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS pam_username VARCHAR(100),
  ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_type_check;
ALTER TABLE users ADD CONSTRAINT users_auth_type_check CHECK (auth_type IN ('local', 'pam'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pam_username ON users (lower(pam_username)) WHERE pam_username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_active_role_department ON users (is_active, role_id, dept_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_expires ON password_reset_tokens (user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS ticket_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_id, name)
);

ALTER TABLE requests ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES ticket_categories(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_requests_requester_created ON requests (requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_assignee_status ON requests (assignee_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_category_status ON requests (category_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_comments_request_created ON request_comments (request_id, created_at);

CREATE TABLE IF NOT EXISTS ticket_internal_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id),
  note TEXT NOT NULL CHECK (char_length(btrim(note)) BETWEEN 1 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ticket_internal_notes_ticket_created ON ticket_internal_notes (ticket_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ticket_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  comment_id UUID REFERENCES request_comments(id) ON DELETE CASCADE,
  uploaded_by UUID NOT NULL REFERENCES users(id),
  file_name VARCHAR(255) NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 8388608),
  checksum_sha256 CHAR(64) NOT NULL,
  content BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket_created ON ticket_attachments (ticket_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(60) NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT,
  target_type VARCHAR(50),
  target_id UUID,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC);

INSERT INTO roles (name, is_system) VALUES
  ('super_admin', TRUE),
  ('it_team', TRUE),
  ('employee', TRUE)
ON CONFLICT (name) DO UPDATE SET is_system = TRUE;

WITH target_entity AS (
  SELECT id FROM entities WHERE short_code = 'ZBL' LIMIT 1
), defaults(name, short_code, description) AS (
  VALUES
    ('IT Team', 'ITTEAM', 'Internal information technology operations'),
    ('Support', 'SUPPORT', 'Employee and customer support'),
    ('Accounts', 'ACCOUNTS', 'Accounting and reconciliation'),
    ('Sales', 'SALES', 'Sales operations'),
    ('Quality', 'QUALITY', 'Quality assurance and process review'),
    ('Human Resources (HR)', 'HRESOURCE', 'Human resources and people operations'),
    ('Mutual Funds', 'MFUNDS', 'Mutual fund operations'),
    ('BOCO', 'BOCO', 'Business operations coordination'),
    ('Z-Team', 'ZTEAM', 'Z-Team operations'),
    ('ACOP', 'ACOP', 'ACOP operations'),
    ('Process', 'PROCESS', 'Process management'),
    ('Administration', 'ADMINISTRATION', 'Administrative operations')
)
INSERT INTO departments (entity_id, name, short_code, description)
SELECT target_entity.id, defaults.name, defaults.short_code, defaults.description
FROM target_entity CROSS JOIN defaults
ON CONFLICT (entity_id, name) DO UPDATE SET
  short_code = EXCLUDED.short_code,
  description = EXCLUDED.description,
  updated_at = NOW();

WITH target_entity AS (
  SELECT id FROM entities WHERE short_code = 'ZBL' LIMIT 1
), defaults(name, description) AS (
  VALUES
    ('Hardware', 'Hardware failure, replacement, and peripheral requests'),
    ('Software', 'Software installation, licensing, and application support'),
    ('Access', 'Account, permission, VPN, and shared resource access'),
    ('Network', 'Connectivity, Wi-Fi, DNS, and network access'),
    ('Security', 'Security incident, malware, phishing, and compliance support'),
    ('General Support', 'General service desk requests')
)
INSERT INTO ticket_categories (entity_id, name, description)
SELECT target_entity.id, defaults.name, defaults.description
FROM target_entity CROSS JOIN defaults
ON CONFLICT (entity_id, name) DO UPDATE SET
  description = EXCLUDED.description,
  is_active = TRUE,
  updated_at = NOW();