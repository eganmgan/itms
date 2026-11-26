CREATE TABLE IF NOT EXISTS mattermost_inbound_posts (
    post_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    team_id TEXT NOT NULL DEFAULT '',
    user_name TEXT NOT NULL,
    message TEXT NOT NULL,
    posted_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mattermost_inbound_posts_posted_at
    ON mattermost_inbound_posts (posted_at DESC, post_id DESC);
