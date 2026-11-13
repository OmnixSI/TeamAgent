CREATE TABLE IF NOT EXISTS passive_claims(msg_id TEXT PRIMARY KEY,group_id TEXT NOT NULL,source_ts INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS passive_claims_g ON passive_claims(group_id,source_ts);
CREATE TABLE IF NOT EXISTS outbox_send(id TEXT PRIMARY KEY,passive_msg_id TEXT,msg_seq INTEGER,not_before INTEGER NOT NULL DEFAULT 0,tries INTEGER NOT NULL DEFAULT 0,reason TEXT,lock_tok TEXT,claimed_at INTEGER);
CREATE TABLE IF NOT EXISTS send_lanes(group_id TEXT PRIMARY KEY,holder TEXT NOT NULL,lease_until INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS message_refs_g ON message_refs(group_id,created_at);
