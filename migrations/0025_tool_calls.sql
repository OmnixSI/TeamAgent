CREATE TABLE IF NOT EXISTS tool_calls(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL, turn_id TEXT NOT NULL, name TEXT NOT NULL,
  args_hash TEXT NOT NULL, status TEXT NOT NULL, error_kind TEXT,
  latency_ms INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tool_calls_group_turn ON tool_calls(group_id,turn_id,created_at);
