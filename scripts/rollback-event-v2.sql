UPDATE outbox SET status='pending' WHERE status='held' AND instr(id,'~')>0 AND substr(id,1,instr(id,'~')-1) IN (SELECT id FROM outbox WHERE status='pending');
UPDATE outbox SET status=CASE WHEN status='sending' THEN 'unknown' ELSE 'skipped' END WHERE status IN ('retry','held') OR (status='sending' AND id IN (SELECT id FROM outbox_send WHERE claimed_at IS NOT NULL));
