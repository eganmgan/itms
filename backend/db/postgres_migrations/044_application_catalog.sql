-- Canonical package allowlist; deliberately unrelated to stored scripts or Salt BFF IDs.
CREATE TABLE application_catalog (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entities(id),
    name VARCHAR(150) NOT NULL CHECK (btrim(name) <> ''),
    description VARCHAR(4000) NOT NULL DEFAULT '',
    os TEXT NOT NULL CHECK (os IN ('linux', 'windows', 'macos')),
    package_name VARCHAR(200) NOT NULL CHECK (package_name ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$'),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (entity_id, os, package_name)
);
CREATE INDEX application_catalog_entity_idx ON application_catalog(entity_id, name, id);

-- Immutable request identity and package snapshot. An unknown reservation is
-- committed BEFORE dispatch: a process crash must never enable an automatic retry.
CREATE TABLE software_install_requests (
    request_id UUID PRIMARY KEY,
    asset_id UUID NOT NULL REFERENCES assets(id),
    application_id UUID NOT NULL REFERENCES application_catalog(id),
    entity_id UUID NOT NULL REFERENCES entities(id),
    actor_id UUID NOT NULL REFERENCES users(id),
    application_name VARCHAR(150) NOT NULL,
    package_name VARCHAR(200) NOT NULL,
    os TEXT NOT NULL CHECK (os IN ('linux', 'windows', 'macos')),
    status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('succeeded', 'failed', 'unknown')),
    outcome_code TEXT NOT NULL DEFAULT 'dispatch_unconfirmed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX software_install_requests_asset_idx ON software_install_requests(asset_id, created_at DESC, request_id);