-- F7-3: 群聊总结缓存。只缓存，不写 facts；同一 (group_id,last_rowid) 只保留一份。
CREATE TABLE IF NOT EXISTS summaries(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, from_ts TEXT NOT NULL, to_ts TEXT NOT NULL,
  last_rowid INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS summaries_group_last ON summaries(group_id,last_rowid);
CREATE INDEX IF NOT EXISTS summaries_group_time ON summaries(group_id,created_at);
