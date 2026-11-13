-- F7-6 episodic memory 2.0. Safe to re-run.
CREATE TABLE IF NOT EXISTS episodes(
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  source_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS episodes_group_time ON episodes(group_id, created_at);
CREATE INDEX IF NOT EXISTS episodes_live ON episodes(group_id, superseded_by, expires_at);
