CREATE TABLE software_ticket_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES requests(id),
    ticket_number TEXT NOT NULL,
    asset_id UUID NOT NULL REFERENCES assets(id),
    entity_id UUID NOT NULL REFERENCES entities(id),
    application_id UUID NOT NULL REFERENCES application_catalog(id),
    package_name TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('install', 'remove')),
    approved_by UUID NOT NULL REFERENCES users(id),
    approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    consumed_request_id UUID,
    consumed_at TIMESTAMPTZ,
    UNIQUE (ticket_id, asset_id, application_id, action),
    UNIQUE (action, consumed_request_id),
    CHECK ((consumed_request_id IS NULL) = (consumed_at IS NULL))
);
CREATE UNIQUE INDEX software_ticket_approval_pending
    ON software_ticket_approvals (asset_id, application_id, action)
    WHERE consumed_request_id IS NULL;