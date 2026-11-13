CREATE TABLE IF NOT EXISTS schedules(
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('digest_daily','digest_weekly','reminder','mute')),
  tz TEXT NOT NULL DEFAULT 'Australia/Sydney',
  spec TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','cancelled')),
  next_run_at INTEGER,
  last_run_at INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  source_msg_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status,next_run_at);
CREATE INDEX IF NOT EXISTS schedules_group ON schedules(group_id,status);

CREATE TABLE IF NOT EXISTS schedule_runs(
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  outbox_id TEXT,
  error TEXT,
  UNIQUE(schedule_id,due_at)
);
CREATE INDEX IF NOT EXISTS schedule_runs_due ON schedule_runs(schedule_id,due_at);
