-- F11: one row per QQ message that asked for a feature/behaviour change.
-- Repeatable: CREATE ... IF NOT EXISTS only.
CREATE TABLE IF NOT EXISTS feature_request(
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  msg_id TEXT NOT NULL UNIQUE,
  sender TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  quote TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'build',
  risk_tags TEXT NOT NULL DEFAULT '[]',
  auto INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  status_reason TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  day TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  lease_until INTEGER,
  release TEXT,
  rollback_point TEXT,
  smoke_verified INTEGER NOT NULL DEFAULT 0,
  proposal_note TEXT,
  reply_kind TEXT,
  reply_text TEXT,
  reply_outbox_id TEXT,
  reply_enqueued_at INTEGER,
  approved_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS feature_request_status ON feature_request(status, created_at);
CREATE INDEX IF NOT EXISTS feature_request_day_sender ON feature_request(day, sender);
CREATE INDEX IF NOT EXISTS feature_request_day ON feature_request(day);
