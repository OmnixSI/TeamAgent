/** Upgrades an already-created P4b table without resetting wait state or counters. */
export function ensureVideoWaitAttempts(execute) {
  const columns = execute('PRAGMA table_info(video_waits)').flatMap(query => query.results || []);
  if (!columns.some(column => column.name === 'attempts'))
    execute('ALTER TABLE video_waits ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
}
