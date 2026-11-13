-- Exhausted file deliveries stay visible and are explained once.
CREATE TABLE IF NOT EXISTS delivery_retries(
  delivery_id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  needs_attention INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL);
