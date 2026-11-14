CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,role TEXT NOT NULL DEFAULT 'member',revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY,name TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,sender TEXT NOT NULL,body TEXT NOT NULL,ts TEXT NOT NULL,mentioned INTEGER NOT NULL DEFAULT 0,processed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,repo TEXT NOT NULL,title TEXT NOT NULL,detail TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'proposal',version INTEGER NOT NULL DEFAULT 1,assignee TEXT,result TEXT NOT NULL DEFAULT '',source_id TEXT,lease TEXT,lease_until INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status,created_at);
CREATE TABLE IF NOT EXISTS facts(id TEXT PRIMARY KEY,repo TEXT NOT NULL,subject TEXT NOT NULL,predicate TEXT NOT NULL,value TEXT NOT NULL,evidence TEXT NOT NULL,source_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'proposal',valid_from TEXT NOT NULL,valid_to TEXT);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS turn_tools(id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, group_id TEXT, name TEXT NOT NULL, args TEXT NOT NULL DEFAULT '{}', ok INTEGER NOT NULL, error_kind TEXT, ms INTEGER NOT NULL, offered INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS turn_tools_turn ON turn_tools(turn_id);
CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,msg_id TEXT,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS repo_cache(repo TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_tickets(code TEXT PRIMARY KEY,secret_hash TEXT NOT NULL,expires INTEGER NOT NULL,member_id TEXT,name TEXT,used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS message_meta(id TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS media_notes(id TEXT PRIMARY KEY,body TEXT NOT NULL,created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS dreams(id TEXT PRIMARY KEY,date TEXT NOT NULL,body TEXT NOT NULL,sources TEXT NOT NULL,created_at TEXT NOT NULL,message_count INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS expressions(phrase TEXT PRIMARY KEY,meaning TEXT NOT NULL,scene TEXT NOT NULL,evidence TEXT NOT NULL,source_ids TEXT NOT NULL,frequency INTEGER NOT NULL,speakers INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 2,updated_at TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS messages_group_time ON messages(group_id,ts);
CREATE INDEX IF NOT EXISTS jobs_status_kind ON jobs(status,kind,created_at);
CREATE INDEX IF NOT EXISTS facts_scope ON facts(repo,valid_to,valid_from);
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
CREATE INDEX IF NOT EXISTS outbox_status_time ON outbox(status,created_at);
CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY,kind TEXT NOT NULL,entity TEXT NOT NULL,actor TEXT NOT NULL,summary TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS activity_entity ON activity(entity,created_at);
CREATE TABLE IF NOT EXISTS model_runs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,effort TEXT NOT NULL,status TEXT NOT NULL,duration_ms INTEGER NOT NULL,input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS task_plans(task_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',draft TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,message_id TEXT NOT NULL,status TEXT NOT NULL,files TEXT NOT NULL DEFAULT '[]',sent_count INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS delivery_retries(delivery_id TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,needs_attention INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS discoveries(id TEXT PRIMARY KEY,repo TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,urls TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_blocks(source_id TEXT NOT NULL,subject TEXT NOT NULL,predicate TEXT NOT NULL,PRIMARY KEY(source_id,subject,predicate));
CREATE TABLE IF NOT EXISTS health_samples(at INTEGER PRIMARY KEY,gateway_ok INTEGER NOT NULL,runner_ok INTEGER NOT NULL,pending INTEGER NOT NULL,failed INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS member_sessions(token_hash TEXT PRIMARY KEY,member_id TEXT NOT NULL,created_at INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS member_sessions_member ON member_sessions(member_id);

CREATE TABLE IF NOT EXISTS outbox_attempts(id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,http_status INTEGER,code TEXT);

CREATE INDEX IF NOT EXISTS activity_time ON activity(created_at);
CREATE INDEX IF NOT EXISTS model_runs_time ON model_runs(created_at);
CREATE TABLE IF NOT EXISTS model_usage(hour INTEGER NOT NULL,kind TEXT NOT NULL,effort TEXT NOT NULL,status TEXT NOT NULL,n INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,duration_ms INTEGER NOT NULL,PRIMARY KEY(hour,kind,effort,status));
CREATE TABLE IF NOT EXISTS member_passwords(member_id TEXT PRIMARY KEY,login_name TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_tokens(id TEXT PRIMARY KEY,member_id TEXT NOT NULL,label TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL,expires INTEGER NOT NULL,last_used INTEGER,revoked INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ai_tokens_member ON ai_tokens(member_id,revoked);
CREATE TABLE IF NOT EXISTS task_claims(task_id TEXT NOT NULL,version INTEGER NOT NULL,member_id TEXT NOT NULL,member_name TEXT NOT NULL,actor_type TEXT NOT NULL,claimed_at TEXT NOT NULL,PRIMARY KEY(task_id,version));
CREATE TABLE IF NOT EXISTS ci_incidents(id TEXT PRIMARY KEY,scope TEXT NOT NULL,cause TEXT NOT NULL,repo TEXT NOT NULL,check_name TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'open',cycle INTEGER NOT NULL DEFAULT 1,notified_cycle INTEGER NOT NULL DEFAULT 0,check_json TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ci_observations(repo TEXT NOT NULL,check_name TEXT NOT NULL,incident_id TEXT,conclusion TEXT NOT NULL,check_id TEXT,head_sha TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(repo,check_name));
CREATE INDEX IF NOT EXISTS ci_observation_incident ON ci_observations(incident_id,conclusion);

CREATE TABLE IF NOT EXISTS message_refs(ref_idx TEXT PRIMARY KEY,kind TEXT NOT NULL,target_id TEXT NOT NULL,group_id TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS member_names(member_id TEXT PRIMARY KEY,name TEXT NOT NULL,source TEXT NOT NULL,updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS video_waits(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,ref TEXT NOT NULL,latest_id TEXT NOT NULL,batch_ids TEXT NOT NULL,mentioned INTEGER NOT NULL,due_at INTEGER NOT NULL,ready INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'waiting',lease_until INTEGER,created_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,phase TEXT NOT NULL DEFAULT 'light');
CREATE INDEX IF NOT EXISTS video_waits_due ON video_waits(status,due_at);
CREATE TABLE IF NOT EXISTS image_notes(sha TEXT PRIMARY KEY,desc TEXT NOT NULL,tags TEXT NOT NULL,sticker_like INTEGER NOT NULL,text TEXT,created_at INTEGER NOT NULL,provider TEXT NOT NULL DEFAULT 'workers_ai',model TEXT NOT NULL DEFAULT '@cf/meta/llama-3.2-11b-vision-instruct');
CREATE TABLE IF NOT EXISTS message_images(message_id TEXT NOT NULL,idx INTEGER NOT NULL,sha TEXT NOT NULL,PRIMARY KEY(message_id,idx));

CREATE TABLE IF NOT EXISTS chat_decisions(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,latest_id TEXT NOT NULL,batch_ids TEXT NOT NULL,mentioned INTEGER NOT NULL,forced INTEGER NOT NULL,waited INTEGER NOT NULL,gate TEXT NOT NULL,action TEXT NOT NULL,spoken_kind TEXT,target_id TEXT,wait_seconds INTEGER,reason TEXT,outbox_id TEXT,policy TEXT NOT NULL DEFAULT 'live',model_ms INTEGER,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS chat_decisions_group ON chat_decisions(group_id,created_at);
CREATE TABLE IF NOT EXISTS outbox_meta(id TEXT PRIMARY KEY,json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS stickers(sha TEXT PRIMARY KEY,mime TEXT NOT NULL,bytes INTEGER NOT NULL,data BLOB NOT NULL,desc TEXT,tags TEXT,state INTEGER NOT NULL DEFAULT 0,senders TEXT NOT NULL DEFAULT '[]',seen INTEGER NOT NULL DEFAULT 1,source_message TEXT,tagged_at INTEGER,used_at INTEGER,uses INTEGER NOT NULL DEFAULT 0,file_info TEXT,file_info_expires INTEGER,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS stickers_state ON stickers(state,used_at);
CREATE TABLE IF NOT EXISTS stage_timings(turn_id TEXT NOT NULL, stage TEXT NOT NULL, at INTEGER NOT NULL, extra TEXT);
CREATE INDEX IF NOT EXISTS stage_timings_turn ON stage_timings(turn_id);

CREATE TABLE IF NOT EXISTS repo_commits(
  repo TEXT NOT NULL, sha TEXT NOT NULL, at INTEGER NOT NULL, author TEXT NOT NULL,
  subject TEXT NOT NULL, body TEXT, files TEXT NOT NULL, patch TEXT, truncated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(repo, sha));
CREATE INDEX IF NOT EXISTS repo_commits_at ON repo_commits(repo, at DESC);
CREATE TABLE IF NOT EXISTS repo_state(
  repo TEXT PRIMARY KEY, json TEXT NOT NULL, fingerprint TEXT NOT NULL,
  updated_at INTEGER NOT NULL, checked_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS summaries(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, from_ts TEXT NOT NULL, to_ts TEXT NOT NULL,
  last_rowid INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS summaries_group_last ON summaries(group_id,last_rowid);
CREATE INDEX IF NOT EXISTS summaries_group_time ON summaries(group_id,created_at);
CREATE TABLE IF NOT EXISTS tool_calls(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL, turn_id TEXT NOT NULL, name TEXT NOT NULL,
  args_hash TEXT NOT NULL, status TEXT NOT NULL, error_kind TEXT,
  latency_ms INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tool_calls_group_turn ON tool_calls(group_id,turn_id,created_at);
CREATE TABLE IF NOT EXISTS profiles(
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  source_ids TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(group_id, user_id));
CREATE INDEX IF NOT EXISTS profiles_group ON profiles(group_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS kb_docs(
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS kb_docs_group ON kb_docs(group_id, created_at);
CREATE TABLE IF NOT EXISTS kb_chunks(
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS kb_chunks_group_doc ON kb_chunks(group_id, doc_id, idx);
CREATE INDEX IF NOT EXISTS kb_chunks_doc ON kb_chunks(doc_id);
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
  text,
  title,
  chunk_id UNINDEXED,
  doc_id UNINDEXED,
  group_id UNINDEXED,
  tokenize='trigram');
CREATE TABLE IF NOT EXISTS schedules(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, owner TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('digest_daily','digest_weekly','reminder','mute')),
  tz TEXT NOT NULL DEFAULT 'Australia/Sydney', spec TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','cancelled')),
  next_run_at INTEGER, last_run_at INTEGER, fail_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, source_msg_id TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status,next_run_at);
CREATE INDEX IF NOT EXISTS schedules_group ON schedules(group_id,status);
CREATE TABLE IF NOT EXISTS schedule_runs(
  id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, due_at INTEGER NOT NULL,
  started_at INTEGER, finished_at INTEGER, status TEXT NOT NULL DEFAULT 'pending',
  outbox_id TEXT, error TEXT, UNIQUE(schedule_id,due_at));
CREATE INDEX IF NOT EXISTS schedule_runs_due ON schedule_runs(schedule_id,due_at);

CREATE TABLE IF NOT EXISTS openai_usage(
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  group_id TEXT,
  sender_id TEXT,
  status TEXT NOT NULL,
  error_kind TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  est_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS openai_usage_created ON openai_usage(created_at);
CREATE INDEX IF NOT EXISTS openai_usage_purpose ON openai_usage(purpose, created_at);
CREATE TABLE IF NOT EXISTS quota_reservations(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS quota_reservations_bucket ON quota_reservations(kind, key, created_at);

CREATE TABLE IF NOT EXISTS ds_usage(
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  group_id TEXT,
  sender_id TEXT,
  status TEXT NOT NULL,
  error_kind TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  units INTEGER NOT NULL DEFAULT 0,
  est_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ds_usage_created ON ds_usage(created_at);
CREATE INDEX IF NOT EXISTS ds_usage_purpose ON ds_usage(purpose, created_at);
CREATE INDEX IF NOT EXISTS ds_usage_group ON ds_usage(group_id, created_at);
CREATE TABLE IF NOT EXISTS generated_images(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,sender_id TEXT NOT NULL,prompt_hash TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,data BLOB NOT NULL,file_info TEXT,file_info_expires INTEGER,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS generated_images_expires ON generated_images(expires_at);
CREATE TABLE IF NOT EXISTS image_gen_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  size TEXT NOT NULL,
  quality TEXT,
  model TEXT,
  status TEXT NOT NULL,
  error_kind TEXT,
  bytes INTEGER,
  latency_ms INTEGER,
  est_cost_micro_usd INTEGER,
  outbox_id TEXT,
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS image_gen_log_group_turn ON image_gen_log(group_id, turn_id);
CREATE INDEX IF NOT EXISTS image_gen_log_group_time ON image_gen_log(group_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS image_gen_log_turn_live ON image_gen_log(group_id, turn_id) WHERE status IN ('pending', 'ok');
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
CREATE TABLE IF NOT EXISTS image_cache(
  sha TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  mime TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  data BLOB,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  source_msg TEXT,
  source_idx INTEGER,
  skipped_reason TEXT,
  error_kind TEXT,
  error_stage TEXT);
CREATE INDEX IF NOT EXISTS image_cache_expires ON image_cache(expires_at);
CREATE INDEX IF NOT EXISTS image_cache_group ON image_cache(group_id, created_at);

CREATE TABLE IF NOT EXISTS ds_balance_snapshots(
  scope TEXT NOT NULL,
  currency TEXT NOT NULL,
  total_balance TEXT NOT NULL,
  granted_balance TEXT NOT NULL,
  topped_up_balance TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(scope, currency));

-- 0080_learning：与 migrations/0080_learning.sql 同一段，改一处必须改两处
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
