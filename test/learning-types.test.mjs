// L0 冻结面：类型常量、learningId / reportOutboxId、0080 迁移幂等、schedules 配置校验。
// 任何一条改动都会让下游包（L1–L9）编译或行为漂移，改之前先改 design.md。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { validateTeamConfig } from '../config/validate.mjs';

const out = '.wrangler/test-learning-types-' + process.pid + '.mjs';
await build({ entryPoints: ['src/learning-types.ts'], bundle: true, format: 'esm', platform: 'browser', outfile: out });
const L = await import('../' + out);
const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const migrationSql = readFileSync(new URL('../migrations/0080_learning.sql', import.meta.url), 'utf8');
const settings = JSON.parse(readFileSync(new URL('../config/team.json', import.meta.url), 'utf8'));

test('learning enums, statuses and the report deny list are frozen', () => {
  assert.deepEqual([...L.LEARNING_KINDS], ['rule', 'schedule']);
  assert.deepEqual([...L.LEARNING_STATUS], ['proposed', 'asked', 'confirmed', 'applied', 'declined',
    'disputed', 'expired', 'covered', 'needs_human', 'failed']);
  assert.deepEqual([...L.NEW_RULE_KINDS], ['avoid_phrase', 'address_as']);
  assert.deepEqual([...L.REPORT_DENY], ['trace', 'judge', 'finding', 'p0', 'p1', 'p2', 'deepseek', 'openai',
    '模型', '判官', '影子', 'shadow', 'canary', '规则候选', 'd1', 'cron', 'worker', 'token', '阈值', '置信',
    '证据id', 'json']);
  // 晨报正文按小写比较，所以词表必须已经小写。
  for (const word of L.REPORT_DENY) assert.equal(word, word.toLowerCase(), word);
});

test('learningId hashes the four identity parts into one stable 15-char id', async () => {
  const parts = ['group-a', 'rule', 'avoid_phrase', '绝了'];
  const expected = 'ln-' + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12);
  const id = await L.learningId(...parts);
  assert.match(id, /^ln-[0-9a-f]{12}$/);
  assert.equal(id, expected);
  assert.equal(await L.learningId(...parts), id, 'same request keeps the same id across nights');
  for (const [at, value] of [[0, 'group-b'], [1, 'schedule'], [2, 'address_as'], [3, '绝']]) {
    const changed = [...parts];
    changed[at] = value;
    assert.notEqual(await L.learningId(...changed), id, `part ${at} must change the id`);
  }
});

test('reportOutboxId keeps one id per day until a second group needs a morning report', () => {
  assert.equal(L.reportOutboxId('2026-11-14', 'group-a', 0), 'reflection-report:2026-11-14');
  assert.equal(L.reportOutboxId('2026-11-14', 'group-a', 1), 'reflection-report:2026-11-14');
  assert.equal(L.reportOutboxId('2026-11-14', 'group-abcdef-9', 2), 'reflection-report:2026-11-14:group-ab');
  assert.equal(L.reportOutboxId('2026-11-14', 'short', 3), 'reflection-report:2026-11-14:short');
  assert.notEqual(L.reportOutboxId('2026-11-14', 'group-a', 2), L.reportOutboxId('2026-11-14', 'group-b', 2));
});

const COLUMNS = {
  review_learnings: ['id', 'group_id', 'kind', 'subkind', 'params', 'plain', 'requester', 'source_msg_id',
    'quote', 'run_id', 'agreement', 'status', 'ask_count', 'answered_by', 'answer_msg_id', 'applied_ref',
    'note', 'created_at', 'updated_at'],
  review_reports: ['id', 'group_id', 'date', 'run_id', 'mode', 'body', 'items', 'state', 'reason',
    'created_at', 'queued_at'],
  learning_acks: ['outbox_id', 'group_id', 'answer_msg_id', 'refs', 'undone_at', 'created_at'],
};

test('0080 creates the three learning tables with the frozen columns and replays twice', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migrationSql);
    db.exec(migrationSql);
    for (const [table, columns] of Object.entries(COLUMNS)) {
      assert.deepEqual(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name), columns, table);
    }
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='review_learnings'").all();
    assert.ok(indexes.some((row) => row.name === 'review_learnings_group'), 'group/status index');
  } finally { db.close(); }
});

test('0080 replays on a main-era database without touching existing rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // 施工前的 schema.sql（marker 之前的部分）就是 main 41db2b5 的库结构。
    const [mainSchema, appended] = schemaSql.split('-- 0080_learning');
    assert.ok(appended !== undefined, 'schema.sql must keep the 0080 marker');
    db.exec(mainSchema);
    const columnsBefore = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
    db.prepare('INSERT INTO messages(id,group_id,sender,body,ts) VALUES(?,?,?,?,?)').run('m1', 'g1', 'u1', 'hi', '2026-11-14T00:00:00Z');
    db.exec(migrationSql);
    db.exec(migrationSql);
    db.exec(mainSchema + '-- 0080_learning' + appended);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id='m1'").get().n, 1);
    assert.deepEqual(db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name), columnsBefore);
    for (const table of Object.keys(COLUMNS)) assert.equal(db.prepare(`PRAGMA table_info(${table})`).all().length, COLUMNS[table].length, table);
  } finally { db.close(); }
});

test('schema.sql carries the same learning tables, one report per group per day', () => {
  for (const table of Object.keys(COLUMNS)) assert.ok(schemaSql.includes(`CREATE TABLE IF NOT EXISTS ${table}(`), table);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(schemaSql);
    db.exec(schemaSql);
    const insert = db.prepare('INSERT INTO review_reports(id,group_id,date,run_id,mode,body,created_at) VALUES(?,?,?,?,?,?,?)');
    insert.run('o1', 'g1', '2026-11-14', 'r1', 'shadow', 'body', 1);
    assert.throws(() => insert.run('o2', 'g1', '2026-11-14', 'r1', 'shadow', 'body', 1), /UNIQUE/);
    insert.run('o3', 'g2', '2026-11-14', 'r1', 'shadow', 'body', 1);
    db.prepare("INSERT INTO review_learnings(id,group_id,kind,subkind,plain,requester,source_msg_id,quote,run_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run('ln-1', 'g1', 'rule', 'avoid_phrase', '别再说「绝了」', 'u1', 'm1', '别再用绝了', 'r1', 1, 1);
    assert.equal(db.prepare("SELECT status,agreement,ask_count FROM review_learnings WHERE id='ln-1'").get().status, 'proposed');
  } finally { db.close(); }
});

test('migrate.mjs applies 0080 after the main-era migrations', () => {
  const source = readFileSync(new URL('../scripts/migrate.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('"migrations/0080_learning.sql"'), '0080 must be in the migrate list');
  assert.ok(source.indexOf('0060_ds_usage.sql') < source.indexOf('0080_learning.sql'));
});

test('team config freezes the schedule limits and rejects unsafe values', () => {
  assert.deepEqual(settings.schedules, {
    max_active_per_group: 5,
    max_sends_per_group_day: 6,
    max_sends_day: 20,
    report_window: ['08:40', '10:00'],
  });
  assert.deepEqual(validateTeamConfig(settings), []);
  const patches = [
    [{ schedules: undefined }, 'schedules'],
    [{ schedules: null }, 'schedules'],
    [{ schedules: [] }, 'schedules'],
    [{ max_active_per_group: 0 }, 'schedules.max_active_per_group'],
    [{ max_active_per_group: '5' }, 'schedules.max_active_per_group'],
    [{ max_sends_per_group_day: 0 }, 'schedules.max_sends_per_group_day'],
    [{ max_sends_day: 0 }, 'schedules.max_sends_day'],
    [{ max_sends_day: 5 }, 'schedules.max_sends_day'],
    [{ report_window: ['10:00', '08:40'] }, 'schedules.report_window'],
    [{ report_window: ['8:40', '10:00'] }, 'schedules.report_window'],
    [{ report_window: ['08:40'] }, 'schedules.report_window'],
    [{ report_window: '08:40-10:00' }, 'schedules.report_window'],
  ];
  for (const [patch, key] of patches) {
    const bad = structuredClone(settings);
    bad.schedules = { ...bad.schedules, ...patch };
    if (patch.schedules === undefined) delete bad.schedules;
    if (patch.schedules !== undefined) bad.schedules = patch.schedules;
    assert.ok(validateTeamConfig(bad).includes(key), key + ' ← ' + JSON.stringify(patch));
  }
});

test('learning-confirm exposes the L6 interface and no auto applyConfirmed', async () => {
  const stubOut = '.wrangler/test-learning-confirm-' + process.pid + '.mjs';
  await build({ entryPoints: ['src/learning-confirm.ts'], bundle: true, format: 'esm', platform: 'browser', outfile: stubOut });
  const confirm = await import('../' + stubOut);
  assert.equal(typeof confirm.parseAnswer, 'function');
  assert.equal(typeof confirm.handleLearningReply, 'function');
  assert.equal(typeof confirm.applyLearning, 'function');
  assert.equal(confirm.applyConfirmed, undefined);
});
