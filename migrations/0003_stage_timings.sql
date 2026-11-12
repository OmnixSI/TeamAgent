CREATE TABLE IF NOT EXISTS stage_timings(turn_id TEXT NOT NULL, stage TEXT NOT NULL, at INTEGER NOT NULL, extra TEXT);
CREATE INDEX IF NOT EXISTS stage_timings_turn ON stage_timings(turn_id);
