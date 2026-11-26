CREATE TABLE IF NOT EXISTS mattermost_sync_recovery (
    channel_id TEXT PRIMARY KEY,
    start_ms BIGINT NOT NULL,
    watermark_ms BIGINT NOT NULL,
    last_audit_ms BIGINT NOT NULL
);
