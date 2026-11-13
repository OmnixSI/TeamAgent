CREATE TABLE IF NOT EXISTS profiles(
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  source_ids TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(group_id, user_id)
);
CREATE INDEX IF NOT EXISTS profiles_group ON profiles(group_id, updated_at DESC);
