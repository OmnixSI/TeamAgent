CREATE TABLE IF NOT EXISTS turn_tools(            -- D-7 写，review 读；一次工具调用一行
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, group_id TEXT, name TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '{}',                 -- redact() 后 ≤200 字
  ok INTEGER NOT NULL, error_kind TEXT,            -- V-B ErrorKind 或 NULL
  ms INTEGER NOT NULL, offered INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL); -- offered 恒 1；提供清单见 turn_offers
CREATE INDEX IF NOT EXISTS turn_tools_turn ON turn_tools(turn_id);
CREATE TABLE IF NOT EXISTS turn_offers(           -- v2/P1-7：D-7 每轮写一行，记录当轮「提供了哪些工具 + 当时状态」
  turn_id TEXT PRIMARY KEY, group_id TEXT, inbound_id TEXT,
  names TEXT NOT NULL DEFAULT '[]',                -- 当轮提供给模型的工具名 JSON 数组；没给工具表则 '[]'
  catalog_version TEXT NOT NULL,                   -- src/review/catalog.ts 的 CATALOG_VERSION
  switches TEXT NOT NULL DEFAULT '{}',             -- 当时 off:* 值 {"off:repo_tools":"on"}
  runner_ok INTEGER, release TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS turn_offers_inbound ON turn_offers(inbound_id);
CREATE TABLE IF NOT EXISTS review_runs(            -- 每群每晚一行；管线状态机
  id TEXT PRIMARY KEY,                             -- '<group_id>:<YYYY-MM-DD 悉尼>'
  group_id TEXT NOT NULL, date TEXT NOT NULL,
  step TEXT NOT NULL DEFAULT 'snapshot',           -- snapshot|trace|judge|second|apply|publish|done|failed|skipped
  window_start TEXT NOT NULL, window_end TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'shadow',             -- shadow|propose|full
  model TEXT, second_model TEXT, same_family INTEGER NOT NULL DEFAULT 0,
  judge_calls INTEGER NOT NULL DEFAULT 0,
  spend_json TEXT NOT NULL DEFAULT '{}',           -- v2/P1-5：本晚各 provider 实际花费汇总（展示用，硬预算看 review_budget）
  lease_owner TEXT, lease_until INTEGER, gen INTEGER NOT NULL DEFAULT 0, -- v2/P1-4：tick 认领 + 执行代次
  stats TEXT NOT NULL DEFAULT '{}', error TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS review_cursors(         -- v2/P1-3/P1-4：跨晚游标；built=已建 trace，judged=已评完（只在全部评完/过期后推进）
  group_id TEXT NOT NULL, stream TEXT NOT NULL,    -- 'messages'(ts,id) | 'outbox'(created_at,id)；绝不用 rowid
  built_at TEXT, built_id TEXT, judged_at TEXT, judged_id TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY(group_id, stream));
CREATE TABLE IF NOT EXISTS review_snapshots(       -- 评判当晚的「现在」快照；只用于运维建议，不改写历史判定
  run_id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS review_traces(
  id TEXT PRIMARY KEY,                             -- v2/P1-3：'tr-in-<messages.id>' | 'tr-out-<outbox.id>'；跨晚重叠窗口靠它去重
  run_id TEXT NOT NULL,                            -- 首次建出它的 run
  group_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'inbound',            -- inbound|outbound
  inbound_id TEXT, outbound_id TEXT,               -- 二者至少一个非空
  signals TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  has_image INTEGER NOT NULL DEFAULT 0,            -- v2：trace 内有 message_images → 送看图复核
  state TEXT NOT NULL DEFAULT 'pending',           -- pending|judged|skipped|expired|judge_failed
  attempts INTEGER NOT NULL DEFAULT 0, judged_run_id TEXT,
  trace_json TEXT NOT NULL,                        -- ≤6000 字，见 Trace
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS review_traces_run ON review_traces(run_id, state, priority DESC);
CREATE INDEX IF NOT EXISTS review_traces_pending ON review_traces(group_id, state, created_at);
CREATE TABLE IF NOT EXISTS review_judgments(       -- v2/P1-4/P1-5/P1-6：每次模型调用先落这里，再由 apply 消费
  id TEXT PRIMARY KEY,                             -- '<run_id>:<role>:<batch_key>:<attempt>'
  run_id TEXT NOT NULL, gen INTEGER NOT NULL,
  role TEXT NOT NULL,                              -- primary|second
  provider TEXT NOT NULL, model TEXT NOT NULL,     -- deepseek|workers-ai|openai|codex-offline
  trace_ids TEXT NOT NULL,                         -- JSON 数组，batch_key=sha1(sorted ids) 前 12 位
  state TEXT NOT NULL DEFAULT 'reserved',          -- reserved|ok|truncated|invalid|error|timeout
  reserved INTEGER NOT NULL, used INTEGER,         -- 预算单位见 review_budget.unit
  max_tokens INTEGER NOT NULL, finish_reason TEXT,
  raw TEXT, usage_json TEXT, consumed_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS review_judgments_run ON review_judgments(run_id, role, state);
CREATE TABLE IF NOT EXISTS review_budget(          -- v2/P1-5：请求前预留的硬预算，按 provider × UTC 日
  day_utc TEXT NOT NULL, provider TEXT NOT NULL,
  unit TEXT NOT NULL,                              -- neurons|usd_micros
  cap INTEGER NOT NULL, reserved INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY(day_utc, provider));
CREATE TABLE IF NOT EXISTS review_findings(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, trace_id TEXT NOT NULL,
  failure_type TEXT NOT NULL, severity TEXT NOT NULL, fix_layer TEXT NOT NULL,
  gap_type TEXT, capability TEXT, should_use_tool TEXT,   -- 工具名|'none'|'n/a'
  dimensions TEXT NOT NULL, evidence_json TEXT NOT NULL,
  what_happened TEXT NOT NULL, expected TEXT NOT NULL, root_cause TEXT NOT NULL,
  next_attempt_plan TEXT NOT NULL, confidence REAL NOT NULL,
  agreement TEXT NOT NULL DEFAULT 'single',        -- v2：agree|disagree|single|pending（双判结果）
  second_json TEXT,                                -- 第二家判定摘要 {provider,model,failure_type,gap_type,severity,dimensions}
  status TEXT NOT NULL DEFAULT 'open',             -- open|disputed|accepted|rejected|fixed|wontfix|regression
  fingerprint TEXT, reviewed_by TEXT, reviewed_at INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(trace_id, failure_type));
CREATE TABLE IF NOT EXISTS review_rejects(         -- 校验没过的评判输出，算精度、查模型用
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, reason TEXT NOT NULL, raw TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS review_consumed(        -- v2/P1-4：副作用消费账本；所有计数 = COUNT(*)，重放不再累加
  kind TEXT NOT NULL,                              -- gap_occurrence|rule_correction|rule_hit|promise_check
  subject TEXT NOT NULL,                           -- fingerprint | rule id | promise id
  event TEXT NOT NULL,                             -- finding id | 证据 message id | 检查日期
  run_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(kind, subject, event));
CREATE TABLE IF NOT EXISTS capability_gaps(
  fingerprint TEXT PRIMARY KEY, gap_type TEXT NOT NULL, capability TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,          -- v2：= review_consumed 里 gap_occurrence 的条数，只能重算不能 +1
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  evidence_json TEXT NOT NULL, proposed_action TEXT NOT NULL, owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',             -- open|proposed|fixed|wontfix|regression
  task_id TEXT, external_ref TEXT);                -- task_id='rv-'||fingerprint；external_ref: 'F5' 等已有单
CREATE INDEX IF NOT EXISTS capability_gaps_cap ON capability_gaps(capability, status);
CREATE TABLE IF NOT EXISTS behavior_rules(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, rule TEXT NOT NULL, scene TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'free',               -- v2/P1-1：RULE_KINDS 之一；'free' 只能停在 candidate，管理员批准才进 canary
  params TEXT NOT NULL DEFAULT '{}',               -- 类型化规则参数；rule 文本由程序按模板渲染
  evidence_json TEXT NOT NULL, source TEXT NOT NULL, -- 'member:<id>' | 'review:<finding id>'
  status TEXT NOT NULL DEFAULT 'candidate',        -- candidate|canary|active|frozen|retired
  canary_until INTEGER, expires_at INTEGER NOT NULL, supersedes_id TEXT,
  hits INTEGER NOT NULL DEFAULT 0, corrections INTEGER NOT NULL DEFAULT 0, -- v2：均由 review_consumed 重算
  approved_by TEXT,
  rollback_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS review_memory_candidates( -- v2/P1-2：记忆候选专属表；白天召回不读它；批准前不进 facts
  id TEXT PRIMARY KEY,                             -- 'mc-'||sha1(op|repo|subject|predicate|value|source_msg)前 12 位
  run_id TEXT NOT NULL, group_id TEXT NOT NULL,
  op TEXT NOT NULL,                                -- ADD|UPDATE|DELETE
  repo TEXT NOT NULL, subject TEXT NOT NULL, predicate TEXT NOT NULL, value TEXT NOT NULL,
  target_fact_id TEXT,                             -- UPDATE/DELETE 指向的活跃 fact
  target_version TEXT,                             -- 生成时目标 fact 的 valid_from；批准时不一致即冲突
  source_msg_id TEXT NOT NULL, evidence_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',        -- candidate|approved|applied|rejected|blocked|conflict|superseded
  reviewed_by TEXT, reviewed_at INTEGER, applied_fact_id TEXT, note TEXT,
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS review_memory_candidates_status ON review_memory_candidates(group_id, status);
CREATE TABLE IF NOT EXISTS promises(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, outbox_id TEXT NOT NULL, quote TEXT NOT NULL,
  what TEXT NOT NULL, due_at INTEGER, recurring TEXT,  -- 'daily 08:00' 等；无则 NULL
  status TEXT NOT NULL DEFAULT 'open',             -- open|kept|broken|cannot|expired
  check_note TEXT, created_at INTEGER NOT NULL, checked_at INTEGER);
CREATE TABLE IF NOT EXISTS review_probes(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,         -- golden|capability
  name TEXT NOT NULL, passed INTEGER NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL);
