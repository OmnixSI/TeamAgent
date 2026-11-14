-- D-emoji: local/test diagnostics for image recognition. The table is additive;
-- writes stay disabled unless VISION_EVENTS=1 (local replay), so deployment does
-- not add a per-image write.
CREATE TABLE IF NOT EXISTS vision_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  group_id TEXT,
  message_id TEXT,
  idx INTEGER,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  http INTEGER,
  elapsed_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS vision_events_message ON vision_events(message_id, idx, created_at);
CREATE INDEX IF NOT EXISTS vision_events_created ON vision_events(created_at);
