-- Preserve the plan state of tasks created before the standalone repository migration.
INSERT OR IGNORE INTO task_plans(task_id,job_id,state,draft,updated_at)
SELECT json_extract(payload,'$.task'),id,
       CASE status WHEN 'done' THEN 'ready' WHEN 'failed' THEN 'failed' ELSE 'pending' END,
       '',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM jobs
WHERE kind='plan' AND json_valid(payload) AND json_extract(payload,'$.task') IS NOT NULL
ORDER BY created_at DESC;
