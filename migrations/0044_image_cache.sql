-- F8-V2：收到图片消息即落本地缓存（#222 原图链接过期后仍能看图）。
-- data 为空的行是失败/超限记录：只留 skipped_reason / error_kind / error_stage，看图时如实说明收到时没能保存。
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
