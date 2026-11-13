import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, setup, seed, tick, night } from './review-worker-fixture.mjs';

const request = (e, path, token = 'test-admin') => api.default.fetch(new Request('https://review.test' + path, {
  headers: { Authorization: 'Bearer ' + token },
}), e);

test('health reports effective mode and pause switch without exposing configuration secrets or writing', async t => {
  const { e, db } = setup('propose'); t.after(() => db.close());
  e.ADMIN_TOKEN = 'test-admin';
  let health = await (await request(e, '/review/health')).json();
  assert.equal(health.mode, 'propose');
  assert.equal(health.off, false);
  delete e.REVIEW_MODE;
  assert.equal((await (await request(e, '/review/health')).json()).mode, 'shadow');
  db.exec("INSERT INTO settings VALUES('review:mode','full'),('off:review','1'),('api_token','private-setting')");
  health = await (await request(e, '/review/health')).json();
  assert.equal(health.mode, 'full');
  assert.equal(health.off, true);
  db.exec("UPDATE settings SET value='0' WHERE key='off:review'");
  assert.equal((await (await request(e, '/review/health')).json()).off, false);
  assert.deepEqual(Object.keys(health).sort(), ['last_run', 'migration', 'mode', 'off', 'ok', 'release']);
  assert.doesNotMatch(JSON.stringify(health), /sk-fake|test-admin|private-setting|token|key/i);
  assert.equal((await request(e, '/review/health', 'bad')).status, 401);
  assert.ok(e.DB.calls.every(sql => /^\s*SELECT/i.test(sql)));
});

test('digest returns dated memory candidates, verbatim evidence and conflict versions on both routes without writes', async t => {
  const { e, db } = setup(); t.after(() => db.close());
  seed(db); await tick(e); e.ADMIN_TOKEN = 'test-admin';
  const run = db.prepare('SELECT id,date FROM review_runs').get();
  const evidence = [{ source: 'message', id: 'm0', quote: '请你以后回复最多200字', origin: 'direct' }];
  const add = db.prepare(`INSERT INTO review_memory_candidates
    (id,run_id,group_id,op,repo,subject,predicate,value,status,evidence_json,target_version,source_msg_id,created_at,note)
    VALUES(?,?,'g',?,'OmnixSI/TeamAgent','成员','回复偏好','200字',?,?,?,'m0',?,'private-note sk-fakeHIDDEN123456')`);
  add.run('mc-new', run.id, 'ADD', 'candidate', JSON.stringify(evidence), null, night + 1);
  add.run('mc-conflict', run.id, 'UPDATE', 'conflict', JSON.stringify(evidence), '2026-11-12T00:00:00Z', night + 2);
  db.prepare('INSERT INTO review_runs(id,date,group_id,mode,window_start,window_end,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('old-run', '2026-11-10', 'g', 'shadow', '2026-11-09T00:00:00Z', '2026-11-10T00:00:00Z', night - 4 * 86400000);
  add.run('mc-old', 'old-run', 'DELETE', 'rejected', JSON.stringify(evidence), 'old-version', night - 4 * 86400000);
  const start = e.DB.calls.length;
  for (const suffix of ['?days=1', '?date=' + run.date]) {
    const response = await request(e, '/review/digest' + suffix);
    assert.equal(response.status, 200);
    const body = await response.json();
    const candidates = suffix.includes('days') ? body.days[0].memory_candidates : body.memory_candidates;
    assert.ok(Array.isArray(candidates));
    assert.deepEqual(candidates.map(c => c.id), ['mc-new', 'mc-conflict']);
    assert.deepEqual(candidates[0], {
      id: 'mc-new', op: 'ADD', repo: 'OmnixSI/TeamAgent', subject: '成员', predicate: '回复偏好', value: '200字',
      state: 'candidate', status: 'candidate', evidence, target_version: null, created_at: night + 1,
    });
    assert.equal(candidates[1].state, 'conflict');
    assert.equal(candidates[1].target_version, '2026-11-12T00:00:00Z');
    assert.deepEqual(candidates[1].evidence, evidence);
    if (!suffix.includes('days')) assert.deepEqual(body.questions.memory.candidates, candidates);
    assert.doesNotMatch(JSON.stringify(body), /private-note|sk-fake|evidence_json|token|api_key/i);
  }
  const days = (await (await request(e, '/review/digest?days=7')).json()).days;
  assert.deepEqual(days.map(d => [d.date, d.memory_candidates.map(c => c.id)]), [
    [run.date, ['mc-new', 'mc-conflict']], ['2026-11-10', ['mc-old']],
  ]);
  assert.equal((await request(e, '/review/digest?days=7', 'bad')).status, 401);
  assert.ok(e.DB.calls.slice(start).every(sql => /^\s*SELECT/i.test(sql)));
});

test('empty digest provides empty candidate arrays', async t => {
  const { e, db } = setup(); t.after(() => db.close()); e.ADMIN_TOKEN = 'test-admin';
  const day = await (await request(e, '/review/digest?date=2026-11-14')).json();
  assert.deepEqual(day.memory_candidates, []);
  assert.deepEqual(day.questions.memory.candidates, []);
});
