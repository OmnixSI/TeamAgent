-- F8-2 生图审计：每次 generate_image 调用一行，成功/被拒/失败/限额都留痕。
-- prompt 只存截断 500 字，避免把完整提示词和可能的隐私写进审计表。
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
-- 同一回合只允许一条还在进行（pending）或已排队的记录：模型重复调用不会重复花钱。
CREATE UNIQUE INDEX IF NOT EXISTS image_gen_log_turn_live ON image_gen_log(group_id, turn_id) WHERE status IN ('pending', 'ok');
