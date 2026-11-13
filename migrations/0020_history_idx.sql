-- F7-2: lookups are always scoped by group and time; messages_group_time already exists in schema.sql.
CREATE INDEX IF NOT EXISTS messages_group_time ON messages(group_id, ts);
