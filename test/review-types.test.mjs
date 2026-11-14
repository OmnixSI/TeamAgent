import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, rmSync} from 'node:fs';
import {build} from 'esbuild';

// Review modules are TS with extensionless imports, so bundle them like support.mjs does.
const OUT = '.wrangler/test-review-' + process.pid;
await build({
  entryPoints: {types: 'src/review/types.ts', catalog: 'src/review/catalog.ts',
    constants: 'src/review/constants.ts', rhythm: 'src/rhythm.ts'},
  bundle: true, format: 'esm', platform: 'neutral', outdir: OUT, logLevel: 'silent',
});
const types = await import(`../${OUT}/types.js`);
const catalog = await import(`../${OUT}/catalog.js`);
const constants = await import(`../${OUT}/constants.js`);
const rhythm = await import(`../${OUT}/rhythm.js`);
after(() => rmSync(OUT, {recursive: true, force: true}));

const migration = () => readFileSync(new URL('../migrations/0008_review.sql', import.meta.url), 'utf8');
const schema = () => readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const tableNames = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
const indexNames = db => db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);

// design.md §迁移 0008：只加这 10 张表，不改旧表。
const REVIEW_TABLES = ['turn_tools', 'review_runs', 'review_snapshots', 'review_traces', 'review_findings',
  'review_rejects', 'capability_gaps', 'behavior_rules', 'promises', 'review_probes'];

test('0008 applies twice on an empty database', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration());
    db.exec(migration());
    const names = tableNames(db);
    for (const name of REVIEW_TABLES) assert.ok(names.includes(name), `missing table ${name}`);
    const indexes = indexNames(db);
    for (const index of ['turn_tools_turn', 'review_traces_run', 'capability_gaps_cap'])
      assert.ok(indexes.includes(index), `missing index ${index}`);
  } finally { db.close(); }
});

test('0008 applies twice on the existing schema without touching old tables', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(schema());
    const before = tableNames(db).sort();
    db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run('probe', 'keep');
    db.exec(migration());
    db.exec(migration());
    const names = tableNames(db);
    for (const name of before) assert.ok(names.includes(name), `old table dropped: ${name}`);
    for (const name of REVIEW_TABLES) assert.ok(names.includes(name), `missing table ${name}`);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='probe'").get().value, 'keep');
  } finally { db.close(); }
});

test('review_findings keeps one finding per trace and failure type', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration());
    const insert = db.prepare(`INSERT INTO review_findings(id,run_id,trace_id,failure_type,severity,fix_layer,
      dimensions,evidence_json,what_happened,expected,root_cause,next_attempt_plan,confidence,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const row = ['r', 't', 'reasoning.output.format', 'p2', 'prompt', '{}', '[]', 'a', 'b', 'c', 'd', 0.5, 1];
    insert.run('f1', ...row);
    assert.throws(() => insert.run('f2', ...row), /UNIQUE|constraint/i);
  } finally { db.close(); }
});

test('enums have no duplicate values', () => {
  for (const [name, values] of Object.entries({
    FAILURE_TYPES: types.FAILURE_TYPES, GAP_TYPES: types.GAP_TYPES, FIX_LAYERS: types.FIX_LAYERS,
    SEVERITIES: types.SEVERITIES, DIMENSIONS: types.DIMENSIONS, VERDICT: types.VERDICT,
    TOOL_ERROR_KINDS: types.TOOL_ERROR_KINDS, CAPABILITIES: types.CAPABILITIES,
  })) {
    assert.equal(new Set(values).size, values.length, `${name} has duplicates`);
    assert.ok(values.length > 0, `${name} is empty`);
  }
  const signals = Object.keys(types.SIGNALS);
  assert.deepEqual(signals, ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11']);
});

test('tools catalog marks every repo_* tool readonly and only write tools writable', () => {
  const tools = catalog.TOOLS_CATALOG;
  assert.equal(new Set(tools.map(t => t.name)).size, tools.length, 'duplicate tool names');
  for (const tool of tools.filter(t => t.name.startsWith('repo_')))
    assert.equal(tool.readonly, true, `${tool.name} must be readonly`);
  assert.deepEqual(tools.map(t => t.name).filter(n => /^repo_/.test(n)).sort(),
    ['repo_changes', 'repo_commit', 'repo_file']);
  assert.deepEqual(tools.filter(t => !t.readonly).map(t => t.name).sort(),
    ['create_file_task', 'prepare_project_task', 'remember_correction']);
  const allowed = new Set(['runner', 'github_token', 'switch']);
  for (const tool of tools) {
    assert.ok(Array.isArray(tool.needs), `${tool.name} needs must be an array`);
    for (const need of tool.needs) assert.ok(allowed.has(need), `${tool.name} has bad need ${need}`);
    assert.equal(new Set(tool.needs).size, tool.needs.length, `${tool.name} repeats a need`);
  }
  assert.deepEqual(tools.find(t => t.name === 'repo_changes').needs.sort(), ['github_token', 'switch']);
});

test('capability needs and switch keys stay inside the real switch list', () => {
  const allowed = new Set(['runner', 'github_token', 'switch']);
  for (const capability of types.CAPABILITIES) {
    const needs = catalog.capabilityNeeds(capability);
    assert.ok(Array.isArray(needs), `${capability} needs must be an array`);
    for (const need of needs) assert.ok(allowed.has(need), `${capability} has bad need ${need}`);
  }
  assert.deepEqual(catalog.capabilityNeeds('repo_visibility').sort(), ['github_token', 'switch']);
  assert.deepEqual(catalog.capabilityNeeds('other:anything'), []);
  assert.deepEqual(catalog.switchKeysFor('repo_read'), ['off:repo_tools']);
  assert.deepEqual(catalog.switchKeysFor('other:anything'), []);
  for (const capability of types.CAPABILITIES)
    for (const key of catalog.switchKeysFor(capability))
      assert.ok(rhythm.SWITCH_KEYS.includes(key), `${capability} uses unknown switch ${key}`);
});

test('signal defaults and deny words match the design lists', () => {
  const cfg = constants.SIGNAL_DEFAULTS;
  for (let i = 1; i <= 10; i++) assert.ok(cfg[`s${i}`], `missing s${i}`);
  assert.equal(cfg.s1.no_outbox_minutes, 15);
  assert.equal(cfg.s3.window_messages, 3);
  assert.equal(cfg.s5.model_ms, 60000);
  assert.equal(cfg.s7.window_minutes, 3);
  assert.equal(cfg.s7.min_messages, 4);
  assert.equal(cfg.s9.lookback_minutes, 15);
  assert.deepEqual(cfg.s9.kinds, ['proactive', 'research']);
  assert.equal(cfg.s10.window_minutes, 30);
  assert.equal(cfg.s10.jaccard, 0.8);
  assert.deepEqual(cfg.s2.words, ['做不了', '不知道', '无法', '拿不到', '看不到', '没拿到', '读不了', '不能', '输入已保留', '暂时']);
  assert.deepEqual(cfg.s3.words, ['不对', '错了', '别瞎说', '怎么又', '人呢', '怎么不回', '拉了', '服', '没跟你说', '收敛']);
  assert.deepEqual(cfg.s6.words, ['明天', '每天', '每周', '几点', '以后', '稍后', '回头', '等…再', '我会']);
  assert.deepEqual(cfg.s8.words, ['我能', '可以帮你', '支持', '能力', '上线了']);
  for (const key of Object.keys(types.SIGNALS))
    assert.ok(cfg.priority[key] >= 1 && cfg.priority[key] <= 3, `${key} has no priority`);
  assert.deepEqual(constants.DENY_WORDS,
    ['权限', '授权', 'token', '密钥', '开关', '部署', '上线', '关闭', '删除', '管理员']);
});

test('v2 enum snapshots, CATALOG_VERSION and migrate.mjs list include 0008', () => {
  assert.deepEqual([...types.ORIGINS], ['direct','quoted','forwarded','card','attachment_text','image_text','bot']);
  assert.deepEqual([...types.RULE_KINDS], ['reply_max_chars','burst_max','mention_only_window','language','format_pref','free','avoid_phrase','address_as']);
  assert.deepEqual([...types.PROVIDERS], ['deepseek','workers-ai','openai','codex-offline']);
  assert.deepEqual([...types.AGREEMENT], ['agree','disagree','single','pending']);
  assert.deepEqual([...types.FINDING_STATUS], ['open','disputed','accepted','rejected','fixed','wontfix','regression']);
  assert.deepEqual([...types.MEMORY_CANDIDATE_STATUS], ['candidate','approved','applied','rejected','blocked','conflict','superseded']);
  assert.equal(catalog.CATALOG_VERSION, 'cat-v1');
  assert.match(readFileSync(new URL('../scripts/migrate.mjs', import.meta.url), 'utf8'), /migrations\/0008_review\.sql/);
});
