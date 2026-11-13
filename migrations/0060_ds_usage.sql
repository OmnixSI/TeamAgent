-- F9-DS: DeepSeek tools usage (ASR/TTS/OCR/Search/Fetch).
CREATE TABLE IF NOT EXISTS ds_usage(
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  group_id TEXT,
  sender_id TEXT,
  status TEXT NOT NULL,
  error_kind TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  units INTEGER NOT NULL DEFAULT 0,
  est_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ds_usage_created ON ds_usage(created_at);
CREATE INDEX IF NOT EXISTS ds_usage_purpose ON ds_usage(purpose, created_at);
CREATE INDEX IF NOT EXISTS ds_usage_group ON ds_usage(group_id, created_at);
