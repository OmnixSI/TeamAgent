import {test} from 'node:test';
import assert from 'node:assert/strict';
import {env} from './support.mjs';

test('B0 batch preserves SELECT and INSERT RETURNING result rows; statements are counted', async () => {
  const e = env(), before = e.DB.executed;
  const result = await e.DB.batch([
    e.DB.prepare('SELECT ? AS value').bind('select'),
    e.DB.prepare('INSERT INTO settings VALUES(?,?) RETURNING key,value').bind('batch-row', 'insert'),
  ]);
  assert.deepEqual(result[0].results.map(r => r.value), ['select']);
  assert.deepEqual(result[1].results.map(r => [r.key, r.value]), [['batch-row', 'insert']]);
  assert.equal(e.DB.executed - before, 2);
  await e.DB.prepare('SELECT key FROM settings').all();
  await e.DB.prepare('SELECT key FROM settings WHERE key=?').bind('batch-row').first();
  await e.DB.prepare('DELETE FROM settings WHERE key=?').bind('batch-row').run();
  assert.equal(e.DB.executed - before, 5);
});
