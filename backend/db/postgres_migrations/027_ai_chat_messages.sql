CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant')),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_chat_messages_user_created_idx
  ON ai_chat_messages (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_chat_messages_entity_user_idx
  ON ai_chat_messages (entity_id, user_id, created_at DESC);