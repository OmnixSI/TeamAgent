// D0：把旧 schedules 表原子重建为 v2（放宽 kind/status 的 CHECK）。
// 必须一次 execute 提交整批：D1 对同一批次的语句原子执行（本地 wrangler 4.159.0 已实测，
// 中途失败 CREATE TABLE 也会回滚，见 .agent/releases/D/notes/D0.md 实验 B）。
const REBUILD = `CREATE TABLE schedules_v2(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, owner TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('digest_daily','digest_weekly','reminder','mute','agent_task')),
  tz TEXT NOT NULL DEFAULT 'Australia/Sydney', spec TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','cancelled','paused')),
  next_run_at INTEGER, last_run_at INTEGER, fail_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, source_msg_id TEXT, created_at INTEGER NOT NULL);
INSERT INTO schedules_v2(id,group_id,owner,kind,tz,spec,status,next_run_at,last_run_at,fail_count,last_error,source_msg_id,created_at)
  SELECT id,group_id,owner,kind,tz,spec,status,next_run_at,last_run_at,fail_count,last_error,source_msg_id,created_at FROM schedules;
DROP TABLE schedules;
ALTER TABLE schedules_v2 RENAME TO schedules;
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status,next_run_at);
CREATE INDEX IF NOT EXISTS schedules_group ON schedules(group_id,status);`;

/** 幂等：sqlite_master 里的建表语句已含 agent_task 就什么都不做。返回是否真的重建了。 */
export function ensureSchedulesV2(execute) {
  const rows = execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='schedules'").flatMap(q => q.results || []);
  if (!rows.length) return false;
  if (String(rows[0].sql || "").includes("agent_task")) return false;
  execute(REBUILD);
  return true;
}
