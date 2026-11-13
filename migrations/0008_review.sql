CREATE TABLE IF NOT EXISTS turn_tools(            -- D-7 写，review 读
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, group_id TEXT, name TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '{}',                 -- redact() 后 ≤200 字
  ok INTEGER NOT NULL, error_kind TEXT,            -- V-B ErrorKind 或 NULL
  ms INTEGER NOT NULL, offered INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS turn_tools_turn ON turn_tools(turn_id);
CREATE TABLE IF NOT EXISTS review_runs(            -- 每群每晚一行；管线状态机
  id TEXT PRIMARY KEY,                             -- '<group_id>:<YYYY-MM-DD 悉尼>'
  group_id TEXT NOT NULL, date TEXT NOT NULL,
  step TEXT NOT NULL DEFAULT 'snapshot',           -- snapshot|trace|judge|apply|publish|done|failed|skipped
  window_start TEXT NOT NULL, window_end TEXT NOT NULL,
  cursor_ts TEXT, cursor_id TEXT,                  -- 上次评到的 messages(ts,id)；绝不用 rowid
  mode TEXT NOT NULL DEFAULT 'shadow',             -- shadow|propose|full
  model TEXT, same_family INTEGER NOT NULL DEFAULT 0,
  neurons_est INTEGER NOT NULL DEFAULT 0, judge_calls INTEGER NOT NULL DEFAULT 0,
  stats TEXT NOT NULL DEFAULT '{}', error TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS review_snapshots(       -- 能力快照，每晚一份 + 每条 trace 引用最近 health_sample
  run_id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS review_traces(
  id TEXT PRIMARY KEY,                             -- 'tr-' || inbound message id
  run_id TEXT NOT NULL, group_id TEXT NOT NULL, inbound_id TEXT NOT NULL,
  signals TEXT NOT NULL DEFAULT '[]',              -- ["S1","S3",...]
  priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',           -- pending|judged|skipped|expired
  trace_json TEXT NOT NULL,                        -- ≤6000 字，见 Trace
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS review_traces_run ON review_traces(run_id, state, priority DESC);
CREATE TABLE IF NOT EXISTS review_findings(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, trace_id TEXT NOT NULL,
  failure_type TEXT NOT NULL, severity TEXT NOT NULL, fix_layer TEXT NOT NULL,
  gap_type TEXT, capability TEXT, should_use_tool TEXT,   -- 工具名|'none'|'n/a'
  dimensions TEXT NOT NULL, evidence_json TEXT NOT NULL,
  what_happened TEXT NOT NULL, expected TEXT NOT NULL, root_cause TEXT NOT NULL,
  next_attempt_plan TEXT NOT NULL, confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',             -- open|accepted|rejected|fixed|wontfix|regression
  fingerprint TEXT, reviewed_by TEXT, reviewed_at INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(trace_id, failure_type));
CREATE TABLE IF NOT EXISTS review_rejects(         -- 校验没过的评判输出，算精度、查模型用
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, reason TEXT NOT NULL, raw TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS capability_gaps(
  fingerprint TEXT PRIMARY KEY, gap_type TEXT NOT NULL, capability TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  evidence_json TEXT NOT NULL, proposed_action TEXT NOT NULL, owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',             -- open|proposed|fixed|wontfix|regression
  task_id TEXT, external_ref TEXT);                -- external_ref: 'F5' 等已有单
CREATE INDEX IF NOT EXISTS capability_gaps_cap ON capability_gaps(capability, status);
CREATE TABLE IF NOT EXISTS behavior_rules(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, rule TEXT NOT NULL, scene TEXT NOT NULL,
  evidence_json TEXT NOT NULL, source TEXT NOT NULL, -- 'member:<id>' | 'review:<finding id>'
  status TEXT NOT NULL DEFAULT 'candidate',        -- candidate|canary|active|frozen|retired
  canary_until INTEGER, expires_at INTEGER NOT NULL, supersedes_id TEXT,
  hits INTEGER NOT NULL DEFAULT 0, corrections INTEGER NOT NULL DEFAULT 0,
  rollback_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS promises(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, outbox_id TEXT NOT NULL, quote TEXT NOT NULL,
  what TEXT NOT NULL, due_at INTEGER, recurring TEXT,  -- 'daily 08:00' 等；无则 NULL
  status TEXT NOT NULL DEFAULT 'open',             -- open|kept|broken|cannot|expired
  check_note TEXT, created_at INTEGER NOT NULL, checked_at INTEGER);
CREATE TABLE IF NOT EXISTS review_probes(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,         -- golden|capability
  name TEXT NOT NULL, passed INTEGER NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL);
