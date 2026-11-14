-- D 版：记录类型 / 记录 / 审计 / 技能 / 待补全
CREATE TABLE IF NOT EXISTS record_types(
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ledger' CHECK(kind IN ('ledger','list','log')),
  schema TEXT NOT NULL DEFAULT '{}',
  visibility_default TEXT NOT NULL DEFAULT 'group' CHECK(visibility_default IN ('group','private')),
  owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(group_id,name));
CREATE TABLE IF NOT EXISTS records(
  id TEXT PRIMARY KEY,
  type_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  creator TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'group' CHECK(visibility IN ('group','private')),
  data TEXT NOT NULL,
  person TEXT GENERATED ALWAYS AS (json_extract(data,'$.person')) STORED,
  title TEXT GENERATED ALWAYS AS (json_extract(data,'$.title')) STORED,
  amount_cents INTEGER GENERATED ALWAYS AS (json_extract(data,'$.amount_cents')) STORED,
  occurred_at INTEGER GENERATED ALWAYS AS (json_extract(data,'$.occurred_at')) STORED,
  status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
  dedup_key TEXT UNIQUE,
  source_msg_id TEXT,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS records_type ON records(type_id,deleted_at,occurred_at);
CREATE INDEX IF NOT EXISTS records_person ON records(type_id,person);
CREATE INDEX IF NOT EXISTS records_group ON records(group_id,created_at);
CREATE TABLE IF NOT EXISTS record_events(
  id TEXT PRIMARY KEY, record_id TEXT, type_id TEXT NOT NULL, group_id TEXT NOT NULL,
  actor TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('define','add','update','delete','restore','export')),
  before TEXT, after TEXT, source_msg_id TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS record_events_rec ON record_events(record_id,created_at);
CREATE INDEX IF NOT EXISTS record_events_group ON record_events(group_id,created_at);
CREATE TABLE IF NOT EXISTS skills(
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL, name TEXT NOT NULL,
  triggers TEXT NOT NULL DEFAULT '[]',
  steps TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('proposed','active','disabled')),
  uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER,
  source_msg_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(group_id,name));
CREATE TABLE IF NOT EXISTS pending_actions(
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL, sender TEXT NOT NULL,
  tool TEXT NOT NULL,
  draft TEXT NOT NULL,
  missing TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','expired')),
  asked_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS pending_actions_open ON pending_actions(group_id,sender,status,expires_at);
