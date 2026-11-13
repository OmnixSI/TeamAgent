import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ensureVideoWaitAttempts} from '../scripts/migrate-video-waits.mjs';

for (const legacy of [true, false]) test(`video attempt migration preserves rows and can replay, legacy=${legacy}`, () => {
  const db = new DatabaseSync(':memory:');
  try {
    let schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    if (legacy) schema = schema.replace(',attempts INTEGER NOT NULL DEFAULT 0,phase', ',phase');
    db.exec(schema);
    assert.equal(db.prepare('PRAGMA table_info(video_waits)').all().some(c=>c.name==='attempts'),!legacy);
    db.prepare('INSERT INTO video_waits(id,group_id,ref,latest_id,batch_ids,mentioned,due_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run('w','g','abcd','m','["m"]',1,100,1);
    const execute = sql => {
      const statement = db.prepare(sql);
      return [{success: true, results: statement.columns().length ? statement.all() : (statement.run(), [])}];
    };
    ensureVideoWaitAttempts(execute);
    db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    db.prepare("UPDATE video_waits SET attempts=2 WHERE id='w'").run();
    ensureVideoWaitAttempts(execute);
    const row = db.prepare("SELECT * FROM video_waits WHERE id='w'").get();
    assert.equal(row.attempts, 2);
    assert.equal(row.latest_id, 'm');
    assert.equal(row.batch_ids, '["m"]');
  } finally { db.close(); }
});
