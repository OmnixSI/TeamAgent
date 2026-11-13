-- F8-0: shared OpenAI accounting and quota reservations.
CREATE TABLE IF NOT EXISTS openai_usage(
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  group_id TEXT,
  sender_id TEXT,
  status TEXT NOT NULL,
  error_kind TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  est_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS openai_usage_created ON openai_usage(created_at);
CREATE INDEX IF NOT EXISTS openai_usage_purpose ON openai_usage(purpose, created_at);
CREATE TABLE IF NOT EXISTS quota_reservations(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS quota_reservations_bucket ON quota_reservations(kind, key, created_at);
