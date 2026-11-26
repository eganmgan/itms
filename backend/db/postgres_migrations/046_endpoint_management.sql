-- Durable at-most-once management requests. Never delete/requeue an unknown
-- reservation to retry: dispatch may already have happened on the endpoint.
CREATE TABLE endpoint_management_requests (
    request_id UUID PRIMARY KEY,
    asset_id UUID NOT NULL REFERENCES assets(id),
    entity_id UUID NOT NULL REFERENCES entities(id),
    actor_id UUID NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('software', 'service')),
    action TEXT NOT NULL,
    application_id UUID REFERENCES application_catalog(id),
    service_name VARCHAR(255),
    package_name VARCHAR(200),
    os TEXT,
    salt_target VARCHAR(253) NOT NULL CHECK (salt_target ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$'),
    status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('succeeded', 'failed', 'unknown')),
    outcome_code TEXT NOT NULL DEFAULT 'dispatch_unconfirmed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (kind = 'software' AND action = 'remove' AND application_id IS NOT NULL
         AND service_name IS NULL AND package_name IS NOT NULL
         AND package_name ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$'
         AND os IS NOT NULL AND os IN ('linux', 'windows', 'macos'))
        OR
        (kind = 'service' AND action IN ('start', 'stop', 'restart', 'enable', 'disable')
         AND application_id IS NULL AND package_name IS NULL AND os IS NULL
         AND service_name IS NOT NULL AND service_name ~ '^[A-Za-z0-9][A-Za-z0-9_.@:+-]{0,254}$')
    )
);
CREATE INDEX endpoint_management_requests_asset_idx
    ON endpoint_management_requests(asset_id, entity_id, created_at DESC, request_id);