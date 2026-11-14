-- V-D-learning 0008/0080：复盘学习的「建议 → 确认 → 应用」三张表。
-- 只加表，不改旧表；全部 IF NOT EXISTS，可重复执行。F11 用 0070，本版用 0080。
CREATE TABLE IF NOT EXISTS review_learnings(
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subkind TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  plain TEXT NOT NULL,
  requester TEXT NOT NULL,
  source_msg_id TEXT NOT NULL, quote TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agreement TEXT NOT NULL DEFAULT 'single',
  status TEXT NOT NULL DEFAULT 'proposed',
  ask_count INTEGER NOT NULL DEFAULT 0,
  answered_by TEXT, answer_msg_id TEXT,
  applied_ref TEXT,
  note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS review_learnings_group ON review_learnings(group_id, status, updated_at);

CREATE TABLE IF NOT EXISTS review_reports(
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL, date TEXT NOT NULL,
  run_id TEXT NOT NULL, mode TEXT NOT NULL,
  body TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'ready',
  reason TEXT,
  created_at INTEGER NOT NULL, queued_at INTEGER,
  UNIQUE(group_id, date));

CREATE TABLE IF NOT EXISTS learning_acks(
  outbox_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL, answer_msg_id TEXT,
  refs TEXT NOT NULL DEFAULT '[]',
  undone_at INTEGER, created_at INTEGER NOT NULL);
