CREATE TABLE IF NOT EXISTS subagent_runs(
  id TEXT PRIMARY KEY, role TEXT NOT NULL, repo TEXT NOT NULL, ref TEXT NOT NULL, question TEXT NOT NULL,
  tainted INTEGER NOT NULL DEFAULT 0, requester TEXT NOT NULL, group_id TEXT NOT NULL, source_msg TEXT NOT NULL,
  status TEXT NOT NULL, lease TEXT, lease_until INTEGER, progress TEXT, result TEXT, error_kind TEXT,
  resolved_sha TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, deadline INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS subagent_runs_status ON subagent_runs(status, created_at);
CREATE INDEX IF NOT EXISTS subagent_runs_requester ON subagent_runs(requester, created_at);
